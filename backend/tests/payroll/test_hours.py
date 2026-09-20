"""`GET /admin/payroll/hours` — jornada por persona a partir del roster que
el MVP ya captura (`app.shifts.models.ShiftRoster`), nunca vuelta a
capturar acá.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from fastapi.testclient import TestClient

from tests.conftest import KNOWN_PINS
from tests.payroll.conftest import bogota_utc

API = "/api/v1"


def _open_shift_at(device_client: TestClient, open_shift: Any, clock: Any, *, at: Any) -> dict[str, Any]:
    clock.set(at)
    return open_shift()


def test_ordinary_hours_no_recargo(
    device_client: TestClient, admin_client: TestClient, open_shift: Any, employees: dict[str, Any], store: Any,
    clock: Any, seed_surcharge_table: Any, roster_action: Any,
) -> None:
    """Un turno de martes 9-11 (Bogotá), sin ventana nocturna ni domingo: dos
    horas, todas ordinarias, cero en cualquier otra categoría."""
    seed_surcharge_table(admin_client, store_id=store.id, valid_from=date(2020, 1, 1))
    shift = _open_shift_at(device_client, open_shift, clock, at=bogota_utc(2026, 3, 10, 8, 0))
    operator = employees["operator"]

    clock.set(bogota_utc(2026, 3, 10, 9, 0))
    roster_action(device_client, shift_id=shift["id"], employee_id=operator.id, action="in", pin=KNOWN_PINS["Operator"])
    clock.set(bogota_utc(2026, 3, 10, 11, 0))
    roster_action(device_client, shift_id=shift["id"], employee_id=operator.id, action="out", pin=KNOWN_PINS["Operator"])

    resp = admin_client.get(
        f"{API}/admin/payroll/hours",
        params={"store_id": store.id, "from": "2026-03-10", "to": "2026-03-10"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["available"] is True
    rows = {r["employee_id"]: r for r in body["rows"]}
    row = rows[operator.id]
    assert row["ordinary_minutes"] == 120
    assert row["night_minutes"] == 0
    assert row["sunday_minutes"] == 0
    assert row["holiday_minutes"] == 0
    assert row["overtime_minutes"] == 0
    assert row["ordinary_hours"] == "2.00"


def test_night_window_from_vigente_table(
    device_client: TestClient, admin_client: TestClient, open_shift: Any, employees: dict[str, Any], store: Any,
    clock: Any, seed_surcharge_table: Any, roster_action: Any,
) -> None:
    """Ventana nocturna 22-23 (angosta, a propósito, para que el borde sea
    fácil de verificar): de 21:00 a 23:00 sólo la última hora (22-23) es
    nocturna."""
    seed_surcharge_table(
        admin_client, store_id=store.id, valid_from=date(2020, 1, 1), night_start_hour=22, night_end_hour=23
    )
    shift = _open_shift_at(device_client, open_shift, clock, at=bogota_utc(2026, 3, 10, 8, 0))
    operator = employees["operator"]

    clock.set(bogota_utc(2026, 3, 10, 21, 0))
    roster_action(device_client, shift_id=shift["id"], employee_id=operator.id, action="in", pin=KNOWN_PINS["Operator"])
    clock.set(bogota_utc(2026, 3, 10, 23, 0))
    roster_action(device_client, shift_id=shift["id"], employee_id=operator.id, action="out", pin=KNOWN_PINS["Operator"])

    resp = admin_client.get(
        f"{API}/admin/payroll/hours",
        params={"store_id": store.id, "from": "2026-03-10", "to": "2026-03-10"},
    )
    row = {r["employee_id"]: r for r in resp.json()["rows"]}[operator.id]
    assert row["ordinary_minutes"] == 120
    assert row["night_minutes"] == 60


def test_sunday_hours(
    device_client: TestClient, admin_client: TestClient, open_shift: Any, employees: dict[str, Any], store: Any,
    clock: Any, seed_surcharge_table: Any, roster_action: Any,
) -> None:
    seed_surcharge_table(admin_client, store_id=store.id, valid_from=date(2020, 1, 1))
    shift = _open_shift_at(device_client, open_shift, clock, at=bogota_utc(2026, 3, 8, 8, 0))
    operator = employees["operator"]

    clock.set(bogota_utc(2026, 3, 8, 12, 0))
    roster_action(device_client, shift_id=shift["id"], employee_id=operator.id, action="in", pin=KNOWN_PINS["Operator"])
    clock.set(bogota_utc(2026, 3, 8, 15, 0))
    roster_action(device_client, shift_id=shift["id"], employee_id=operator.id, action="out", pin=KNOWN_PINS["Operator"])

    resp = admin_client.get(
        f"{API}/admin/payroll/hours",
        params={"store_id": store.id, "from": "2026-03-08", "to": "2026-03-08"},
    )
    row = {r["employee_id"]: r for r in resp.json()["rows"]}[operator.id]
    assert row["sunday_minutes"] == 180
    assert row["holiday_minutes"] == 0


def test_holiday_takes_precedence_over_regular_weekday(
    device_client: TestClient, admin_client: TestClient, open_shift: Any, employees: dict[str, Any], store: Any,
    clock: Any, seed_surcharge_table: Any, roster_action: Any,
) -> None:
    seed_surcharge_table(admin_client, store_id=store.id, valid_from=date(2020, 1, 1))
    resp = admin_client.post(
        f"{API}/admin/payroll/holidays",
        params={"store_id": store.id},
        json={"holiday_date": "2026-03-10", "name": "Festivo de prueba"},
        headers={"Idempotency-Key": "holiday-1"},
    )
    assert resp.status_code == 201, resp.text

    shift = _open_shift_at(device_client, open_shift, clock, at=bogota_utc(2026, 3, 10, 8, 0))
    operator = employees["operator"]
    clock.set(bogota_utc(2026, 3, 10, 9, 0))
    roster_action(device_client, shift_id=shift["id"], employee_id=operator.id, action="in", pin=KNOWN_PINS["Operator"])
    clock.set(bogota_utc(2026, 3, 10, 10, 0))
    roster_action(device_client, shift_id=shift["id"], employee_id=operator.id, action="out", pin=KNOWN_PINS["Operator"])

    resp = admin_client.get(
        f"{API}/admin/payroll/hours",
        params={"store_id": store.id, "from": "2026-03-10", "to": "2026-03-10"},
    )
    row = {r["employee_id"]: r for r in resp.json()["rows"]}[employees["operator"].id]
    assert row["holiday_minutes"] == 60
    assert row["sunday_minutes"] == 0


def test_pause_is_not_worked_time(
    device_client: TestClient, admin_client: TestClient, open_shift: Any, employees: dict[str, Any], store: Any,
    clock: Any, seed_surcharge_table: Any, roster_action: Any,
) -> None:
    seed_surcharge_table(admin_client, store_id=store.id, valid_from=date(2020, 1, 1))
    shift = _open_shift_at(device_client, open_shift, clock, at=bogota_utc(2026, 3, 10, 8, 0))
    operator = employees["operator"]

    clock.set(bogota_utc(2026, 3, 10, 9, 0))
    roster_action(device_client, shift_id=shift["id"], employee_id=operator.id, action="in", pin=KNOWN_PINS["Operator"])
    clock.set(bogota_utc(2026, 3, 10, 10, 0))
    roster_action(
        device_client, shift_id=shift["id"], employee_id=operator.id, action="pause_start", pin=KNOWN_PINS["Operator"]
    )
    clock.set(bogota_utc(2026, 3, 10, 10, 30))
    roster_action(
        device_client, shift_id=shift["id"], employee_id=operator.id, action="pause_end", pin=KNOWN_PINS["Operator"]
    )
    clock.set(bogota_utc(2026, 3, 10, 11, 0))
    roster_action(device_client, shift_id=shift["id"], employee_id=operator.id, action="out", pin=KNOWN_PINS["Operator"])

    resp = admin_client.get(
        f"{API}/admin/payroll/hours",
        params={"store_id": store.id, "from": "2026-03-10", "to": "2026-03-10"},
    )
    row = {r["employee_id"]: r for r in resp.json()["rows"]}[operator.id]
    # 9-11 son 2h; la pausa de media hora se resta: 1h30.
    assert row["ordinary_minutes"] == 90


def test_weekly_overtime_threshold(
    device_client: TestClient, admin_client: TestClient, open_shift: Any, employees: dict[str, Any], store: Any,
    clock: Any, seed_surcharge_table: Any, roster_action: Any,
) -> None:
    """Jornada ordinaria semanal de UNA hora (a propósito, chica, para que
    el umbral sea fácil de cruzar): dos horas trabajadas -> 1h ordinaria +
    1h extra."""
    seed_surcharge_table(admin_client, store_id=store.id, valid_from=date(2020, 1, 1), weekly_ordinary_hours=1)
    shift = _open_shift_at(device_client, open_shift, clock, at=bogota_utc(2026, 3, 10, 8, 0))
    operator = employees["operator"]

    clock.set(bogota_utc(2026, 3, 10, 9, 0))
    roster_action(device_client, shift_id=shift["id"], employee_id=operator.id, action="in", pin=KNOWN_PINS["Operator"])
    clock.set(bogota_utc(2026, 3, 10, 11, 0))
    roster_action(device_client, shift_id=shift["id"], employee_id=operator.id, action="out", pin=KNOWN_PINS["Operator"])

    resp = admin_client.get(
        f"{API}/admin/payroll/hours",
        params={"store_id": store.id, "from": "2026-03-10", "to": "2026-03-10"},
    )
    row = {r["employee_id"]: r for r in resp.json()["rows"]}[operator.id]
    assert row["ordinary_minutes"] == 60
    assert row["overtime_minutes"] == 60


def test_hours_without_surcharge_table_is_null_with_reason(
    admin_client: TestClient, store: Any,
) -> None:
    resp = admin_client.get(
        f"{API}/admin/payroll/hours",
        params={"store_id": store.id, "from": "2026-03-10", "to": "2026-03-10"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["available"] is False
    assert body["reason"]
    assert body["rows"] == []


def test_hours_requires_feature_flag(
    admin_client: TestClient, store: Any, set_feature: Any, seed_surcharge_table: Any,
) -> None:
    seed_surcharge_table(admin_client, store_id=store.id, valid_from=date(2020, 1, 1))
    set_feature("payroll", False)
    resp = admin_client.get(
        f"{API}/admin/payroll/hours",
        params={"store_id": store.id, "from": "2026-03-10", "to": "2026-03-10"},
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"

    set_feature("payroll", True)
    resp = admin_client.get(
        f"{API}/admin/payroll/hours",
        params={"store_id": store.id, "from": "2026-03-10", "to": "2026-03-10"},
    )
    assert resp.status_code == 200, resp.text
