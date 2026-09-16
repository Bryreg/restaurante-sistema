"""`expand_consumption` — el corazón del pedido. Rendimiento aplicado,
`recipe_effect` (`add`/`remove`/`replace`) de los modificadores, líneas del
mismo insumo fusionadas, `catalog.recipes` apagada -> plan vacío (nunca `0`,
nunca una excepción).
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.recipes import service
from app.recipes.hooks import expand_consumption
from app.recipes.schemas import ComponentLineIn, PreparationIn, ProductRecipeIn, RecipeEffectIn, RecipeEffectLineIn


def test_yield_is_applied_at_the_product_recipe_level(
    db: Session, org: Any, store: Any, admin_actor: Any, make_ingredient: Any, make_product: Any
) -> None:
    """Insumo al 85 % de rendimiento: una ficha que pide 400 g limpios
    descuenta más de 400 g (test numérico explícito, checklist)."""
    pechuga = make_ingredient("Pechuga (yield)", base_unit="g", yield_pct=85, official_cost_micros=10_000_000)
    product = make_product("Pechuga a la plancha (yield test)")
    service.put_product_recipe(
        db, actor=admin_actor, product_id=product.id,
        data=ProductRecipeIn(version=0, lines=[ComponentLineIn(ingredient_id=pechuga.id, qty="400", unit="g")]),
    )
    plan = expand_consumption(db, store_id=store.id, product_id=product.id, qty=1, modifier_option_ids=[])
    assert len(plan.lines) == 1
    assert plan.lines[0].qty_base == 470_589  # 400 / 0.85, redondeado hacia arriba, en milésimas de g
    assert plan.lines[0].qty_base > 400_000


def test_feature_disabled_returns_empty_plan_never_zero_never_exception(
    db: Session, org: Any, store: Any, admin_actor: Any, make_ingredient: Any, make_product: Any, set_feature: Any
) -> None:
    from app.inventory.models import CostSource

    ing = make_ingredient("Insumo (flag apagada)")
    product = make_product("Plato (flag apagada)")
    service.put_product_recipe(
        db, actor=admin_actor, product_id=product.id,
        data=ProductRecipeIn(version=0, lines=[ComponentLineIn(ingredient_id=ing.id, qty="10", unit="g")]),
    )
    set_feature("catalog.recipes", False)
    plan = expand_consumption(db, store_id=store.id, product_id=product.id, qty=1, modifier_option_ids=[])
    assert plan.recipe_version is None
    assert plan.unit_cost_micros is None
    assert plan.cost_source == CostSource.NONE
    assert plan.lines == []


def test_product_without_recipe_and_without_direct_ingredient_yields_empty_plan(
    db: Session, org: Any, store: Any, make_product: Any
) -> None:
    """Cobertura: la venta sigue (esto es lo que hace posible que siga), pero
    el plan queda vacío para que el llamador lo reporte."""
    product = make_product("Plato sin ficha (cobertura)")
    plan = expand_consumption(db, store_id=store.id, product_id=product.id, qty=1, modifier_option_ids=[])
    assert plan.recipe_version is None
    assert plan.lines == []


def test_same_ingredient_lines_are_merged(
    db: Session, org: Any, store: Any, admin_actor: Any, make_ingredient: Any, make_product: Any
) -> None:
    """El mismo insumo llega por dos caminos (directo en la ficha + dentro de
    una preparación explotada): el plan lo fusiona en UNA sola línea."""
    sal = make_ingredient("Sal (fusión)", base_unit="g", yield_pct=100, official_cost_micros=1_000_000)
    salsa = service.create_preparation(
        db, actor=admin_actor, store_id=store.id,
        data=PreparationIn(
            name="Salsa con sal (fusión)", mode="exploded", standard_yield_qty="1000", standard_yield_unit="g",
            lines=[ComponentLineIn(ingredient_id=sal.id, qty="50", unit="g")],
        ),
    )
    product = make_product("Plato con sal por dos caminos")
    service.put_product_recipe(
        db, actor=admin_actor, product_id=product.id,
        data=ProductRecipeIn(
            version=0,
            lines=[
                ComponentLineIn(ingredient_id=sal.id, qty="5", unit="g"),
                ComponentLineIn(preparation_id=salsa.id, qty="200", unit="g"),
            ],
        ),
    )
    plan = expand_consumption(db, store_id=store.id, product_id=product.id, qty=1, modifier_option_ids=[])
    sal_lines = [line for line in plan.lines if line.ingredient_id == sal.id]
    assert len(sal_lines) == 1  # fusionadas en una sola línea, no dos
    # 5 g directos + (200/1000 * 50 g de la salsa) = 5 + 10 = 15 g.
    assert sal_lines[0].qty_base == 15_000


def test_recipe_effect_add_increases_consumption(
    db: Session, org: Any, store: Any, admin_actor: Any, make_ingredient: Any, make_product: Any, make_modifier_option: Any
) -> None:
    base = make_ingredient("Insumo base (add)")
    extra = make_ingredient("Insumo extra (add)")
    product = make_product("Plato con extra (add)")
    service.put_product_recipe(
        db, actor=admin_actor, product_id=product.id,
        data=ProductRecipeIn(version=0, lines=[ComponentLineIn(ingredient_id=base.id, qty="100", unit="g")]),
    )
    option = make_modifier_option(product, "Extra (add)")
    service.put_modifier_option_recipe_effect(
        db, actor=admin_actor, option_id=option.id,
        data=RecipeEffectIn(effect="add", lines=[RecipeEffectLineIn(ingredient_id=extra.id, qty="50", unit="g")]),
    )

    baseline = expand_consumption(db, store_id=store.id, product_id=product.id, qty=1, modifier_option_ids=[])
    with_option = expand_consumption(
        db, store_id=store.id, product_id=product.id, qty=1, modifier_option_ids=[option.id]
    )
    assert {line.ingredient_id for line in baseline.lines} == {base.id}
    assert {line.ingredient_id for line in with_option.lines} == {base.id, extra.id}
    extra_line = next(line for line in with_option.lines if line.ingredient_id == extra.id)
    assert extra_line.qty_base == 50_000


def test_recipe_effect_remove_decreases_consumption(
    db: Session, org: Any, store: Any, admin_actor: Any, make_ingredient: Any, make_product: Any, make_modifier_option: Any
) -> None:
    base = make_ingredient("Insumo base (remove)")
    queso = make_ingredient("Queso (remove)")
    product = make_product("Plato con queso (remove)")
    service.put_product_recipe(
        db, actor=admin_actor, product_id=product.id,
        data=ProductRecipeIn(
            version=0,
            lines=[
                ComponentLineIn(ingredient_id=base.id, qty="100", unit="g"),
                ComponentLineIn(ingredient_id=queso.id, qty="30", unit="g"),
            ],
        ),
    )
    option = make_modifier_option(product, "Sin queso (remove)")
    service.put_modifier_option_recipe_effect(
        db, actor=admin_actor, option_id=option.id,
        data=RecipeEffectIn(effect="remove", lines=[RecipeEffectLineIn(ingredient_id=queso.id, qty="30", unit="g")]),
    )

    with_option = expand_consumption(
        db, store_id=store.id, product_id=product.id, qty=1, modifier_option_ids=[option.id]
    )
    assert {line.ingredient_id for line in with_option.lines} == {base.id}  # el queso desapareció, no quedó en 0


def test_recipe_effect_replace_swaps_one_component_for_another(
    db: Session, org: Any, store: Any, admin_actor: Any, make_ingredient: Any, make_product: Any, make_modifier_option: Any
) -> None:
    papa = make_ingredient("Papa (replace)")
    ensalada = make_ingredient("Ensalada (replace)")
    product = make_product("Plato con papa (replace)")
    service.put_product_recipe(
        db, actor=admin_actor, product_id=product.id,
        data=ProductRecipeIn(version=0, lines=[ComponentLineIn(ingredient_id=papa.id, qty="150", unit="g")]),
    )
    option = make_modifier_option(product, "Cambiar por ensalada (replace)")
    service.put_modifier_option_recipe_effect(
        db, actor=admin_actor, option_id=option.id,
        data=RecipeEffectIn(
            effect="replace",
            lines=[
                RecipeEffectLineIn(
                    ingredient_id=ensalada.id, qty="80", unit="g", replaces_ingredient_id=papa.id
                )
            ],
        ),
    )
    with_option = expand_consumption(
        db, store_id=store.id, product_id=product.id, qty=1, modifier_option_ids=[option.id]
    )
    assert {line.ingredient_id for line in with_option.lines} == {ensalada.id}
    ensalada_line = next(line for line in with_option.lines if line.ingredient_id == ensalada.id)
    assert ensalada_line.qty_base == 80_000


def test_batch_preparation_line_is_not_flattened(
    db: Session, org: Any, store: Any, admin_actor: Any, make_ingredient: Any, make_product: Any
) -> None:
    ing = make_ingredient("Insumo (batch no aplanado)")
    prep = service.create_preparation(
        db, actor=admin_actor, store_id=store.id,
        data=PreparationIn(
            name="Preparación batch (no aplanado)", mode="batch", standard_yield_qty="1000",
            standard_yield_unit="g", lines=[ComponentLineIn(ingredient_id=ing.id, qty="500", unit="g")],
        ),
    )
    product = make_product("Plato con preparación batch")
    service.put_product_recipe(
        db, actor=admin_actor, product_id=product.id,
        data=ProductRecipeIn(version=0, lines=[ComponentLineIn(preparation_id=prep.id, qty="300", unit="g")]),
    )
    plan = expand_consumption(db, store_id=store.id, product_id=product.id, qty=1, modifier_option_ids=[])
    assert len(plan.lines) == 1
    assert plan.lines[0].preparation_id == prep.id
    assert plan.lines[0].ingredient_id is None
