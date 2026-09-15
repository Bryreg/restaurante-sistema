"""`GET /admin/orders` ampliado (spec.md «Admin reports»): tiempos de mesa,
cocina p50/p90 por estación, cuenta→cobro, medio de pago con que cerró,
cortesías a precio de lista, `sent_at_payment_ratio`. Cuidado especial con
comandas unidas (`merge`): los tiempos de cocina se leen de `OrderItem.
sent_at`/`ready_at` (columnas del propio ítem, que sí viajan con `merge_
orders`), no de `OrderRound` (que es lo que NO viaja, y no es lo que este
reporte usa)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi.testclient import TestClient

from tests.orders.conftest import idem_headers


def _send_and_ready(device_client: TestClient, order: dict[str, Any], clock: Any, *, minutes: int) -> dict[str, Any]:
    """Envía la comanda (una ronda con todos los `pending`) y marca `ready`
    el primer ítem tras `minutes` minutos."""
    sent = device_client.post(f"/api/v1/orders/{order['id']}/send", json={"expected_version": order["version"]}, headers=idem_headers())
    assert sent.status_code == 200, sent.text
    order = sent.json()
    item_id = order["items"][0]["id"]
    clock.advance(minutes=minutes)
    ready = device_client.post(f"/api/v1/orders/{order['id']}/items/{item_id}/ready", headers=idem_headers())
    assert ready.status_code == 200, ready.text
    return ready.json()


def test_kitchen_p50_p90_by_station(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any,
    add_items: Any, main_product: Any, clock: Any, store: Any,
) -> None:
    clock.set(datetime(2026, 2, 1, 15, 0, tzinfo=timezone.utc))
    open_shift()
    identify(device_client, employees["operator"])

    # Tres comandas, tres tiempos de cocina distintos (5, 10 y 15 minutos)
    # sobre la MISMA estación ("hot_kitchen"): p50 = el del medio, p90 = el
    # mayor (nearest-rank sobre 3 muestras).
    for minutes in (5, 10, 15):
        identify(device_client, employees["operator"])  # renueva la ventana antes de cada ronda
        order = new_order().json()
        order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
        _send_and_ready(device_client, order, clock, minutes=minutes)

    resp = admin_client.get("/api/v1/admin/orders", params={"store_id": store.id, "from": "2026-02-01", "to": "2026-02-01"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    stations = {row["station"]: row for row in body["kitchen_times_by_station"]}
    assert "hot_kitchen" in stations
    hot = stations["hot_kitchen"]
    assert hot["samples"] == 3
    assert hot["p50_seconds"] == 10 * 60
    assert hot["p90_seconds"] == 15 * 60


def test_kitchen_times_survive_a_merge(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any,
    new_order: Any, add_items: Any, main_product: Any, clock: Any, store: Any,
) -> None:
    """El gap declarado de 1b-1 ("tras unir comandas las rondas históricas de
    la origen no se listan en la destino") es sobre `OrderOut.rounds`
    (presentación), no sobre este cálculo: `sent_at`/`ready_at` son columnas
    del propio `OrderItem`, que SÍ se reasignan a la comanda destino en
    `merge_orders` (`UPDATE order_items SET order_id = :dest ...`)."""
    set_feature("pos.tables", True)
    clock.set(datetime(2026, 2, 2, 15, 0, tzinfo=timezone.utc))
    open_shift()
    identify(device_client, employees["operator"])

    source = new_order().json()
    source = add_items(source, [{"product_id": main_product.id, "qty": 1}]).json()
    source = _send_and_ready(device_client, source, clock, minutes=6)

    # La ventana deslizante de la persona (`EMPLOYEE_SESSION_MINUTES`,
    # default 3 min) ya expiró tras los 6 minutos de arriba: identificarse
    # de nuevo antes de la siguiente acción de operador.
    identify(device_client, employees["operator"])
    dest = new_order().json()

    merge_resp = device_client.post(
        f"/api/v1/orders/{dest['id']}/merge", json={"expected_version": dest["version"], "from_order_id": source["id"]}
    )
    assert merge_resp.status_code == 200, merge_resp.text
    dest = merge_resp.json()
    assert dest["items"][0]["ready_at"] is not None  # el snapshot de tiempos viajó con el ítem

    resp = admin_client.get("/api/v1/admin/orders", params={"store_id": store.id, "from": "2026-02-02", "to": "2026-02-02"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    stations = {row["station"]: row for row in body["kitchen_times_by_station"]}
    assert stations["hot_kitchen"]["samples"] == 1
    assert stations["hot_kitchen"]["p50_seconds"] == 6 * 60

    rows_by_id = {row["id"]: row for row in body["rows"]}
    assert rows_by_id[dest["id"]]["items_count"] == 1
    assert rows_by_id[source["id"]]["items_count"] == 0  # se fueron a la destino


def test_row_has_table_minutes_bill_to_paid_and_payment_method(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any,
    add_items: Any, drink_product: Any, store: Any,
) -> None:
    open_shift()
    identify(device_client, employees["cashier"])  # `can_charge=True` (fixtures de `tests/conftest.py`)
    order = new_order().json()
    order = add_items(order, [{"product_id": drink_product.id, "qty": 1}]).json()

    total = order["totals"]["total"]
    pay_body: dict[str, Any] = {"pin": "1111", "splits": [{"method": "cash", "amount": total, "tendered": total}]}
    if order.get("tip") is not None:
        pay_body["tip"] = {"asked": True, "accepted": False, "modified": False, "amount": 0}
    pay_resp = device_client.post(f"/api/v1/orders/{order['id']}/payments", json=pay_body, headers=idem_headers())
    assert pay_resp.status_code == 201, pay_resp.text

    resp = admin_client.get("/api/v1/admin/orders", params={"store_id": store.id})
    assert resp.status_code == 200, resp.text
    row = next(r for r in resp.json()["rows"] if r["id"] == order["id"])
    assert row["payment_methods"] == ["cash"]
    assert row["table_minutes"] is not None  # `closed_at` quedó seteado al cobrar
    assert row["sent_at_payment_ratio"] == 1.0  # único ítem, cobrado con pendientes
