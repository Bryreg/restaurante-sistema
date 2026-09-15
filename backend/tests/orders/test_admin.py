"""`GET /admin/orders` y `/admin/orders/{id}`: filtros, flags, `format=csv`."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient


def test_admin_list_orders_with_flags_and_csv(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any, add_items: Any, main_product: Any, store: Any
) -> None:
    set_feature("pos.courtesies", True)
    open_shift()
    identify(device_client, employees["operator"])

    plain = new_order().json()
    plain = add_items(plain, [{"product_id": main_product.id, "qty": 1}]).json()

    courtesy_order = new_order().json()
    courtesy_order = add_items(courtesy_order, [{"product_id": main_product.id, "qty": 1}]).json()
    item_id = courtesy_order["items"][0]["id"]
    courtesy_order = device_client.post(
        f"/api/v1/orders/{courtesy_order['id']}/items/{item_id}/courtesy",
        json={"expected_version": courtesy_order["version"], "reason": "complaint", "authorizer_pin": "9999"},
    ).json()

    listing = admin_client.get("/api/v1/admin/orders", params={"store_id": store.id})
    assert listing.status_code == 200, listing.text
    ids = {row["id"] for row in listing.json()}
    assert plain["id"] in ids
    assert courtesy_order["id"] in ids

    courtesies_only = admin_client.get("/api/v1/admin/orders", params={"store_id": store.id, "flags": "courtesy"})
    assert courtesies_only.status_code == 200, courtesies_only.text
    courtesy_ids = {row["id"] for row in courtesies_only.json()}
    assert courtesy_ids == {courtesy_order["id"]}
    assert courtesies_only.json()[0]["courtesies"] == 1

    csv_resp = admin_client.get("/api/v1/admin/orders", params={"store_id": store.id, "format": "csv"})
    assert csv_resp.status_code == 200, csv_resp.text
    assert csv_resp.headers["content-type"].startswith("text/csv")
    assert "id" in csv_resp.text.splitlines()[0]


def test_admin_get_order_same_shape_as_device(admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any, main_product: Any) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()

    resp = admin_client.get(f"/api/v1/admin/orders/{order['id']}")
    assert resp.status_code == 200, resp.text
    admin_order = resp.json()
    assert admin_order["items"][0]["name"] == "Bandeja Paisa"
    assert "unit_cost" not in admin_order["items"][0]
    assert "cost" not in str(admin_order)
    assert "margin" not in str(admin_order)
