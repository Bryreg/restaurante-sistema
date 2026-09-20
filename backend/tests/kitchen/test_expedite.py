"""`POST /kitchen/orders/{id}/expedite` (`kitchen.kds`, CONTRATO C1: pasa por
`app.orders.hooks.expedite_order`). Checklist: expedir la comanda completa de
un solo gesto, idempotente, y «si no quedaba nada por expedir, no es un
error»."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.orders.conftest import idem_headers


def test_expedite_bumps_every_sent_item_of_the_order_at_once(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    new_order: Any, add_items: Any, main_product: Any, starter_product: Any, send_order: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(
        order, [{"product_id": main_product.id, "qty": 1}, {"product_id": starter_product.id, "qty": 2}]
    ).json()
    order = send_order(order).json()
    order_id = order["id"]
    item_ids = sorted(i["id"] for i in order["items"])

    resp = device_client.post(f"/api/v1/kitchen/orders/{order_id}/expedite", headers=idem_headers())
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["changed"] is True
    assert sorted(body["changed_item_ids"]) == item_ids
    assert {i["status"] for i in body["items"]} == {"ready"}
    assert body["expedited_by"]["name"] == "Operator"

    rounds = device_client.get("/api/v1/kitchen/rounds").json()
    statuses = {i["item_id"]: i["status"] for r in rounds for i in r["items"]}
    for item_id in item_ids:
        assert statuses[item_id] == "ready"


def test_expedite_with_nothing_pending_is_not_an_error(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    new_order: Any, add_items: Any, main_product: Any, send_order: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    order = send_order(order).json()
    order_id = order["id"]

    first = device_client.post(f"/api/v1/kitchen/orders/{order_id}/expedite", headers=idem_headers())
    assert first.status_code == 200 and first.json()["changed"] is True

    # Ya no queda nada `sent` en esta comanda (todo quedó `ready`): expedir
    # de nuevo no es un error, es información.
    second = device_client.post(f"/api/v1/kitchen/orders/{order_id}/expedite", headers=idem_headers())
    assert second.status_code == 200, second.text
    assert second.json()["changed"] is False
    assert second.json()["changed_item_ids"] == []
    assert second.json()["items"] == []


def test_expedite_unknown_order_is_404(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    resp = device_client.post("/api/v1/kitchen/orders/999999/expedite", headers=idem_headers())
    assert resp.status_code == 404, resp.text


def test_expedite_requires_kitchen_kds_flag(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any,
    new_order: Any, add_items: Any, main_product: Any, send_order: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    order = send_order(order).json()

    set_feature("kitchen.kds", False)
    resp = device_client.post(f"/api/v1/kitchen/orders/{order['id']}/expedite", headers=idem_headers())
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
    assert resp.json()["error"]["feature"] == "kitchen.kds"
