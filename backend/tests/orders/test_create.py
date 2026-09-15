"""`POST /orders`: flags por canal, turno abierto, mesas, staff_meal y la
carrera de dos aperturas de la misma mesa (`race_env`, único fixture para
concurrencia con hilos — CONTRATO-INTERNO-1b-1.md §1 y §3)."""

from __future__ import annotations

import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from fastapi.testclient import TestClient

from tests.orders.conftest import idem_headers


def test_counter_requires_feature_flag(device_client: TestClient, identify: Any, employees: Any, set_feature: Any, open_shift: Any) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    set_feature("pos.counter", False)
    resp = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem_headers())
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
    assert resp.json()["error"]["extra"] if "extra" in resp.json()["error"] else True


def test_counter_without_open_shift(device_client: TestClient, identify: Any, employees: Any) -> None:
    identify(device_client, employees["operator"])
    resp = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem_headers())
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "NO_OPEN_SHIFT"
    assert "turno" in resp.json()["error"]["message"].lower()


def test_counter_creates_open_order(device_client: TestClient, identify: Any, employees: Any, open_shift: Any) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    resp = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem_headers())
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["status"] == "open"
    assert body["version"] == 1
    assert body["channel"] == "counter"
    assert body["opened_by"]["name"] == "Operator"
    assert body["totals"]["total"] == 0
    assert body["kitchen_view_enabled"] is True  # perfil "full": todo encendido


def test_channel_disabled_when_not_active_for_store(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, store: Any, db: Any) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    store.active_channels = ["counter"]  # sin dine_in ni takeout
    db.commit()
    resp = device_client.post("/api/v1/orders", json={"channel": "takeout", "takeout": {"customer_name": "Ana"}}, headers=idem_headers())
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "CHANNEL_DISABLED"


def test_dine_in_requires_table_ids(device_client: TestClient, identify: Any, employees: Any, open_shift: Any) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    resp = device_client.post("/api/v1/orders", json={"channel": "dine_in"}, headers=idem_headers())
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "TABLE_REQUIRED"


def test_dine_in_opens_table_and_defaults_covers(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, tables: Any) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    table_ids = [tables[0].id, tables[1].id]
    resp = device_client.post("/api/v1/orders", json={"channel": "dine_in", "table_ids": table_ids}, headers=idem_headers())
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["covers"] == 8  # Σ seats de las dos mesas (4 + 4)
    assert {t["id"] for t in body["tables"]} == set(table_ids)


def test_table_already_open_by_check(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, tables: Any) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    table_id = tables[0].id
    first = device_client.post("/api/v1/orders", json={"channel": "dine_in", "table_ids": [table_id]}, headers=idem_headers())
    assert first.status_code == 201, first.text
    second = device_client.post("/api/v1/orders", json={"channel": "dine_in", "table_ids": [table_id]}, headers=idem_headers())
    assert second.status_code == 409, second.text
    assert second.json()["error"]["code"] == "TABLE_ALREADY_OPEN"
    assert second.json()["error"]["table_id"] == table_id


def test_staff_meal_requires_consumer_and_freezes_price(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, main_product: Any) -> None:
    open_shift()
    identify(device_client, employees["operator"])

    missing = device_client.post("/api/v1/orders", json={"channel": "staff_meal"}, headers=idem_headers())
    assert missing.status_code == 400, missing.text
    assert missing.json()["error"]["code"] == "STAFF_MEAL_CONSUMER_REQUIRED"

    ok = device_client.post(
        "/api/v1/orders", json={"channel": "staff_meal", "consumed_by_employee_id": employees["operator2"].id}, headers=idem_headers()
    )
    assert ok.status_code == 201, ok.text
    order = ok.json()
    assert order["consumed_by"]["id"] == employees["operator2"].id

    add = device_client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={"expected_version": order["version"], "items": [{"product_id": main_product.id, "qty": 1}]},
        headers=idem_headers(),
    )
    assert add.status_code == 200, add.text
    item = add.json()["items"][0]
    assert item["unit_price"] == 0
    assert item["list_price"] == main_product.price_dine_in
    assert item["tax_rate"] == 0
    assert add.json()["tip"] is None


def test_dine_in_table_race_one_wins_one_conflicts(race_env: Any) -> None:
    """Dos aperturas concurrentes de la MISMA mesa: una 201, otra 409
    (índice único parcial como respaldo del chequeo previo). Corre sobre
    `race_env`, la única fixture válida para concurrencia con hilos."""
    from app.stores.models import Table, Zone

    with race_env.session_factory() as db:
        zone = Zone(store_id=race_env.store_id, name="Salón", sort_order=1, active=True)
        db.add(zone)
        db.flush()
        table = Table(zone_id=zone.id, store_id=race_env.store_id, number="1", seats=4, active=True)
        db.add(table)
        db.commit()
        table_id = table.id

    # `active_channels` de `race_env` es sólo `["counter"]`: dine_in necesita
    # el canal activo en la sede además del flag.
    with race_env.session_factory() as db2:
        from app.stores.models import Store

        store = db2.get(Store, race_env.store_id)
        store.active_channels = ["counter", "dine_in"]
        db2.commit()

    race_env.open_shift()

    def _create() -> int:
        resp = race_env.client.post(
            "/api/v1/orders",
            json={"channel": "dine_in", "table_ids": [table_id]},
            headers={"Idempotency-Key": str(uuid.uuid4())},
        )
        return resp.status_code

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _: _create(), range(2)))

    assert sorted(results) == [201, 409]
