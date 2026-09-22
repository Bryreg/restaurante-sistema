"""`POST /orders/{id}/merge` y `/move`: mover ítems y mesas completos (nunca
ítems sueltos), `MERGE_SAME_ORDER`, `MERGE_NOT_OPEN`, `TABLE_ALREADY_OPEN`."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient


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


def test_el_contador_de_cocina_del_pie_cuenta_comandas_no_renglones_del_riel(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    new_order: Any, add_items: Any, main_product: Any, drink_product: Any, send_order: Any,
) -> None:
    """`summary.kitchen_pending`: el número del pie del salón.

    Lo cuenta el SERVIDOR porque el plano no publica el estado de cada
    renglón. La pantalla lo contaba sobre lo único que tenía a mano —el riel
    de canales— y decía «Cocina · 2 pendientes» con nueve comandas en la
    plancha: un contador que le erra por siete no sirve para lo único que
    está, que es decidir si vale la pena caminar hasta la cocina.

    Y son COMANDAS, no renglones: dos platos de la misma mesa son un solo
    viaje.
    """
    open_shift()
    identify(device_client, employees["operator"])

    def resumen() -> dict[str, Any]:
        resp = device_client.get("/api/v1/tables/status")
        assert resp.status_code == 200, resp.text
        return resp.json()["summary"]

    assert resumen()["kitchen_pending"] == 0

    # Una comanda con DOS platos de cocina: sigue siendo un solo viaje.
    order = new_order().json()
    order = add_items(order, [
        {"product_id": main_product.id, "qty": 1},
        {"product_id": main_product.id, "qty": 1},
    ]).json()
    send_order(order)
    assert resumen()["kitchen_pending"] == 1

    # Una bebida sin estación pasa directo a `served`: no es un viaje a
    # cocina y no suma.
    otra = new_order().json()
    otra = add_items(otra, [{"product_id": drink_product.id, "qty": 1}]).json()
    send_order(otra)
    assert resumen()["kitchen_pending"] == 1
