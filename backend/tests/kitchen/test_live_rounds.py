"""Qué sigue siendo trabajo de cocina (`app.kitchen.service.live_rounds`).

Antes `GET /kitchen/rounds` leía todas las rondas de la sede desde el primer
día: un plato despachado (`ready`) que nadie marcaba `served` se quedaba en
el KDS para siempre. `python -m app.demo` lo encontró a las dos semanas: 460
rondas en rojo con 14 días de «espera».
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from tests.orders.conftest import idem_headers


@pytest.fixture(autouse=True)
def _sin_documento_fiscal(set_feature: Any) -> None:
    # Cobrar exige rango DIAN; lo que se prueba acá es la cocina, no el documento.
    set_feature("fiscal.dee_pos", False)


def _send_one(device_client: TestClient, new_order: Any, add_items: Any, send_order: Any, product: Any) -> dict:
    order = new_order().json()
    order = add_items(order, [{"product_id": product.id, "qty": 1}]).json()
    return send_order(order).json()


def _pay(device_client: TestClient, order_id: int) -> None:
    order = device_client.get(f"/api/v1/orders/{order_id}").json()
    resp = device_client.post(
        f"/api/v1/orders/{order_id}/payments",
        json={
            "pin": "1111",
            "tip": {"asked": True, "accepted": False, "modified": False, "amount": 0},
            "splits": [{"method": "cash", "amount": order["totals"]["total"]}],
        },
        headers=idem_headers(),
    )
    assert resp.status_code == 201, resp.text


def _round_order_ids(device_client: TestClient) -> set[int]:
    return {r["order_id"] for r in device_client.get("/api/v1/kitchen/rounds").json()}


def test_paid_counter_order_still_shows_what_the_kitchen_has_not_cooked(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any,
    send_order: Any, main_product: Any,
) -> None:
    """En mostrador se cobra antes de cocinar: cobrada no quiere decir lista."""
    open_shift()
    identify(device_client, employees["cashier"])
    order = _send_one(device_client, new_order, add_items, send_order, main_product)
    _pay(device_client, order["id"])
    assert order["id"] in _round_order_ids(device_client)


def test_paid_order_leaves_the_kitchen_once_the_dish_is_ready(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any,
    send_order: Any, main_product: Any, clock: Any,
) -> None:
    open_shift()
    identify(device_client, employees["cashier"])
    order = _send_one(device_client, new_order, add_items, send_order, main_product)
    item_id = order["items"][0]["id"]
    ready = device_client.post(f"/api/v1/orders/{order['id']}/items/{item_id}/ready", headers=idem_headers())
    assert ready.status_code == 200, ready.text
    # Abierta y lista: la cocina la sigue viendo (falta que salga al salón).
    assert order["id"] in _round_order_ids(device_client)

    _pay(device_client, order["id"])
    # Recién marcado: sigue a la vista un rato, para poder deshacer un toque equivocado.
    assert order["id"] in _round_order_ids(device_client)
    clock.advance(minutes=11)
    identify(device_client, employees["cashier"])
    assert order["id"] not in _round_order_ids(device_client)


def test_a_shift_selling_past_the_cutoff_keeps_its_kitchen(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any,
    send_order: Any, main_product: Any, clock: Any,
) -> None:
    """Pasada la hora de corte el «hoy» cambia, pero mientras el turno siga
    abierto lo que cobró y todavía no se cocinó sigue siendo trabajo."""
    open_shift()
    identify(device_client, employees["cashier"])
    order = _send_one(device_client, new_order, add_items, send_order, main_product)
    _pay(device_client, order["id"])

    clock.advance(days=1)
    identify(device_client, employees["cashier"])
    assert order["id"] in _round_order_ids(device_client)


def test_yesterdays_paid_orders_of_a_closed_shift_are_not_kitchen_work(
    device_client: TestClient, admin_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    new_order: Any, add_items: Any, send_order: Any, main_product: Any, clock: Any,
) -> None:
    """Un plato cobrado en un turno ya cerrado de otro día no es trabajo de hoy."""
    shift = open_shift()
    identify(device_client, employees["cashier"])
    order = _send_one(device_client, new_order, add_items, send_order, main_product)
    _pay(device_client, order["id"])
    assert order["id"] in _round_order_ids(device_client)

    clock.advance(days=2)
    closed = admin_client.post(
        f"/api/v1/admin/shifts/{shift['id']}/close-administrative", json={"reason": "abandonado"}
    )
    assert closed.status_code in (200, 201), closed.text
    identify(device_client, employees["cashier"])
    assert order["id"] not in _round_order_ids(device_client)


def test_voided_order_is_not_kitchen_work(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any,
    send_order: Any, main_product: Any,
) -> None:
    open_shift()
    identify(device_client, employees["cashier"])
    order = _send_one(device_client, new_order, add_items, send_order, main_product)
    void = device_client.post(
        f"/api/v1/orders/{order['id']}/void",
        json={"expected_version": order["version"], "reason": "customer_changed_mind", "authorizer_pin": "9999"},
        headers=idem_headers(),
    )
    assert void.status_code == 200, void.text
    assert order["id"] not in _round_order_ids(device_client)
