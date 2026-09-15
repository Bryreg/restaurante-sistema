"""E2E dueño **backend-comanda** (`CONTRATO-INTERNO-1b-1.md §2.5`):
`courtesy`/`discount` -> `notifications.service.notify` con los tipos nuevos
(`courtesy_limit`, `discount_rate_high`), con dedupe diario por
`dedupe_key`."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from fastapi.testclient import TestClient

from app.notifications.models import Notification
from app.stores import service as stores_service


def _notifications_of_type(db: Session, organization_id: int, ntype: str) -> list[Notification]:
    return list(
        db.execute(
            select(Notification).where(Notification.organization_id == organization_id, Notification.type == ntype)
        ).scalars()
    )


def test_courtesy_limit_notifies_with_dedupe(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any, add_items: Any, main_product: Any, drink_product: Any, db: Any, store: Any, org: Any
) -> None:
    set_feature("pos.courtesies", True)
    settings = stores_service.get_sales_settings(db, store.id)
    settings.courtesy_shift_limit = 1
    db.commit()

    open_shift()
    identify(device_client, employees["operator"])

    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}, {"product_id": drink_product.id, "qty": 1}]).json()
    item1, item2 = order["items"][0]["id"], order["items"][1]["id"]

    first = device_client.post(
        f"/api/v1/orders/{order['id']}/items/{item1}/courtesy",
        json={"expected_version": order["version"], "reason": "complaint", "authorizer_pin": "9999"},
    )
    assert first.status_code == 200, first.text
    assert _notifications_of_type(db, org.id, "courtesy_limit") == []  # 1 cortesía == límite, no lo supera

    order = first.json()
    second = device_client.post(
        f"/api/v1/orders/{order['id']}/items/{item2}/courtesy",
        json={"expected_version": order["version"], "reason": "complaint", "authorizer_pin": "9999"},
    )
    assert second.status_code == 200, second.text
    notifications = _notifications_of_type(db, org.id, "courtesy_limit")
    assert len(notifications) == 1
    assert notifications[0].dedupe_key == f"courtesy_limit:{order['shift_id']}"

    # Un tercer disparo el mismo día no duplica (dedupe).
    order3 = new_order().json()
    order3 = add_items(order3, [{"product_id": main_product.id, "qty": 1}]).json()
    third = device_client.post(
        f"/api/v1/orders/{order3['id']}/items/{order3['items'][0]['id']}/courtesy",
        json={"expected_version": order3["version"], "reason": "complaint", "authorizer_pin": "9999"},
    )
    assert third.status_code == 200, third.text
    assert len(_notifications_of_type(db, org.id, "courtesy_limit")) == 1


def test_discount_rate_high_notifies_with_dedupe(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any, add_items: Any, main_product: Any, db: Any, store: Any, org: Any
) -> None:
    set_feature("pos.discounts", True)
    shift = open_shift()
    identify(device_client, employees["operator"])
    operator = employees["operator"]

    # Simula una venta ya cobrada por este operador en el turno (el cobro es
    # territorio de `backend-cobro`, todavía no existe en este pedido): la
    # comanda se marca `paid` directo en la base para establecer "sus
    # ventas" y poder probar el acumulado de descuentos sin esperar a 1b-1
    # completo. `_check_discount_rate_high` sólo lee `Order`/`OrderDiscount`.
    from app.orders.models import Order

    paid_order = new_order().json()
    paid_order = add_items(paid_order, [{"product_id": main_product.id, "qty": 4}]).json()  # 100.000
    row = db.get(Order, paid_order["id"])
    row.status = "paid"
    row.paid_by_employee_id = operator.id
    row.paid_by_employee_name = operator.name
    db.commit()

    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()  # 25.000

    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/discounts",
        json={"expected_version": order["version"], "scope": "order", "kind": "percent", "value": 10, "reason": "owner", "authorizer_pin": "9999"},
    )
    assert resp.status_code == 200, resp.text
    # 2.500 de descuento / 100.000 de ventas pagadas = 2,5 %: bajo el 5 % default, sin alerta todavía.
    assert _notifications_of_type(db, org.id, "discount_rate_high") == []

    order2 = new_order().json()
    order2 = add_items(order2, [{"product_id": main_product.id, "qty": 3}]).json()  # 75.000
    resp2 = device_client.post(
        f"/api/v1/orders/{order2['id']}/discounts",
        json={"expected_version": order2["version"], "scope": "order", "kind": "percent", "value": 10, "reason": "owner", "authorizer_pin": "9999"},
    )
    assert resp2.status_code == 200, resp2.text
    notifications = _notifications_of_type(db, org.id, "discount_rate_high")
    assert len(notifications) == 1
    assert notifications[0].dedupe_key == f"discount_rate_high:{shift['id']}:{operator.id}"

    order3 = new_order().json()
    order3 = add_items(order3, [{"product_id": main_product.id, "qty": 1}]).json()
    resp3 = device_client.post(
        f"/api/v1/orders/{order3['id']}/discounts",
        json={"expected_version": order3["version"], "scope": "order", "kind": "percent", "value": 10, "reason": "owner", "authorizer_pin": "9999"},
    )
    assert resp3.status_code == 200, resp3.text
    assert len(_notifications_of_type(db, org.id, "discount_rate_high")) == 1  # dedupe


def test_void_rate_high_notifies_with_dedupe(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any, main_product: Any, drink_product: Any, db: Any, store: Any, org: Any
) -> None:
    """1b-2 (`app.orders.service._check_void_rate_high`, espejo de
    `_check_discount_rate_high`): anular a precio de lista por encima de
    `VOID_RATE_ALERT_PCT` sobre las ventas del turno de la persona ->
    `void_rate_high`, con el mismo dedupe diario que las otras alertas."""
    shift = open_shift()
    identify(device_client, employees["operator"])
    operator = employees["operator"]

    from app.orders.models import Order

    paid_order = new_order().json()
    paid_order = add_items(paid_order, [{"product_id": main_product.id, "qty": 4}]).json()  # 100.000
    row = db.get(Order, paid_order["id"])
    row.status = "paid"
    row.paid_by_employee_id = operator.id
    row.paid_by_employee_name = operator.name
    db.commit()

    order_a = new_order().json()
    order_a = add_items(order_a, [{"product_id": drink_product.id, "qty": 1}]).json()  # 5.000
    item_a = order_a["items"][0]["id"]
    void_a = device_client.post(
        f"/api/v1/orders/{order_a['id']}/items/{item_a}/void",
        json={"expected_version": order_a["version"], "reason": "duplicate"},
    )
    assert void_a.status_code == 200, void_a.text
    # 5.000 anulado / 100.000 de ventas pagadas = 5 %: bajo el 10 % default, sin alerta todavía.
    assert _notifications_of_type(db, org.id, "void_rate_high") == []

    order_b = new_order().json()
    order_b = add_items(order_b, [{"product_id": drink_product.id, "qty": 2}]).json()  # 10.000
    item_b = order_b["items"][0]["id"]
    void_b = device_client.post(
        f"/api/v1/orders/{order_b['id']}/items/{item_b}/void",
        json={"expected_version": order_b["version"], "reason": "duplicate"},
    )
    assert void_b.status_code == 200, void_b.text
    # Acumulado 15.000 / 100.000 = 15 % > 10 %: alerta.
    notifications = _notifications_of_type(db, org.id, "void_rate_high")
    assert len(notifications) == 1
    assert notifications[0].dedupe_key == f"void_rate_high:{shift['id']}:{operator.id}"

    order_c = new_order().json()
    order_c = add_items(order_c, [{"product_id": drink_product.id, "qty": 1}]).json()
    item_c = order_c["items"][0]["id"]
    void_c = device_client.post(
        f"/api/v1/orders/{order_c['id']}/items/{item_c}/void",
        json={"expected_version": order_c["version"], "reason": "duplicate"},
    )
    assert void_c.status_code == 200, void_c.text
    assert len(_notifications_of_type(db, org.id, "void_rate_high")) == 1  # dedupe diario
