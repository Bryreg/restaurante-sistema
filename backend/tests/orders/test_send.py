"""`POST /orders/{id}/send`: ronda numerada, sin estación → `served`,
`kitchen.view` apagada, y el hook E2E que `backend-comanda` debe (§2.5 del
contrato): `send`/`auto_send` → `catalog.service.set_product_availability` al
llegar a 0, reflejado en `GET /catalog`, y un `void` no lo repone."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.orders.conftest import idem_headers


def test_send_creates_numbered_round_only_with_pending(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any, main_product: Any, drink_product: Any, send_order: Any) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}, {"product_id": drink_product.id, "qty": 2}]).json()

    resp = send_order(order)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["rounds"]) == 1
    assert body["rounds"][0]["round_no"] == 1
    assert body["rounds"][0]["sent_at_payment"] is False

    items_by_name = {i["name"]: i for i in body["items"]}
    assert items_by_name["Bandeja Paisa"]["status"] == "sent"
    assert items_by_name["Bandeja Paisa"]["sent_at"] is not None
    # Sin estación -> pasa directo a "served", nunca "sent".
    assert items_by_name["Gaseosa"]["status"] == "served"
    assert items_by_name["Gaseosa"]["served_at"] is not None


def test_nothing_to_send(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, send_order: Any) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    resp = send_order(order)
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "NOTHING_TO_SEND"


def test_second_round_only_sends_new_pending(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any, main_product: Any, send_order: Any) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    order = send_order(order).json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    order = send_order(order).json()
    assert len(order["rounds"]) == 2
    assert [r["round_no"] for r in order["rounds"]] == [1, 2]


def test_kitchen_view_disabled_no_send(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any, add_items: Any, main_product: Any, send_order: Any) -> None:
    set_feature("kitchen.view", False)
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    resp = send_order(order)
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
    assert order["kitchen_view_enabled"] is False  # snapshot al crear


def test_daily_count_hits_zero_marks_unavailable_in_catalog_and_void_does_not_restore(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any, add_items: Any, main_product: Any, send_order: Any, db: Any
) -> None:
    """Dueño VOS (`backend-comanda`): contador 2 -> dos envíos -> `available=false`
    reflejado en `GET /catalog`; un `void` posterior no lo repone."""
    set_feature("pos.daily_count", True)
    open_shift()
    identify(device_client, employees["operator"])
    main_product.daily_count = 2
    main_product.daily_remaining = 2
    db.commit()

    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    order = send_order(order).json()

    catalog = device_client.get("/api/v1/catalog").json()
    product_out = next(p for p in catalog["products"] if p["id"] == main_product.id)
    assert product_out["available"] is True
    assert product_out["daily_remaining"] == 1

    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    order = send_order(order).json()

    catalog2 = device_client.get("/api/v1/catalog").json()
    product_out2 = next(p for p in catalog2["products"] if p["id"] == main_product.id)
    assert product_out2["available"] is False
    assert product_out2["daily_remaining"] == 0

    # Anular uno de los ítems enviados NO repone `daily_remaining` ni `available`.
    sent_item = next(i for i in order["items"] if i["status"] == "sent")
    void_resp = device_client.post(
        f"/api/v1/orders/{order['id']}/items/{sent_item['id']}/void",
        json={"expected_version": order["version"], "reason": "kitchen_error", "authorizer_pin": "9999"},
    )
    assert void_resp.status_code == 200, void_resp.text

    catalog3 = device_client.get("/api/v1/catalog").json()
    product_out3 = next(p for p in catalog3["products"] if p["id"] == main_product.id)
    assert product_out3["available"] is False
    assert product_out3["daily_remaining"] == 0

    # El stub de merma queda creado, sin insumo (este producto no tiene
    # ficha), y RESUELTO (pedido 2a, `app.orders.service._resolve_waste_stub`):
    # `resolved=True` significa "se buscó contra el libro", no "se encontró
    # un insumo" — un producto sin ficha no descuenta nada, así que no hay
    # insumo que atribuir, pero la resolución sí corrió. Nunca repone.
    from app.orders.models import WasteStub

    stubs = db.query(WasteStub).filter(WasteStub.order_item_id == sent_item["id"]).all()
    assert len(stubs) == 1
    assert stubs[0].ingredient_id is None
    assert stubs[0].resolved is True
