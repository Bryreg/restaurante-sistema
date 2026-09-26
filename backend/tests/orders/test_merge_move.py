"""`POST /orders/{id}/merge` y `/move`: mover ítems y mesas completos (nunca
ítems sueltos), `MERGE_SAME_ORDER`, `MERGE_NOT_OPEN`, `TABLE_ALREADY_OPEN`."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.orders.conftest import idem_headers


def test_merge_same_order(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any) -> None:
    set_feature("pos.tables", True)
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    resp = device_client.post(f"/api/v1/orders/{order['id']}/merge", json={"expected_version": order["version"], "from_order_id": order["id"]})
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "MERGE_SAME_ORDER"


def test_merge_not_open(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any) -> None:
    set_feature("pos.tables", True)
    open_shift()
    identify(device_client, employees["operator"])
    order_a = new_order().json()
    order_b = new_order().json()
    void_b = device_client.post(f"/api/v1/orders/{order_b['id']}/void", json={"expected_version": order_b["version"], "reason": "duplicate"})
    assert void_b.status_code == 200, void_b.text

    resp = device_client.post(f"/api/v1/orders/{order_a['id']}/merge", json={"expected_version": order_a["version"], "from_order_id": order_b["id"]})
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "MERGE_NOT_OPEN"


def test_merge_moves_all_items_and_marks_source(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any, add_items: Any, main_product: Any, drink_product: Any) -> None:
    set_feature("pos.tables", True)
    open_shift()
    identify(device_client, employees["operator"])
    order_a = new_order().json()
    order_a = add_items(order_a, [{"product_id": main_product.id, "qty": 1}]).json()
    order_b = new_order().json()
    order_b = add_items(order_b, [{"product_id": drink_product.id, "qty": 2}]).json()

    resp = device_client.post(f"/api/v1/orders/{order_a['id']}/merge", json={"expected_version": order_a["version"], "from_order_id": order_b["id"]})
    assert resp.status_code == 200, resp.text
    merged = resp.json()
    assert {i["name"] for i in merged["items"]} == {"Bandeja Paisa", "Gaseosa"}
    assert merged["totals"]["total"] == main_product.price_dine_in + 2 * drink_product.price_dine_in

    source = device_client.get(f"/api/v1/orders/{order_b['id']}").json()
    assert source["status"] == "merged"
    assert source["merged_into_order_id"] == order_a["id"]
    assert source["items"] == []  # sus ítems se movieron a la destino


def test_move_table_already_open(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any, tables: Any) -> None:
    set_feature("pos.tables", True)
    open_shift()
    identify(device_client, employees["operator"])
    order_a = new_order(channel="dine_in", table_ids=[tables[0].id]).json()
    new_order(channel="dine_in", table_ids=[tables[1].id])  # mesa 2 ocupada

    resp = device_client.post(f"/api/v1/orders/{order_a['id']}/move", json={"expected_version": order_a["version"], "table_ids": [tables[1].id]})
    assert resp.status_code == 409, resp.text
    assert resp.json()["error"]["code"] == "TABLE_ALREADY_OPEN"


def test_move_releases_previous_table(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any, tables: Any) -> None:
    set_feature("pos.tables", True)
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order(channel="dine_in", table_ids=[tables[0].id]).json()

    resp = device_client.post(f"/api/v1/orders/{order['id']}/move", json={"expected_version": order["version"], "table_ids": [tables[2].id]})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert {t["id"] for t in body["tables"]} == {tables[2].id}

    status = device_client.get("/api/v1/tables/status").json()
    by_id = {t["id"]: t for zone in status["zones"] for t in zone["tables"]}
    assert by_id[tables[0].id]["status"] == "free"
    assert by_id[tables[2].id]["status"] == "occupied"


def test_tables_status_counts_the_dishes_ready_to_serve(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any,
    new_order: Any, add_items: Any, main_product: Any, send_order: Any, tables: Any,
) -> None:
    """El mapa de mesas dice cuántos platos están listos para llevar: cocina
    los marca, el mesero los ve sin abrir la comanda, y al servirlos el
    conteo baja."""
    set_feature("pos.tables", True)
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order(channel="dine_in", table_ids=[tables[0].id]).json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}, {"product_id": main_product.id, "qty": 2, "note": "sin sal"}]).json()
    order = send_order(order).json()

    def ready_count() -> int:
        status = device_client.get("/api/v1/tables/status").json()
        by_id = {t["id"]: t for z in status["zones"] for t in z["tables"]}
        assert by_id[tables[1].id]["ready_count"] == 0  # mesa libre
        return by_id[tables[0].id]["ready_count"]

    assert ready_count() == 0
    item_ids = [i["id"] for i in order["items"]]
    for item_id in item_ids:
        resp = device_client.post(f"/api/v1/orders/{order['id']}/items/{item_id}/ready", headers=idem_headers())
        assert resp.status_code == 200, resp.text
    assert ready_count() == 2

    served = device_client.post(f"/api/v1/orders/{order['id']}/items/{item_ids[0]}/served", headers=idem_headers())
    assert served.status_code == 200, served.text
    assert ready_count() == 1


def test_tables_status_counts_unsent_units_and_names_who_opened(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any,
    new_order: Any, add_items: Any, main_product: Any, send_order: Any, tables: Any,
) -> None:
    """«3 sin enviar» en el mapa: unidades pendientes (no líneas), que bajan a
    cero al enviar. La tarjeta dice quién abrió la mesa (iniciales y el
    filtro «Mis mesas»); una mesa libre no trae a nadie."""
    set_feature("pos.tables", True)
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order(channel="dine_in", table_ids=[tables[0].id]).json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}, {"product_id": main_product.id, "qty": 2, "note": "sin sal"}]).json()

    def table_row(table_id: int) -> dict[str, Any]:
        status = device_client.get("/api/v1/tables/status").json()
        by_id: dict[int, dict[str, Any]] = {t["id"]: t for z in status["zones"] for t in z["tables"]}
        return by_id[table_id]

    free = table_row(tables[1].id)
    assert free["unsent_count"] == 0
    assert free["opened_by"] is None

    busy = table_row(tables[0].id)
    assert busy["unsent_count"] == 3
    assert busy["opened_by"] == {"id": employees["operator"].id, "name": employees["operator"].name}

    order = send_order(order).json()
    assert table_row(tables[0].id)["unsent_count"] == 0
