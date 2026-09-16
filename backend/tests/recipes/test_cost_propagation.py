"""El costo propaga en cadena insumo -> preparación -> plato ("en la
referencia no propagaba", ítem explícito del checklist). Acá el motor de
costo se calcula siempre al vuelo (`app/recipes/cost.py`, decisión
documentada ahí y en el entregable) así que la propagación no necesita
invalidar nada: la siguiente lectura ya ve el costo nuevo.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from app.core.quantity import micros_to_pesos
from app.recipes import cost, service
from app.recipes.schemas import ComponentLineIn, PreparationIn, ProductRecipeIn


def test_ingredient_cost_change_propagates_to_preparation_and_product(
    db: Session, org: Any, store: Any, admin_actor: Any, make_ingredient: Any, make_product: Any
) -> None:
    tomate = make_ingredient("Tomate (propagación)", base_unit="g", yield_pct=100, official_cost_micros=5_000_000)

    salsa = service.create_preparation(
        db, actor=admin_actor, store_id=store.id,
        data=PreparationIn(
            name="Salsa (propagación)", mode="exploded", standard_yield_qty="1000", standard_yield_unit="g",
            lines=[ComponentLineIn(ingredient_id=tomate.id, qty="1000", unit="g")],
        ),
    )
    unit_cost_before, _source = cost.preparation_unit_cost(db, salsa)
    assert micros_to_pesos(unit_cost_before) == 5  # $5/g * 1000 g / 1000 g rendimiento = $5/g

    product = make_product("Plato con salsa (propagación)")
    out_before = service.put_product_recipe(
        db, actor=admin_actor, product_id=product.id,
        data=ProductRecipeIn(version=0, lines=[ComponentLineIn(preparation_id=salsa.id, qty="200", unit="g")]),
    )
    assert out_before.theoretical_cost is not None
    assert Decimal(out_before.theoretical_cost) == Decimal(1_000)  # 200 g * $5/g

    # El dueño cambia el costo oficial del tomate (misma fila, sin pasar por
    # ninguna función de este dominio: es exactamente lo que hará
    # `backend-inventario` desde `PATCH /admin/ingredients/{id}`).
    tomate.official_cost_micros = 8_000_000
    db.flush()

    unit_cost_after, _source2 = cost.preparation_unit_cost(db, salsa)
    assert micros_to_pesos(unit_cost_after) == 8

    out_after = service.get_product_recipe(db, actor=admin_actor, product_id=product.id)
    assert out_after.theoretical_cost is not None
    # 200 g * $8/g — propagó sin volver a guardar la ficha
    assert Decimal(out_after.theoretical_cost) == Decimal(1_600)
    assert out_after.version == out_before.version  # la ficha no cambió; sólo el costo que reporta


def test_cost_propagates_through_a_nested_preparation(
    db: Session, org: Any, store: Any, admin_actor: Any, make_ingredient: Any, make_product: Any
) -> None:
    """insumo -> preparación A -> preparación B (que usa A) -> plato: dos
    saltos de propagación, no sólo uno."""
    limon = make_ingredient("Limón (propagación anidada)", base_unit="unit", yield_pct=100, official_cost_micros=1_000_000_000)

    jugo = service.create_preparation(
        db, actor=admin_actor, store_id=store.id,
        data=PreparationIn(
            name="Jugo de limón base", mode="exploded", standard_yield_qty="1000", standard_yield_unit="ml",
            lines=[ComponentLineIn(ingredient_id=limon.id, qty="10", unit="unit")],
        ),
    )
    limonada = service.create_preparation(
        db, actor=admin_actor, store_id=store.id,
        data=PreparationIn(
            name="Limonada base", mode="exploded", standard_yield_qty="1000", standard_yield_unit="ml",
            lines=[ComponentLineIn(preparation_id=jugo.id, qty="300", unit="ml")],
        ),
    )
    product = make_product("Limonada (propagación anidada)")
    service.put_product_recipe(
        db, actor=admin_actor, product_id=product.id,
        data=ProductRecipeIn(version=0, lines=[ComponentLineIn(preparation_id=limonada.id, qty="1000", unit="ml")]),
    )
    out_before = service.get_product_recipe(db, actor=admin_actor, product_id=product.id)

    limon.official_cost_micros = 2_000_000_000  # duplica el costo del limón
    db.flush()

    out_after = service.get_product_recipe(db, actor=admin_actor, product_id=product.id)
    assert out_before.theoretical_cost is not None
    assert out_after.theoretical_cost is not None
    assert Decimal(out_after.theoretical_cost) == Decimal(out_before.theoretical_cost) * 2
