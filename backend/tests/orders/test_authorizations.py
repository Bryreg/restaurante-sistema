"""E2E dueño **backend-comanda** (`CONTRATO-INTERNO-1b-1.md §2.5`): el
supervisor autoriza `void_order` y `after_bill_change`; un operador no puede."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.orders.conftest import idem_headers


def test_supervisor_authorizes_void_order_operator_cannot(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any, main_product: Any, send_order: Any) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    order = send_order(order).json()  # al menos un ítem enviado -> exige autorizador

    # PIN de un operador: ni siquiera es candidato a autorizar (la matriz
    # sólo busca entre supervisores y administradores) -> PIN incorrecto.
    denied = device_client.post(
        f"/api/v1/orders/{order['id']}/void",
        json={"expected_version": order["version"], "reason": "duplicate", "authorizer_pin": "2222"},
    )
    assert denied.status_code == 400, denied.text
    assert denied.json()["error"]["code"] == "AUTHORIZATION_INVALID"

    # El supervisor (PIN "5555") sí puede.
    ok = device_client.post(
        f"/api/v1/orders/{order['id']}/void",
        json={"expected_version": order["version"], "reason": "duplicate", "authorizer_pin": "5555"},
    )
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert body["status"] == "voided"
    assert body["void_reason"] == "duplicate"


def test_after_bill_change_needs_authorizer_on_merge(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any, add_items: Any, main_product: Any) -> None:
    set_feature("pos.tables", True)
    set_feature("pos.pre_bill", True)
    open_shift()
    identify(device_client, employees["operator"])

    order_a = new_order().json()
    order_a = add_items(order_a, [{"product_id": main_product.id, "qty": 1}]).json()
    order_b = new_order().json()
    order_b = add_items(order_b, [{"product_id": main_product.id, "qty": 1}]).json()

    presented = device_client.post(
        f"/api/v1/orders/{order_a['id']}/bill/present", json={"expected_version": order_a["version"]}, headers=idem_headers()
    )
    assert presented.status_code == 200, presented.text
    order_a = device_client.get(f"/api/v1/orders/{order_a['id']}").json()

    no_auth = device_client.post(
        f"/api/v1/orders/{order_a['id']}/merge", json={"expected_version": order_a["version"], "from_order_id": order_b["id"]}
    )
    assert no_auth.status_code == 400, no_auth.text
    assert no_auth.json()["error"]["code"] == "AUTHORIZATION_REQUIRED"

    ok = device_client.post(
        f"/api/v1/orders/{order_a['id']}/merge",
        json={"expected_version": order_a["version"], "from_order_id": order_b["id"], "authorizer_pin": "5555"},
    )
    assert ok.status_code == 200, ok.text
    merged = ok.json()
    assert len(merged["items"]) == 2
    assert merged["totals"]["total"] == 2 * main_product.price_dine_in
