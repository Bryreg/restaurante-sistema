"""CONTRATO C1 (pedido 2c): lo que `app.orders.hooks` publica para el KDS
(`backend-kds`, territorio de `app/kitchen/**`, ajeno). `backend-kds` nunca
escribe `OrderItem.status` a mano — todas sus escrituras pasan por
`bump_item`/`unbump_item`/`expedite_order`; `fired_at_by_course` es lectura
pura. Estos tests llaman las funciones DIRECTO (no hay router propio: eso lo
construye `backend-kds`), verificando el contrato tal cual lo va a usar."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.core import clock
from app.core.errors import NotFoundError
from app.orders import hooks as orders_hooks
from app.orders.models import OrderItem, OrderItemStatus
from tests.orders.conftest import idem_headers


def _send(device_client: TestClient, order: dict[str, Any]) -> dict[str, Any]:
    resp = device_client.post(f"/api/v1/orders/{order['id']}/send", json={"expected_version": order["version"]}, headers=idem_headers())
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_bump_item_is_idempotent(
    db: Any, device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any,
    main_product: Any, admin_actor: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    order = _send(device_client, order)
    item_id = order["items"][0]["id"]

    now = clock.now_utc()
    first = orders_hooks.bump_item(db, item_id=item_id, store_id=main_product.store_id, actor=admin_actor, now=now)
    assert first is True
    item = db.get(OrderItem, item_id)
    assert item.status == OrderItemStatus.READY
    assert item.ready_at == now

    second = orders_hooks.bump_item(db, item_id=item_id, store_id=main_product.store_id, actor=admin_actor, now=clock.now_utc())
    assert second is False  # ya estaba `ready`: no error, no cambio


def test_bump_item_unknown_item_raises_not_found(db: Any, main_product: Any, admin_actor: Any) -> None:
    with pytest.raises(NotFoundError):
        orders_hooks.bump_item(db, item_id=999_999, store_id=main_product.store_id, actor=admin_actor, now=clock.now_utc())


def test_unbump_item_reverses_a_bump(
    db: Any, device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any,
    main_product: Any, admin_actor: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    order = _send(device_client, order)
    item_id = order["items"][0]["id"]

    assert orders_hooks.bump_item(db, item_id=item_id, store_id=main_product.store_id, actor=admin_actor, now=clock.now_utc()) is True
    undo = orders_hooks.unbump_item(db, item_id=item_id, store_id=main_product.store_id, actor=admin_actor, now=clock.now_utc())
    assert undo is True
    item = db.get(OrderItem, item_id)
    assert item.status == OrderItemStatus.SENT
    assert item.ready_at is None

    # Deshacer de nuevo (no estaba `ready`) es un no-op idempotente.
    assert orders_hooks.unbump_item(db, item_id=item_id, store_id=main_product.store_id, actor=admin_actor, now=clock.now_utc()) is False


def test_expedite_order_bumps_all_sent_items_and_returns_changed_ids(
    db: Any, device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any,
    main_product: Any, admin_actor: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 3}]).json()
    order = _send(device_client, order)
    item_id = order["items"][0]["id"]

    changed = orders_hooks.expedite_order(db, order_id=order["id"], store_id=main_product.store_id, actor=admin_actor, now=clock.now_utc())
    assert changed == [item_id]
    item = db.get(OrderItem, item_id)
    assert item.status == OrderItemStatus.READY

    # Ya no queda nada `sent`: expedita de nuevo devuelve `[]`, sin error.
    again = orders_hooks.expedite_order(db, order_id=order["id"], store_id=main_product.store_id, actor=admin_actor, now=clock.now_utc())
    assert again == []


def test_fired_at_by_course_reads_what_fire_course_wrote(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, db: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/courses/starter/fire", json={"expected_version": order["version"]}, headers=idem_headers()
    )
    assert resp.status_code == 200, resp.text

    by_course = orders_hooks.fired_at_by_course(db, order_id=order["id"])
    assert set(by_course) == {"starter"}
    assert by_course["starter"] is not None
