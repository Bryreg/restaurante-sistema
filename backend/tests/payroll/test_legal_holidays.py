"""Festivos de ley calculados (Ley 51 de 1983): la sede no tiene que
cargarlos y las horas de esos días cuentan como festivas solas."""

from __future__ import annotations

from datetime import date
from typing import Any

from fastapi.testclient import TestClient

from app.core.holidays_co import colombian_holidays, easter_sunday
from tests.conftest import KNOWN_PINS
from tests.payroll.conftest import bogota_utc

API = "/api/v1"


def test_easter_and_the_2026_calendar() -> None:
    assert easter_sunday(2024) == date(2024, 3, 31)
    assert easter_sunday(2026) == date(2026, 4, 5)
    h = colombian_holidays(2026)
    assert len(h) == 18
    # Trasladados al lunes y los de Pascua.
    assert h[date(2026, 1, 12)] == "Reyes Magos"
    assert h[date(2026, 3, 23)] == "San José"
    assert h[date(2026, 4, 3)] == "Viernes Santo"
    assert h[date(2026, 5, 18)] == "Ascensión del Señor"
    assert h[date(2026, 6, 8)] == "Corpus Christi"
    assert h[date(2026, 6, 15)] == "Sagrado Corazón"
    assert h[date(2026, 11, 16)] == "Independencia de Cartagena"
    # Fijos: no se corren aunque caigan en otro día.
    assert date(2026, 7, 20) in h and date(2026, 12, 8) in h


def test_the_year_list_mixes_law_and_store_holidays(admin_client: TestClient, store: Any) -> None:
    created = admin_client.post(
        f"{API}/admin/payroll/holidays", params={"store_id": store.id},
        json={"holiday_date": "2026-03-10", "name": "Fiestas del municipio"},
        headers={"Idempotency-Key": "local-holiday"},
    )
    assert created.status_code == 201, created.text
    dup = admin_client.post(
        f"{API}/admin/payroll/holidays", params={"store_id": store.id},
        json={"holiday_date": "2026-07-20", "name": "Independencia"},
        headers={"Idempotency-Key": "legal-holiday"},
    )
    assert dup.status_code == 409

    rows = admin_client.get(f"{API}/admin/payroll/holidays", params={"store_id": store.id, "year": 2026}).json()
    assert len(rows) == 19
    by_date = {r["holiday_date"]: r for r in rows}
    assert by_date["2026-03-10"]["source"] == "sede"
    assert by_date["2026-03-23"] == {**by_date["2026-03-23"], "source": "ley", "id": None, "name": "San José"}


def test_hours_on_a_law_holiday_are_holiday_hours(
    device_client: TestClient, admin_client: TestClient, open_shift: Any, employees: dict[str, Any], store: Any,
    clock: Any, seed_surcharge_table: Any, roster_action: Any,
) -> None:
    seed_surcharge_table(admin_client, store_id=store.id, valid_from=date(2020, 1, 1))
    # 2026-03-23 (lunes): San José trasladado. Nadie lo cargó.
    clock.set(bogota_utc(2026, 3, 23, 8, 0))
    shift = open_shift()
    operator = employees["operator"]
    clock.set(bogota_utc(2026, 3, 23, 9, 0))
    roster_action(device_client, shift_id=shift["id"], employee_id=operator.id, action="in", pin=KNOWN_PINS["Operator"])
    clock.set(bogota_utc(2026, 3, 23, 11, 0))
    roster_action(device_client, shift_id=shift["id"], employee_id=operator.id, action="out", pin=KNOWN_PINS["Operator"])
    resp = admin_client.get(f"{API}/admin/payroll/hours",
                            params={"store_id": store.id, "from": "2026-03-23", "to": "2026-03-23"})
    row = {r["employee_id"]: r for r in resp.json()["rows"]}[operator.id]
    assert row["holiday_minutes"] == 120
