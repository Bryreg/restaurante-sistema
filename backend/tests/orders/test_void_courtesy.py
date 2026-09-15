"""Anulación de ítem (motivo tipado; sin/con autorizador; stub de merma) y
cortesía (motivo tipado; PIN obligatorio; conserva `list_price`)."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient


def test_void_pending_item_is_free(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any, main_product: Any) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    item_id = order["items"][0]["id"]

    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/items/{item_id}/void",
        json={"expected_version": order["version"], "reason": "customer_changed_mind"},
    )
    assert resp.status_code == 200, resp.text
    item = resp.json()["items"][0]
    assert item["status"] == "voided"
    assert item["void"]["reason"] == "customer_changed_mind"
    assert item["void"]["minutes_since_sent"] is None
    assert resp.json()["totals"]["total"] == 0


def test_void_sent_item_requires_authorizer(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any, main_product: Any, send_order: Any) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    order = send_order(order).json()
    item_id = order["items"][0]["id"]

    no_auth = device_client.post(
        f"/api/v1/orders/{order['id']}/items/{item_id}/void",
        json={"expected_version": order["version"], "reason": "kitchen_error"},
    )
    assert no_auth.status_code == 400, no_auth.text
    assert no_auth.json()["error"]["code"] == "AUTHORIZATION_REQUIRED"

    ok = device_client.post(
        f"/api/v1/orders/{order['id']}/items/{item_id}/void",
        json={"expected_version": order["version"], "reason": "kitchen_error", "authorizer_pin": "9999"},
    )
    assert ok.status_code == 200, ok.text
    item = ok.json()["items"][0]
    assert item["void"]["authorized_by"]["name"] == "Admin"
    assert item["void"]["minutes_since_sent"] == 0


def test_void_reason_other_requires_note(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any, main_product: Any) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    item_id = order["items"][0]["id"]

    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/items/{item_id}/void", json={"expected_version": order["version"], "reason": "other"}
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


def test_courtesy_requires_pin_and_keeps_list_price(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any, add_items: Any, main_product: Any) -> None:
    set_feature("pos.courtesies", True)
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    item_id = order["items"][0]["id"]

    # `authorizer_pin` no lleva `?` en el contrato: es obligatorio en el
    # esquema (nunca "en blanco" como en `void`/`discounts`, donde sólo hace
    # falta si el ítem ya se envió o hay cuenta presentada).
    no_pin = device_client.post(
        f"/api/v1/orders/{order['id']}/items/{item_id}/courtesy",
        json={"expected_version": order["version"], "reason": "complaint"},
    )
    assert no_pin.status_code == 400, no_pin.text
    assert no_pin.json()["error"]["code"] == "VALIDATION_ERROR"

    wrong_pin = device_client.post(
        f"/api/v1/orders/{order['id']}/items/{item_id}/courtesy",
        json={"expected_version": order["version"], "reason": "complaint", "authorizer_pin": "0000"},
    )
    assert wrong_pin.status_code == 400, wrong_pin.text
    assert wrong_pin.json()["error"]["code"] == "AUTHORIZATION_INVALID"

    ok = device_client.post(
        f"/api/v1/orders/{order['id']}/items/{item_id}/courtesy",
        json={"expected_version": order["version"], "reason": "complaint", "note": "mesa 3", "authorizer_pin": "9999"},
    )
    assert ok.status_code == 200, ok.text
    item = ok.json()["items"][0]
    assert item["unit_price"] == 0
    assert item["list_price"] == main_product.price_dine_in
    assert item["gross"] == 0
    assert item["courtesy"]["reason"] == "complaint"
    assert item["courtesy"]["authorized_by"]["name"] == "Admin"
    assert ok.json()["totals"]["total"] == 0


def test_courtesy_requires_feature(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any, add_items: Any, main_product: Any) -> None:
    set_feature("pos.courtesies", False)
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    item_id = order["items"][0]["id"]
    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/items/{item_id}/courtesy",
        json={"expected_version": order["version"], "reason": "complaint", "authorizer_pin": "9999"},
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
