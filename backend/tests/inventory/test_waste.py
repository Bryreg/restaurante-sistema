"""`POST /waste` (dispositivo, `Idempotency-Key`) y `GET /admin/waste`,
detrás de `inventory.waste`. No existe `staff_meal` como tipo de merma: eso
es un canal de comanda, territorio de `orders`."""

from __future__ import annotations

from typing import Any, Callable
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.models import Employee
from app.inventory.models import Ingredient, WasteType
from app.notifications.models import Notification
from app.stores.models import Store


def test_waste_type_enum_has_no_staff_meal() -> None:
    assert "staff_meal" not in {t.value for t in WasteType}


def test_post_waste_requires_inventory_waste_flag(
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Employee],
    set_feature: Callable[..., None],
    create_ingredient: Callable[..., dict[str, Any]],
) -> None:
    ingredient = create_ingredient()
    identify(device_client, employees["operator"])
    set_feature("inventory.waste", False)
    resp = device_client.post(
        "/api/v1/waste",
        json={"ingredient_id": ingredient["id"], "qty": "1", "type": "breakage", "employee_pin": "2222"},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"


def test_post_waste_happy_path_reduces_stock_and_records_movement(
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]],
    db: Session,
) -> None:
    ingredient = create_ingredient(official_cost="10")
    identify(device_client, employees["operator"])

    resp = device_client.post(
        "/api/v1/waste",
        json={
            "ingredient_id": ingredient["id"],
            "qty": "2.5",
            "type": "breakage",
            "note": "se cayó",
            "employee_pin": "2222",  # PIN del operador (KNOWN_PINS["Operator"])
        },
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["qty"] == "2.5"
    assert body["type"] == "breakage"
    assert "cost" not in body  # el operador no recibe costos (WasteOut, ruta de dispositivo)

    row = db.execute(select(Ingredient).where(Ingredient.id == ingredient["id"])).scalar_one()
    from app.inventory import hooks

    stock = hooks.current_stock(db, store_id=row.store_id, ingredient_id=row.id)
    assert stock == -2500  # 2,5 g en milésimas, con signo negativo


def test_post_waste_records_movement_with_waste_cause_and_cost(
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]],
    admin_client: TestClient,
) -> None:
    ingredient = create_ingredient(official_cost="10")
    identify(device_client, employees["operator"])
    device_client.post(
        "/api/v1/waste",
        json={"ingredient_id": ingredient["id"], "qty": "1", "type": "expired", "employee_pin": "2222"},
        headers={"Idempotency-Key": str(uuid4())},
    )
    movements = admin_client.get(f"/api/v1/admin/ingredients/{ingredient['id']}/movements").json()
    assert len(movements) == 1
    assert movements[0]["cause"] == "waste"
    assert movements[0]["qty_base"] == "-1"
    assert movements[0]["cost"] == "10"
    assert movements[0]["cost_source"] == "official"
    assert movements[0]["ref_type"] == "waste"


def test_post_waste_requires_valid_responsible_pin(
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]],
) -> None:
    ingredient = create_ingredient()
    identify(device_client, employees["operator"])
    resp = device_client.post(
        "/api/v1/waste",
        json={"ingredient_id": ingredient["id"], "qty": "1", "type": "breakage", "employee_pin": "0000"},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "AUTHORIZATION_INVALID"


def test_post_waste_responsible_can_differ_from_identified_device_operator(
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]],
) -> None:
    """El responsable de la merma se verifica por PIN propio en el payload,
    no necesariamente el operador identificado en el dispositivo (igual que
    `RosterActionIn` en `shifts`)."""
    ingredient = create_ingredient()
    identify(device_client, employees["operator"])  # PIN 2222
    resp = device_client.post(
        "/api/v1/waste",
        json={
            "ingredient_id": ingredient["id"],
            "qty": "1",
            "type": "breakage",
            "employee_pin": "3333",  # PIN de "operator2", no del identificado
        },
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["employee_id"] == employees["operator2"].id


def test_post_waste_requires_idempotency_key(
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]],
) -> None:
    ingredient = create_ingredient()
    identify(device_client, employees["operator"])
    resp = device_client.post(
        "/api/v1/waste",
        json={"ingredient_id": ingredient["id"], "qty": "1", "type": "breakage", "employee_pin": "2222"},
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "IDEMPOTENCY_KEY_REQUIRED"


def test_post_waste_replays_with_same_key_without_duplicating_movement(
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]],
    admin_client: TestClient,
) -> None:
    ingredient = create_ingredient()
    identify(device_client, employees["operator"])
    payload = {"ingredient_id": ingredient["id"], "qty": "1", "type": "breakage", "employee_pin": "2222"}
    key = str(uuid4())

    first = device_client.post("/api/v1/waste", json=payload, headers={"Idempotency-Key": key})
    second = device_client.post("/api/v1/waste", json=payload, headers={"Idempotency-Key": key})
    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json() == second.json()

    movements = admin_client.get(f"/api/v1/admin/ingredients/{ingredient['id']}/movements").json()
    assert len(movements) == 1


