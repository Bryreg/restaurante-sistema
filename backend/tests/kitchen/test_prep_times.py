"""Tiempo promedio de cocina por estación en Hoy (auditoría p4).

De «Enviar» a «Listo», por estación, sobre los platos del día operativo; el
lado malo (`outside`) lo decide el servidor con el mismo objetivo por
estación del semáforo del KDS. Con «Cocina» apagada viaja `null`."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient


def _send_and_ready_after(
    device_client: TestClient, identify: Any, operator: Any, new_order: Any, add_items: Any, send_order: Any, clock: Any, product: Any, minutes: int, key: str
) -> None:
    # La sesión de la persona vence con el reloj: se identifica cada vez.
    identify(device_client, operator)
    order = new_order().json()
    order = add_items(order, [{"product_id": product.id, "qty": 1}]).json()
    order = send_order(order).json()
    item_id = order["items"][0]["id"]
    clock.advance(minutes=minutes)
    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/items/{item_id}/ready", headers={"Idempotency-Key": key}
    )
    assert resp.status_code == 200, resp.text


def test_today_publishes_average_prep_time_per_station(
    device_client: TestClient,
    admin_client: TestClient,
    identify: Any,
    employees: Any,
    open_shift: Any,
    new_order: Any,
    add_items: Any,
    main_product: Any,
    send_order: Any,
    clock: Any,
    store: Any,
    db: Any,
) -> None:
    from app.stores import service as stores_service

    settings = stores_service.get_sales_settings(db, store.id)
    settings.station_target_minutes = {"hot_kitchen": 10}
    db.commit()

    open_shift()
    identify(device_client, employees["operator"])
    today = admin_client.get("/api/v1/admin/today", params={"store_id": store.id}).json()
    # Nada listo todavía: la estación no aparece (no hay promedio, no un 0).
    assert today["kitchen_prep_by_station"] == []

    _send_and_ready_after(device_client, identify, employees["operator"], new_order, add_items, send_order, clock, main_product, 8, "prep-1")
    _send_and_ready_after(device_client, identify, employees["operator"], new_order, add_items, send_order, clock, main_product, 13, "prep-2")

    today = admin_client.get("/api/v1/admin/today", params={"store_id": store.id}).json()
    rows = {r["station"]: r for r in today["kitchen_prep_by_station"]}
    hot = rows[main_product.station]
    assert hot["items"] == 2
    assert hot["avg_seconds"] == (8 * 60 + 13 * 60) // 2
    assert hot["target_minutes"] == 10
    assert hot["outside"] is True  # 10,5 min contra un objetivo de 10


def test_today_kitchen_prep_is_null_with_kitchen_off(
    admin_client: TestClient, store: Any, set_feature: Any
) -> None:
    set_feature("kitchen.view", False)
    set_feature("kitchen.kds", False)
    today = admin_client.get("/api/v1/admin/today", params={"store_id": store.id})
    assert today.status_code == 200, today.text
    assert today.json()["kitchen_prep_by_station"] is None
