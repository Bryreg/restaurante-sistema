"""Precisión completa de costo (RONDA 2, `conflict-002-b2`): ningún costo real
por debajo de $1 se reporta como `"0"`.

Decisión de contrato (uniforme con `app.inventory.service.ingredient_out`):
TODO costo que sale por la API de `recipes` viaja como texto decimal en
pesos con precisión completa (`app.core.quantity.format_cost_micros`).
`micros_to_pesos` queda sólo para plata de venta (snapshot
`order_items.unit_cost`, totales de reportes), nunca para un costo por
unidad base publicado por este dominio — redondear a pesos ANTES de
publicar o de calcular `food_cost_pct` es exactamente lo que hacía que un
costo de $0,30 se reportara como `$0`/`0.00 %`.

Cierra la mitad backend de
`tests/audit/test_cost_invariants.py::test_a_real_cost_below_one_peso_is_never_reported_as_zero`
para este dominio.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from app.recipes import service
from app.recipes.schemas import ComponentLineIn, PreparationIn, ProductRecipeIn


def test_preparation_of_cheap_salt_publishes_full_precision_cost_not_zero(
    db: Session, org: Any, store: Any, admin_actor: Any, make_ingredient: Any
) -> None:
    """Sal a $0,003/g (3.000 millonésimas de peso por gramo): una
    preparación de 1 kg de sal (modo `exploded`, sin lote) tiene que
    publicar `unit_cost = "0.003"` con `cost_source = "official"` — nunca
    `unit_cost = "0"` (que un cliente no podría distinguir de "sin costo")."""
    sal = make_ingredient("Sal (precisión)", base_unit="g", yield_pct=100, official_cost_micros=3_000)

    prep = service.create_preparation(
        db,
        actor=admin_actor,
        store_id=store.id,
        data=PreparationIn(
            name="Sal preparada (precisión)",
            mode="exploded",
            standard_yield_qty="1000",
            standard_yield_unit="g",
            lines=[ComponentLineIn(ingredient_id=sal.id, qty="1000", unit="g")],
        ),
    )

    out = service.preparation_admin_out(db, prep)

    assert out.unit_cost == "0.003"
    assert out.cost_source == "official"


def test_recipe_of_100g_cheap_salt_publishes_full_precision_cost_and_nonzero_food_cost_pct(
    db: Session, org: Any, store: Any, admin_actor: Any, make_ingredient: Any, make_product: Any
) -> None:
    """Ficha con una línea directa de 100 g de esa misma sal: costo teórico
    `"0.3"` (no `"0"`), y `food_cost_pct` distinto de `0.00` — precio neto
    bajo a propósito para que el cociente real no desaparezca al redondear
    a 2 decimales en el borde."""
    sal = make_ingredient("Sal (precisión, ficha)", base_unit="g", yield_pct=100, official_cost_micros=3_000)
    product = make_product("Guarnición de sal (precisión)", price_dine_in=1_000, tax_code="excluded")

    out = service.put_product_recipe(
        db,
        actor=admin_actor,
        product_id=product.id,
        data=ProductRecipeIn(version=0, lines=[ComponentLineIn(ingredient_id=sal.id, qty="100", unit="g")]),
    )

    assert out.theoretical_cost == "0.3"
    assert out.cost_source == "official"
    assert out.food_cost_pct is not None
    assert out.food_cost_pct != Decimal("0.00")
    assert out.food_cost_pct == Decimal("0.03")  # $0,3 costo / $1.000 precio neto * 100