def test_post_waste_same_key_different_body_is_a_mismatch(
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]],
) -> None:
    ingredient = create_ingredient()
    identify(device_client, employees["operator"])
    key = str(uuid4())
    device_client.post(
        "/api/v1/waste",
        json={"ingredient_id": ingredient["id"], "qty": "1", "type": "breakage", "employee_pin": "2222"},
        headers={"Idempotency-Key": key},
    )
    resp = device_client.post(
        "/api/v1/waste",
        json={"ingredient_id": ingredient["id"], "qty": "2", "type": "breakage", "employee_pin": "2222"},
        headers={"Idempotency-Key": key},
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "IDEMPOTENCY_MISMATCH"


def test_admin_waste_list_requires_inventory_waste_flag(
    admin_client: TestClient, store: Store, set_feature: Callable[..., None]
) -> None:
    set_feature("inventory.waste", False)
    resp = admin_client.get(f"/api/v1/admin/waste?store_id={store.id}")
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"


def test_admin_waste_list_shows_cost_and_weekly_kpi_is_null_not_zero(
    device_client: TestClient,
    admin_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]],
    store: Store,
) -> None:
    ingredient = create_ingredient(official_cost="7")
    identify(device_client, employees["operator"])
    device_client.post(
        "/api/v1/waste",
        json={"ingredient_id": ingredient["id"], "qty": "1", "type": "expired", "employee_pin": "2222"},
        headers={"Idempotency-Key": str(uuid4())},
    )
    resp = admin_client.get(f"/api/v1/admin/waste?store_id={store.id}")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["items"]) == 1
    assert body["items"][0]["cost"] == "7"
    assert body["weekly_kpi"]["ratio"] is None
    assert body["weekly_kpi"]["label"] == "sin datos"


def test_waste_spike_notifies_when_this_week_exceeds_1_5x_previous_week(
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]],
    db: Session,
    clock: Any,
    store: Store,
) -> None:
    from datetime import datetime, timezone

    ingredient = create_ingredient(official_cost="1")

    clock.set(datetime(2026, 3, 2, 15, 0, tzinfo=timezone.utc))  # semana "anterior"
    identify(device_client, employees["operator"])
    resp1 = device_client.post(
        "/api/v1/waste",
        json={"ingredient_id": ingredient["id"], "qty": "1", "type": "expired", "employee_pin": "2222"},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert resp1.status_code == 201, resp1.text

    clock.set(datetime(2026, 3, 9, 15, 0, tzinfo=timezone.utc))  # 7 días después: semana "esta"
    identify(device_client, employees["operator"])
    resp2 = device_client.post(
        "/api/v1/waste",
        json={"ingredient_id": ingredient["id"], "qty": "2", "type": "expired", "employee_pin": "2222"},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert resp2.status_code == 201, resp2.text

    rows = db.execute(
        select(Notification).where(Notification.type == "waste_spike", Notification.store_id == store.id)
    ).scalars().all()
    assert len(rows) == 1
    assert rows[0].payload["ingredient_id"] == ingredient["id"]


def test_admin_waste_list_filters_by_type_and_employee(
    device_client: TestClient,
    admin_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]],
    store: Store,
) -> None:
    ingredient = create_ingredient()
    identify(device_client, employees["operator"])
    device_client.post(
        "/api/v1/waste",
        json={"ingredient_id": ingredient["id"], "qty": "1", "type": "expired", "employee_pin": "2222"},
        headers={"Idempotency-Key": str(uuid4())},
    )
    device_client.post(
        "/api/v1/waste",
        json={"ingredient_id": ingredient["id"], "qty": "1", "type": "breakage", "employee_pin": "2222"},
        headers={"Idempotency-Key": str(uuid4())},
    )

    only_expired = admin_client.get(f"/api/v1/admin/waste?store_id={store.id}&type=expired").json()
    assert len(only_expired["items"]) == 1
    assert only_expired["items"][0]["type"] == "expired"

    only_this_employee = admin_client.get(
        f"/api/v1/admin/waste?store_id={store.id}&employee_id={employees['operator'].id}"
    ).json()
    assert len(only_this_employee["items"]) == 2
