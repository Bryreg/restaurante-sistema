"""La ficha versiona y las versiones viejas se conservan (snapshot, regla
dura): "un ítem vendido contra la versión 1 sigue reportando el costo de la
versión 1 después de guardar la versión 2".

Acá no hay `order_items` (territorio de `backend-consumo`): la prueba de
punta a punta es que, para un `product_id` dado, la fila de `RecipeVersion`
número 1 y sus `RecipeLine` **siguen existiendo intactas** después de
guardar la versión 2 — que es exactamente lo que `OrderItem.recipe_version`
necesita poder resolver después. `expand_consumption` (que siempre usa la
ÚLTIMA versión, por diseño: es lo que vende hoy) confirma además que la
versión vigente cambió.
"""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.recipes import service
from app.recipes.hooks import expand_consumption
from app.recipes.models import RecipeLine, RecipeVersion
from app.recipes.schemas import ComponentLineIn, ProductRecipeIn


def test_saving_bumps_version_and_keeps_old_versions_and_lines(
    db: Session, org: Any, store: Any, admin_actor: Any, make_ingredient: Any, make_product: Any
) -> None:
    ing_a = make_ingredient("Insumo A")
    ing_b = make_ingredient("Insumo B")
    product = make_product("Plato versionado")

    v1 = service.put_product_recipe(
        db, actor=admin_actor, product_id=product.id,
        data=ProductRecipeIn(version=0, lines=[ComponentLineIn(ingredient_id=ing_a.id, qty="100", unit="g")]),
    )
    assert v1.version == 1

    plan_v1 = expand_consumption(db, store_id=store.id, product_id=product.id, qty=1, modifier_option_ids=[])
    assert plan_v1.recipe_version == 1
    assert plan_v1.lines[0].ingredient_id == ing_a.id

    v2 = service.put_product_recipe(
        db, actor=admin_actor, product_id=product.id,
        data=ProductRecipeIn(version=1, lines=[ComponentLineIn(ingredient_id=ing_b.id, qty="50", unit="g")]),
    )
    assert v2.version == 2

    # Lo que vende HOY usa la versión vigente (2).
    plan_v2 = expand_consumption(db, store_id=store.id, product_id=product.id, qty=1, modifier_option_ids=[])
    assert plan_v2.recipe_version == 2
    assert plan_v2.lines[0].ingredient_id == ing_b.id

    # La versión 1 sigue existiendo, intacta — es lo que resuelve
    # `OrderItem.recipe_version = 1` de un ítem vendido antes de guardar la v2.
    recipe_id = db.execute(
        select(RecipeVersion.recipe_id).where(RecipeVersion.version == 1)
    ).scalars().first()
    version_1_row = db.execute(
        select(RecipeVersion).where(RecipeVersion.recipe_id == recipe_id, RecipeVersion.version == 1)
    ).scalar_one()
    lines_v1 = list(
        db.execute(select(RecipeLine).where(RecipeLine.recipe_version_id == version_1_row.id)).scalars().all()
    )
    assert len(lines_v1) == 1
    assert lines_v1[0].ingredient_id == ing_a.id
    assert lines_v1[0].unit == "g"


def test_stale_version_is_rejected_with_409(
    db: Session, org: Any, admin_actor: Any, make_ingredient: Any, make_product: Any
) -> None:
    ing = make_ingredient("Insumo")
    product = make_product("Plato con carrera de edición")
    service.put_product_recipe(
        db, actor=admin_actor, product_id=product.id,
        data=ProductRecipeIn(version=0, lines=[ComponentLineIn(ingredient_id=ing.id, qty="10", unit="g")]),
    )
    # Alguien más ya guardó (recipe.current_version == 1); este PUT llega
    # todavía creyendo que la ficha está en la versión 0.
    with pytest.raises(AppError) as exc:
        service.put_product_recipe(
            db, actor=admin_actor, product_id=product.id,
            data=ProductRecipeIn(version=0, lines=[ComponentLineIn(ingredient_id=ing.id, qty="20", unit="g")]),
        )
    assert exc.value.code == "RECIPE_VERSION_STALE"
    assert exc.value.status == 409


def test_product_without_recipe_has_version_zero_and_no_cost(
    db: Session, org: Any, admin_actor: Any, make_product: Any
) -> None:
    from app.inventory.models import CostSource

    product = make_product("Plato sin ficha")
    out = service.get_product_recipe(db, actor=admin_actor, product_id=product.id)
    assert out.version == 0
    assert out.theoretical_cost is None
    assert out.cost_source == CostSource.NONE.value
    assert out.food_cost_pct is None
    assert out.lines == []
