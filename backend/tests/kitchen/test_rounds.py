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


def test_kitchen_rounds_ignora_comandas_cobradas_y_de_otro_dia(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any,
    add_items: Any, main_product: Any, send_order: Any, db: Any,
) -> None:
    """La plancha muestra lo que se está cocinando AHORA, no el historial.

    Dos cortes, y cada uno tapa un agujero distinto:

    - **Comanda cobrada.** Nada obliga a marcar «servido» antes de cobrar —el
      mesero cobra y sigue—, así que los ítems quedan en `sent` para siempre.
      Sin este corte, la base de demostración mostraba 3.086 comandas cobradas
      encima de las 11 vivas, todas rotuladas «Demorado · 1081 h».
    - **Otro día operativo.** Una mesa que nadie cerró anoche no puede seguir
      en la pantalla de la plancha mañana. Sigue abierta y `GET /admin/today`
      la cuenta y la alerta; lo que no hace es estorbar acá.
    """
    from app.orders.models import Order, OrderStatus

    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    order = send_order(order).json()

    assert len(device_client.get("/api/v1/kitchen/rounds").json()) == 1

    fila = db.get(Order, order["id"])
    dia = fila.business_date

    # 1 · Cobrada: desaparece de la plancha.
    fila.status = OrderStatus.PAID
    db.commit()
    assert device_client.get("/api/v1/kitchen/rounds").json() == []

    # 2 · Viva otra vez, pero de ayer: tampoco aparece.
    from datetime import timedelta

    fila.status = OrderStatus.OPEN
    fila.business_date = dia - timedelta(days=1)
    db.commit()
    assert device_client.get("/api/v1/kitchen/rounds").json() == []

    # 3 · Viva y de hoy: vuelve. (Si este no volviera, los dos de arriba
    #     pasarían por una pantalla rota en vez de por el filtro.)
    fila.business_date = dia
    db.commit()
    assert len(device_client.get("/api/v1/kitchen/rounds").json()) == 1
