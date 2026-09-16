"""Cobertura de recetas (§4.3): "un plato vendido sin receta ni insumo
directo no descuenta nada — la venta sigue — pero tiene que aparecer en un
reporte de «platos que no descuentan»". `app.recipes.hooks.uncosted_products`
es lo que consume `GET /admin/recipes/coverage`; acá se prueba directo sobre
filas de `app.orders.models` insertadas a mano (no hay comanda real: eso es
territorio de `backend-consumo`, que llama a esta misma función desde su
propio flujo de venta)."""

from __future__ import annotations

from datetime import date
from typing import Any

from sqlalchemy.orm import Session

from app.core import clock
from app.recipes import service
from app.recipes.hooks import uncosted_products
from app.recipes.schemas import ComponentLineIn, ProductRecipeIn


def _sell_one(
    db: Session,
    org: Any,
    store: Any,
    employee: Any,
    product: Any,
    business_date: date,
    *,
    consumed_ingredient_id: int | None = None,
    actor: Any = None,
) -> None:
    """Venta mínima, insertada a mano. `consumed_ingredient_id` escribe además
    el movimiento de consumo que el envío real deja en el libro.

    Hace falta desde el cierre de 2a: `uncosted_products` decide si una venta
    PASADA descontó algo leyendo el libro (`ref_type="order_item"`), no
    re-expandiendo la ficha de hoy — si la re-expandiera, cargar una ficha hoy
    reescribiría hacia atrás la cobertura de un período cerrado. Una venta
    insertada sin su movimiento es, correctamente, una venta que no descontó
    nada; para representar la que sí descontó hay que dejar el movimiento.
    """
    from app.orders.models import Order, OrderChannel, OrderItem

    now = clock.now_utc()
    order = Order(
        organization_id=org.id, store_id=store.id, business_date=business_date, channel=OrderChannel.COUNTER,
        opened_by_employee_id=employee.id, opened_by_employee_name=employee.name, opened_at=now,
        created_at=now, updated_at=now,
    )
    db.add(order)
    db.flush()
    item = OrderItem(
        organization_id=org.id, store_id=store.id, order_id=order.id, product_id=product.id, name=product.name,
        qty=1, course="main", list_price=product.price_dine_in, unit_price=product.price_dine_in,
        tax_code=product.tax_code, tax_rate=8, price_includes_tax=True, added_by_employee_id=employee.id,
        added_by_employee_name=employee.name, created_at=now,
    )
    db.add(item)
    db.flush()

    if consumed_ingredient_id is not None:
        from app.inventory.hooks import record_movement
        from app.inventory.models import CostSource, MovementCause

        record_movement(
            db,
            organization_id=org.id,
            store_id=store.id,
            ingredient_id=consumed_ingredient_id,
            qty_base=-10_000,
            cause=MovementCause.SALE,
            cost_micros=None,
            cost_source=CostSource.NONE,
            actor=actor,
            business_date=business_date,
            at=now,
            ref_type="order_item",
            ref_id=item.id,
        )
        db.flush()


def test_product_sold_without_recipe_appears_in_uncosted_products(
    db: Session, org: Any, store: Any, employees: dict[str, Any], admin_actor: Any, make_ingredient: Any,
    make_product: Any,
) -> None:
    today = clock.now_utc().date()
    no_recipe_product = make_product("Plato sin ficha (cobertura)")
    with_recipe_product = make_product("Plato con ficha (cobertura)")
    ing = make_ingredient("Insumo (cobertura)")
    service.put_product_recipe(
        db, actor=admin_actor, product_id=with_recipe_product.id,
        data=ProductRecipeIn(version=0, lines=[ComponentLineIn(ingredient_id=ing.id, qty="10", unit="g")]),
    )

    _sell_one(db, org, store, employees["cashier"], no_recipe_product, today)
    _sell_one(
        db, org, store, employees["cashier"], with_recipe_product, today,
        consumed_ingredient_id=ing.id, actor=admin_actor,
    )

    rows = uncosted_products(db, store_id=store.id, date_from=today, date_to=today)
    flagged_ids = {r["product_id"] for r in rows}
    assert no_recipe_product.id in flagged_ids
    assert with_recipe_product.id not in flagged_ids
    flagged = next(r for r in rows if r["product_id"] == no_recipe_product.id)
    assert flagged["items_sold"] == 1
    assert flagged["qty_sold"] == 1
