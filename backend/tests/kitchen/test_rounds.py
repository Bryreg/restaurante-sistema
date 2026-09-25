"""`GET /kitchen/rounds`: filtro por estación, semáforo con `clock`, `ready`
idempotente (`CONTRATO-INTERNO-1b-1.md §2.4` «Cocina»)."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient


def test_kitchen_rounds_only_sent_and_ready_filtered_by_station(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any, main_product: Any, drink_product: Any, send_order: Any
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}, {"product_id": drink_product.id, "qty": 1}]).json()
    order = send_order(order).json()

    all_rounds = device_client.get("/api/v1/kitchen/rounds").json()
    assert len(all_rounds) == 1
    round_entry = all_rounds[0]
    assert round_entry["round_no"] == 1
    # La gaseosa (sin estación) pasó directo a `served`: nunca aparece acá.
    names = {i["name"] for i in round_entry["items"]}
    assert names == {"Bandeja Paisa"}
    assert round_entry["items"][0]["status"] == "sent"

    filtered = device_client.get("/api/v1/kitchen/rounds", params={"station": "hot_kitchen"}).json()
    assert len(filtered) == 1

    empty = device_client.get("/api/v1/kitchen/rounds", params={"station": "bar"}).json()
    assert empty == []


def test_kitchen_rounds_semaphore_with_clock(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any, add_items: Any, main_product: Any, send_order: Any, clock: Any, store: Any, db: Any
) -> None:
    from app.stores import service as stores_service

    settings = stores_service.get_sales_settings(db, store.id)
    settings.course_target_minutes = {"main": 10}
    db.commit()

    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    order = send_order(order).json()

    green = device_client.get("/api/v1/kitchen/rounds").json()
    item = green[0]["items"][0]
    assert item["target_minutes"] == 10
    assert item["semaphore"] == "green"

    clock.advance(minutes=12)  # >= target, < 1.5x target (15)
    amber = device_client.get("/api/v1/kitchen/rounds").json()
    assert amber[0]["items"][0]["semaphore"] == "amber"

    clock.advance(minutes=10)  # total 22 min >= 1.5x target
    red = device_client.get("/api/v1/kitchen/rounds").json()
    assert red[0]["items"][0]["semaphore"] == "red"


def test_ready_is_idempotent_and_removes_from_kitchen_when_served(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any, main_product: Any, send_order: Any
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    order = send_order(order).json()
    item_id = order["items"][0]["id"]

    from tests.orders.conftest import idem_headers

    first = device_client.post(f"/api/v1/orders/{order['id']}/items/{item_id}/ready", headers=idem_headers())
    assert first.status_code == 200, first.text
    assert first.json()["items"][0]["status"] == "ready"

    still_ready = device_client.post(f"/api/v1/orders/{order['id']}/items/{item_id}/ready", headers=idem_headers())
    assert still_ready.status_code == 200, still_ready.text
    assert still_ready.json()["items"][0]["status"] == "ready"  # idempotente, sin cambio

    rounds_after_ready = device_client.get("/api/v1/kitchen/rounds").json()
    assert rounds_after_ready[0]["items"][0]["status"] == "ready"

    served = device_client.post(f"/api/v1/orders/{order['id']}/items/{item_id}/served", headers=idem_headers())
    assert served.status_code == 200, served.text

    rounds_after_served = device_client.get("/api/v1/kitchen/rounds").json()
    assert rounds_after_served == []  # servido: nunca aparece en cocina


def test_an_item_without_a_course_target_uses_its_station_target_and_goes_red(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any,
    main_product: Any, send_order: Any, clock: Any, store: Any, db: Any,
) -> None:
    """El semáforo mentía: sin objetivo de curso, un plato quedaba «A
    tiempo» aunque llevara 66 h. Ahora cae al objetivo de su estación
    (cocina caliente: 15 min)."""
    from app.stores import service as stores_service

    settings = stores_service.get_sales_settings(db, store.id)
    settings.course_target_minutes = {}
    db.commit()

    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    send_order(order)

    item = device_client.get("/api/v1/kitchen/rounds").json()[0]["items"][0]
    assert item["target_minutes"] == 15
    assert item["semaphore"] == "green"

    clock.advance(hours=66)
    item = device_client.get("/api/v1/kitchen/rounds").json()[0]["items"][0]
    assert item["semaphore"] == "red", "66 h de espera no pueden verse «A tiempo»"


def test_station_default_targets() -> None:
    from app.kitchen.service import target_minutes_for

    assert target_minutes_for({}, course="beverage", station="bar") == 5
    assert target_minutes_for({}, course="main", station="hot_kitchen") == 15
    assert target_minutes_for({}, course="starter", station="cold_kitchen") == 10
    assert target_minutes_for({}, course="main", station="parrilla") == 12
    # El objetivo del curso, si está configurado, sigue mandando.
    assert target_minutes_for({"main": 18}, course="main", station="hot_kitchen") == 18


def test_a_round_from_a_previous_business_day_is_marked_stale(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any,
    main_product: Any, send_order: Any, clock: Any,
) -> None:
    """Un turno abandonado deja comandas vivas de otro día: el KDS las marca
    «de ayer» (`stale`) para apartarlas de la cola de hoy."""
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    send_order(order)

    fresh = device_client.get("/api/v1/kitchen/rounds").json()
    assert fresh[0]["stale"] is False

    clock.advance(days=2)
    identify(device_client, employees["operator"])
    old = device_client.get("/api/v1/kitchen/rounds").json()
    assert [r["order_id"] for r in old] == [order["id"]], "la comanda viva de otro día sigue a la vista"
    assert old[0]["stale"] is True
