"""La regla dura que más fácil se rompe sin que se vea en pantalla: **el
insumo se descuenta una sola vez**, al producir (modo lote) o al enviar
(modo explotado), nunca los dos. El checklist lo prueba "comparando el saldo
final" del mismo insumo por los dos caminos: acá se compara literalmente el
número.

Diseño del test: dos preparaciones ESTRUCTURALMENTE IDÉNTICAS (misma línea de
insumo, mismo rendimiento estándar), una en cada modo, cada una vendida a
través de una ficha de plato de una sola línea que pide exactamente un
"lote estándar" (1000 g) de la preparación. El camino de venta se simula
llamando `expand_consumption` (puro) y aplicando su plan con
`record_movement` — exactamente lo que hace `app.orders.service.send`
(territorio de `backend-consumo`), reproducido acá porque la regla es
"cada hook cruzado entre territorios lleva dueño del test de punta a punta"
y este lado (que el insumo no se toque dos veces) es mío.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.deps import Actor
from app.core import clock
from app.recipes import service
from app.recipes.hooks import expand_consumption
from app.recipes.schemas import ComponentLineIn, PreparationIn, ProduceIn, ProductRecipeIn


def _admin_actor(org: Any, employees: dict[str, Any]) -> Actor:
    admin = employees["admin"]
    return Actor(
        kind="admin", organization_id=org.id, store_id=None, employee_id=admin.id, employee_name=admin.name,
        role="admin",
    )


def _apply_plan(db: Session, *, plan: Any, organization_id: int, store_id: int, actor: Actor) -> None:
    """Lo que hace `send` (ajeno): aplica el plan de `expand_consumption` con
    `record_movement`, causa `sale`."""
    from app.inventory import hooks as inventory_hooks
    from app.inventory.models import MovementCause

    now = clock.now_utc()
    for line in plan.lines:
        inventory_hooks.record_movement(
            db,
            organization_id=organization_id,
            store_id=store_id,
            ingredient_id=line.ingredient_id,
            preparation_id=line.preparation_id,
            qty_base=-line.qty_base,
            cause=MovementCause.SALE,
            cost_micros=line.cost_micros,
            cost_source=line.cost_source,
            actor=actor,
            business_date=now.date(),
            at=now,
            ref_type="order_item",
            ref_id=1,
            note=None,
        )


def test_ingredient_is_discounted_exactly_once_batch_vs_exploded(
    db: Session, org: Any, store: Any, employees: dict[str, Any], make_ingredient: Any, make_product: Any
) -> None:
    from app.inventory import hooks as inventory_hooks

    actor = _admin_actor(org, employees)
    pollo = make_ingredient("Pollo (single-discount test)", base_unit="g", yield_pct=100, official_cost_micros=8_000_000)

    # -- Camino A: modo `batch` -------------------------------------------------
    prep_batch = service.create_preparation(
        db, actor=actor, store_id=store.id,
        data=PreparationIn(
            name="Pollo desmechado (batch)", mode="batch", standard_yield_qty="1000", standard_yield_unit="g",
            lines=[ComponentLineIn(ingredient_id=pollo.id, qty="1200", unit="g")],
        ),
    )
    batch = service.produce_preparation(
        db, actor=actor, preparation=prep_batch,
        data=ProduceIn(qty_expected="1000", qty_real="1000", employee_pin="9999"),
    )
    assert batch.id is not None

    product_batch = make_product("Plato con pollo (batch)")
    service.put_product_recipe(
        db, actor=actor, product_id=product_batch.id,
        data=ProductRecipeIn(version=0, lines=[ComponentLineIn(preparation_id=prep_batch.id, qty="1000", unit="g")]),
    )
    plan_batch = expand_consumption(db, store_id=store.id, product_id=product_batch.id, qty=1, modifier_option_ids=[])
    # La venta, en modo batch, consume la PREPARACIÓN — nunca el insumo de nuevo.
    assert len(plan_batch.lines) == 1
    assert plan_batch.lines[0].preparation_id == prep_batch.id
    assert plan_batch.lines[0].ingredient_id is None
    _apply_plan(db, plan=plan_batch, organization_id=org.id, store_id=store.id, actor=actor)

    pollo_stock_batch_path = inventory_hooks.current_stock(db, store_id=store.id, ingredient_id=pollo.id)

    # Ningún movimiento de VENTA tocó al insumo en el camino batch.
    from app.inventory.models import MovementCause, StockMovement

    sale_rows_touching_ingredient = db.execute(
        select(StockMovement).where(
            StockMovement.ingredient_id == pollo.id, StockMovement.cause == MovementCause.SALE
        )
    ).scalars().all()
    assert sale_rows_touching_ingredient == []

    # -- Camino B: modo `exploded`, sobre un insumo DISTINTO (misma receta) ----
    pollo_2 = make_ingredient("Pollo (single-discount test, exploded)", base_unit="g", yield_pct=100, official_cost_micros=8_000_000)
    prep_exploded = service.create_preparation(
        db, actor=actor, store_id=store.id,
        data=PreparationIn(
            name="Pollo desmechado (exploded)", mode="exploded", standard_yield_qty="1000", standard_yield_unit="g",
            lines=[ComponentLineIn(ingredient_id=pollo_2.id, qty="1200", unit="g")],
        ),
    )
    # Nunca se produce (`exploded` no tiene lotes): sin `produce_preparation`.
    product_exploded = make_product("Plato con pollo (exploded)")
    service.put_product_recipe(
        db, actor=actor, product_id=product_exploded.id,
        data=ProductRecipeIn(version=0, lines=[ComponentLineIn(preparation_id=prep_exploded.id, qty="1000", unit="g")]),
    )
    plan_exploded = expand_consumption(
        db, store_id=store.id, product_id=product_exploded.id, qty=1, modifier_option_ids=[]
    )
    # La venta, en modo exploded, se aplana hasta el insumo directamente.
    assert len(plan_exploded.lines) == 1
    assert plan_exploded.lines[0].ingredient_id == pollo_2.id
    assert plan_exploded.lines[0].preparation_id is None
    _apply_plan(db, plan=plan_exploded, organization_id=org.id, store_id=store.id, actor=actor)

    pollo_2_stock_exploded_path = inventory_hooks.current_stock(db, store_id=store.id, ingredient_id=pollo_2.id)

    # Sin movimientos de producción para el camino exploded (nunca se produjo).
    production_rows = db.execute(
        select(StockMovement).where(
            StockMovement.ingredient_id == pollo_2.id,
            StockMovement.cause.in_([MovementCause.PRODUCTION_OUT, MovementCause.PRODUCTION_IN]),
        )
    ).scalars().all()
    assert production_rows == []

    # -- El saldo final: MISMA receta, MISMO consumo total, por los dos caminos.
    assert pollo_stock_batch_path == pollo_2_stock_exploded_path == -1_200_000  # 1200 g * QTY_SCALE(1000), negativo
