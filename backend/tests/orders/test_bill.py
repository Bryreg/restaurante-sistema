"""Precuenta (`bill/present`) y división de cuenta (`bill/split`): partes
iguales, por ítems con sub-cuentas, y Σ sub-cuentas == total de la comanda."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.orders.conftest import idem_headers


def test_present_bill_stamps_once_and_counts_prints(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any, add_items: Any, main_product: Any) -> None:
    set_feature("pos.pre_bill", True)
    set_feature("pos.tips", True)
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()

    first = device_client.post(f"/api/v1/orders/{order['id']}/bill/present", json={"expected_version": order["version"]}, headers=idem_headers())
    assert first.status_code == 200, first.text
    body = first.json()
    assert body["bill_print_count"] == 1
    assert body["legend"] == "NO ES FACTURA — documento informativo"
    assert body["tip"]["suggested_pct"] == 10.0

    current = device_client.get(f"/api/v1/orders/{order['id']}").json()
    assert current["status"] == "to_pay"
    assert current["bill_presented_at"] is not None

    second = device_client.post(
        f"/api/v1/orders/{order['id']}/bill/present", json={"expected_version": current["version"]}, headers=idem_headers()
    )
    assert second.status_code == 200, second.text
    assert second.json()["bill_print_count"] == 2
    assert second.json()["bill_presented_at"] == current["bill_presented_at"]  # no se re-estampa


def test_present_bill_empty_order(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any) -> None:
    set_feature("pos.pre_bill", True)
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    resp = device_client.post(f"/api/v1/orders/{order['id']}/bill/present", json={"expected_version": order["version"]}, headers=idem_headers())
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "ORDER_EMPTY"


def test_tips_suggested_never_exceeds_10pct(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any, add_items: Any, main_product: Any, db: Any, store: Any) -> None:
    from app.stores import service as stores_service

    set_feature("pos.pre_bill", True)
    set_feature("pos.tips", True)
    settings = stores_service.get_sales_settings(db, store.id)
    settings.tip_suggested_pct = 15  # una configuración inválida no debería pasar de 10 en la lectura
    db.commit()

    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    resp = device_client.post(f"/api/v1/orders/{order['id']}/bill/present", json={"expected_version": order["version"]}, headers=idem_headers())
    assert resp.status_code == 200, resp.text
    assert resp.json()["tip"]["suggested_pct"] == 10.0


def test_staff_meal_has_no_tip(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any, add_items: Any, main_product: Any) -> None:
    set_feature("pos.pre_bill", True)
    set_feature("pos.tips", True)
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order(channel="staff_meal", consumed_by_employee_id=employees["operator2"].id).json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    resp = device_client.post(f"/api/v1/orders/{order['id']}/bill/present", json={"expected_version": order["version"]}, headers=idem_headers())
    assert resp.status_code == 200, resp.text
    assert resp.json()["tip"] is None
    assert resp.json()["total"] == 0


def test_split_bill_equal(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any, add_items: Any, main_product: Any) -> None:
    set_feature("pos.split_bill", True)
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()

    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/bill/split", json={"expected_version": order["version"], "mode": "equal", "parts": 3}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["mode"] == "equal"
    assert body["parts"] == 3
    assert sum(body["per_part"]) == body["total"] == main_product.price_dine_in
    assert len(body["per_part"]) == 3

    current = device_client.get(f"/api/v1/orders/{order['id']}").json()
    assert current["split_parts"] == 3


def test_split_bill_items_creates_sub_accounts_summing_to_total(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any, add_items: Any, main_product: Any, drink_product: Any) -> None:
    set_feature("pos.split_bill", True)
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}, {"product_id": drink_product.id, "qty": 3}]).json()
    main_item = next(i for i in order["items"] if i["name"] == "Bandeja Paisa")
    drink_item = next(i for i in order["items"] if i["name"] == "Gaseosa")

    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/bill/split",
        json={
            "expected_version": order["version"],
            "mode": "items",
            "groups": [
                {"label": "Persona 1", "item_ids": [main_item["id"]], "shared": [{"item_id": drink_item["id"], "portions": 1}]},
                {"label": "Persona 2", "item_ids": [], "shared": [{"item_id": drink_item["id"], "portions": 2}]},
            ],
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["sub_accounts"]) == 2

    order_totals = device_client.get(f"/api/v1/orders/{order['id']}").json()["totals"]["total"]
    sub_total = sum(sa["totals"]["total"] for sa in body["sub_accounts"])
    assert sub_total == order_totals  # invariante #2 del contrato

    listed = device_client.get(f"/api/v1/orders/{order['id']}/sub-accounts").json()
    assert len(listed) == 2
    assert sum(sa["totals"]["total"] for sa in listed) == order_totals


def test_split_bill_items_incomplete(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any, add_items: Any, main_product: Any, drink_product: Any) -> None:
    set_feature("pos.split_bill", True)
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}, {"product_id": drink_product.id, "qty": 1}]).json()
    main_item = next(i for i in order["items"] if i["name"] == "Bandeja Paisa")

    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/bill/split",
        json={"expected_version": order["version"], "mode": "items", "groups": [{"item_ids": [main_item["id"]]}]},
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "SPLIT_ITEMS_INCOMPLETE"
