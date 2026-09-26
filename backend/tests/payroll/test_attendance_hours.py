"""La jornada sale de la asistencia del día (0028) unida al roster del turno
de caja: horas antes de que abra la caja, sin contar dos veces el mismo
minuto, sin inventar la hora de una salida olvidada y sin el administrador.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from fastapi.testclient import TestClient

from tests.conftest import KNOWN_PINS
from tests.payroll.conftest import bogota_utc

API = "/api/v1"


def _hours(admin_client: TestClient, store: Any, day: str) -> dict[str, Any]:
    resp = admin_client.get(f"{API}/admin/payroll/hours", params={"store_id": store.id, "from": day, "to": day})
    assert resp.status_code == 200, resp.text
    return resp.json()  # type: ignore[no-any-return]


def test_hours_before_the_cash_opens_count_once(
    device_client: TestClient,
    admin_client: TestClient,
    identify: Any,
    open_shift: Any,
    employees: dict[str, Any],
    store: Any,
    clock: Any,
    seed_surcharge_table: Any,
) -> None:
    """Cocinero: entra 7:00 (sin caja), la caja abre 11:00 (entra al roster a
    las 11), marca salida 15:00. Son 8 horas, no 8 + 4 del roster."""
    seed_surcharge_table(admin_client, store_id=store.id, valid_from=date(2020, 1, 1))
    cook = employees["operator2"]

    clock.set(bogota_utc(2026, 3, 10, 7, 0))
    identify(device_client, cook)
    clock.set(bogota_utc(2026, 3, 10, 11, 0))
    open_shift(responsible=employees["cashier"])
    clock.set(bogota_utc(2026, 3, 10, 15, 0))
    resp = device_client.post(
        f"{API}/attendance/out", json={"employee_id": cook.id, "pin": KNOWN_PINS["Operator2"]}
    )
    assert resp.status_code == 200, resp.text

    body = _hours(admin_client, store, "2026-03-10")
    row = {r["employee_id"]: r for r in body["rows"]}[cook.id]
    assert row["ordinary_minutes"] == 8 * 60
    assert body["pending_review"] == []


def test_forgotten_exit_is_not_counted_until_now_and_is_published(
    device_client: TestClient,
    admin_client: TestClient,
    identify: Any,
    employees: dict[str, Any],
    store: Any,
    clock: Any,
    seed_surcharge_table: Any,
) -> None:
    seed_surcharge_table(admin_client, store_id=store.id, valid_from=date(2020, 1, 1))
    cook = employees["operator2"]
    clock.set(bogota_utc(2026, 3, 10, 7, 0))
    identify(device_client, cook)

    clock.set(bogota_utc(2026, 3, 12, 9, 0))
    body = _hours(admin_client, store, "2026-03-10")
    assert cook.id not in {r["employee_id"] for r in body["rows"]}
    assert [p["employee_id"] for p in body["pending_review"]] == [cook.id]

    entry_id = body["pending_review"][0]["attendance_id"]
    fixed = admin_client.post(
        f"{API}/admin/attendance/{entry_id}/exit",
        json={"store_id": store.id, "out_at": "2026-03-10T13:00", "reason": "Confirmado con la planilla"},
    )
    assert fixed.status_code == 200, fixed.text
    after = _hours(admin_client, store, "2026-03-10")
    assert {r["employee_id"]: r for r in after["rows"]}[cook.id]["ordinary_minutes"] == 6 * 60
    assert after["pending_review"] == []


def test_admin_never_accrues_hours(
    device_client: TestClient,
    admin_client: TestClient,
    identify: Any,
    open_shift: Any,
    employees: dict[str, Any],
    store: Any,
    clock: Any,
    seed_surcharge_table: Any,
) -> None:
    seed_surcharge_table(admin_client, store_id=store.id, valid_from=date(2020, 1, 1))
    clock.set(bogota_utc(2026, 3, 10, 8, 0))
    open_shift(responsible=employees["cashier"])
    identify(device_client, employees["admin"])
    clock.set(bogota_utc(2026, 3, 10, 12, 0))

    body = _hours(admin_client, store, "2026-03-10")
    ids = {r["employee_id"] for r in body["rows"]}
    assert employees["admin"].id not in ids
    assert employees["cashier"].id in ids
