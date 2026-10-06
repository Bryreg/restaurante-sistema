"""Auditoría 2026-10-06 (u1, u2): la hora extra nocturna paga su propio 75 %
(no extra 25 % + nocturno 35 %) y una sede nueva nace con el calendario legal
de recargos, con las fechas de la ley."""

from __future__ import annotations

from datetime import date
from typing import Any

from fastapi.testclient import TestClient

from tests.conftest import KNOWN_PINS
from tests.payroll.conftest import bogota_utc

API = "/api/v1"


def test_night_overtime_pays_75_percent(
    device_client: TestClient, admin_client: TestClient, open_shift: Any, employees: dict[str, Any],
    store: Any, clock: Any, seed_surcharge_table: Any, seed_wage: Any, roster_action: Any,
) -> None:
    # Jornada semanal de 1 h para que la segunda hora sea extra.
    seed_surcharge_table(admin_client, store_id=store.id, valid_from=date(2024, 1, 1),
                         night_start_hour=21, night_end_hour=6, weekly_ordinary_hours=1)
    operator, cashier = employees["operator"], employees["cashier"]
    for emp in (operator, cashier):
        seed_wage(admin_client, store_id=store.id, employee_id=emp.id, hourly_wage_pesos=10_000,
                  valid_from=date(2020, 1, 1))

    # 2025-06-10 es martes: ni domingo ni festivo.
    clock.set(bogota_utc(2025, 6, 10, 20, 0))
    shift = open_shift()
    clock.set(bogota_utc(2025, 6, 10, 21, 30))
    roster_action(device_client, shift_id=shift["id"], employee_id=operator.id, action="in", pin=KNOWN_PINS["Operator"])
    clock.set(bogota_utc(2025, 6, 10, 23, 30))
    roster_action(device_client, shift_id=shift["id"], employee_id=operator.id, action="out", pin=KNOWN_PINS["Operator"])

    resp = admin_client.post(
        f"{API}/admin/payroll/runs", params={"store_id": store.id},
        json={"date_from": "2025-06-10", "date_to": "2025-06-10"}, headers={"Idempotency-Key": "night-ot"},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["calculation_method"] == "cst_categories"
    line = next(l for l in body["lines"] if l["employee_id"] == operator.id)
    assert (line["night_minutes"], line["overtime_minutes"]) == (120, 60)
    assert line["base_pay"] == 20_000
    # Nocturno 35 % sólo sobre la hora ordinaria; la extra nocturna, 75 %.
    assert line["night_surcharge"] == 3_500
    assert line["overtime_pay"] == 7_500
    assert line["total"] == 31_000


def test_a_new_store_is_born_with_the_legal_calendar(admin_client: TestClient) -> None:
    created = admin_client.post(f"{API}/admin/stores", json={
        "name": "Sede Norte", "nit": "900123456", "dv": "7", "legal_name": "Demo SAS", "address": "Cra 1",
        "municipality_dane": "11001", "opening_hours": [], "cutoff_hour": 6, "active_channels": ["counter"],
        "store_pin": "4321",
    })
    assert created.status_code in (200, 201), created.text
    sid = created.json()["id"]
    tables = admin_client.get(f"{API}/admin/payroll/surcharge-tables", params={"store_id": sid}).json()
    by_date = {t["valid_from"]: t for t in tables}
    assert by_date["2025-07-01"]["sunday_holiday_surcharge_bp"] == 8000
    assert by_date["2025-07-15"]["weekly_ordinary_hours"] == 44
    assert by_date["2025-12-25"]["night_start_hour"] == 19
    assert by_date["2026-07-01"]["sunday_holiday_surcharge_bp"] == 9000
    assert by_date["2026-07-15"]["weekly_ordinary_hours"] == 42
    assert by_date["2027-07-01"]["sunday_holiday_surcharge_bp"] == 10000
    assert all(t["night_overtime_surcharge_bp"] == 7500 for t in tables)
    assert "2026-01-01" not in by_date and "2025-12-01" not in by_date


def test_weekly_overtime_counts_the_days_before_the_period(
    device_client: TestClient, admin_client: TestClient, open_shift: Any, employees: dict[str, Any],
    store: Any, clock: Any, seed_surcharge_table: Any, seed_wage: Any, roster_action: Any,
) -> None:
    """La semana del 8 al 14 de junio de 2025: 1 h el lunes (fuera del
    período) y 1 h el miércoles (dentro). Con jornada de 1 h, la del
    miércoles es extra aunque el período arranque ese día."""
    seed_surcharge_table(admin_client, store_id=store.id, valid_from=date(2024, 1, 1),
                         night_start_hour=21, night_end_hour=6, weekly_ordinary_hours=1)
    operator = employees["operator"]
    for emp in (operator, employees["cashier"]):
        seed_wage(admin_client, store_id=store.id, employee_id=emp.id, hourly_wage_pesos=10_000,
                  valid_from=date(2020, 1, 1))
    clock.set(bogota_utc(2025, 6, 9, 8, 0))
    shift = open_shift()
    for day in (9, 11):
        clock.set(bogota_utc(2025, 6, day, 10, 0))
        roster_action(device_client, shift_id=shift["id"], employee_id=operator.id, action="in", pin=KNOWN_PINS["Operator"])
        clock.set(bogota_utc(2025, 6, day, 11, 0))
        roster_action(device_client, shift_id=shift["id"], employee_id=operator.id, action="out", pin=KNOWN_PINS["Operator"])
    resp = admin_client.get(f"{API}/admin/payroll/hours",
                            params={"store_id": store.id, "from": "2025-06-11", "to": "2025-06-11"})
    row = {r["employee_id"]: r for r in resp.json()["rows"]}[operator.id]
    assert row["ordinary_minutes"] == 0
    assert row["overtime_minutes"] == 60
