"""Asistencia del día separada del turno de caja (0028) y el administrador
que sólo autoriza.

Toda escritura entra por HTTP. **Excepción declarada** (`docs/CONTEXTO-
AGENTES.md §11`): `test_legacy_admin_roster_row_is_left_out_of_the_tip_split`
inserta a mano una fila de `shift_roster` a nombre del administrador, porque
desde este cambio ninguna puerta HTTP la puede crear — es justamente el dato
viejo que el reparto tiene que ignorar.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.shifts.models import AttendanceEntry, Shift, ShiftRoster
from tests.conftest import KNOWN_PINS
from tests.payroll.conftest import bogota_utc

API = "/api/v1"


def _entries(db: Session, employee_id: int) -> list[AttendanceEntry]:
    db.expire_all()
    return list(
        db.execute(
            select(AttendanceEntry).where(AttendanceEntry.employee_id == employee_id).order_by(AttendanceEntry.id)
        ).scalars()
    )


def _roster(db: Session, shift_id: int, employee_id: int) -> list[ShiftRoster]:
    db.expire_all()
    return list(
        db.execute(
            select(ShiftRoster).where(ShiftRoster.shift_id == shift_id, ShiftRoster.employee_id == employee_id)
        ).scalars()
    )


def test_first_pin_of_the_day_marks_entry_without_a_cash_shift(
    device_client: TestClient, identify: Any, employees: dict[str, Any], clock: Any, db: Session
) -> None:
    """El cocinero llega a las 7:02 a. m. y todavía nadie abrió la caja: su
    PIN marca la entrada igual. El segundo PIN del día no crea otra."""
    clock.set(bogota_utc(2026, 3, 10, 7, 2))
    cook = employees["operator"]

    first = identify(device_client, cook)
    assert first.status_code == 200, first.text
    att = first.json()["attendance"]
    assert att is not None and att["created"] is True
    assert att["business_date"] == "2026-03-10"
    assert db.execute(select(Shift)).first() is None

    clock.set(bogota_utc(2026, 3, 10, 9, 0))
    second = identify(device_client, cook)
    assert second.json()["attendance"]["created"] is False
    assert len(_entries(db, cook.id)) == 1

    me = device_client.get(f"{API}/auth/me").json()
    assert me["employee_attendance"]["id"] == att["id"]


def test_admin_identifying_on_the_tablet_only_authorizes(
    device_client: TestClient, identify: Any, employees: dict[str, Any], open_shift: Any, db: Session
) -> None:
    """El dueño teclea su PIN en «Quién opera»: no entra al roster ni a la
    asistencia (no suma horas ni propina) y el roster lo rechaza con código."""
    shift = open_shift(cash_responsible=employees["cashier"])
    admin = employees["admin"]

    resp = identify(device_client, admin)
    assert resp.status_code == 200, resp.text
    assert resp.json()["attendance"] is None
    assert _entries(db, admin.id) == []
    assert _roster(db, shift["id"], admin.id) == []

    roster = device_client.post(
        f"{API}/shifts/{shift['id']}/roster",
        json={"employee_id": admin.id, "action": "in", "pin": KNOWN_PINS["Admin"]},
    )
    assert roster.status_code == 400
    assert roster.json()["error"]["code"] == "ADMIN_NOT_IN_ROSTER"


def test_opening_the_cash_shift_brings_in_who_already_arrived(
    device_client: TestClient, identify: Any, employees: dict[str, Any], open_shift: Any, clock: Any, db: Session
) -> None:
    clock.set(bogota_utc(2026, 3, 10, 7, 0))
    cook = employees["operator2"]
    identify(device_client, cook)

    clock.set(bogota_utc(2026, 3, 10, 11, 0))
    shift = open_shift(cash_responsible=employees["cashier"])

    rows = _roster(db, shift["id"], cook.id)
    assert len(rows) == 1
    # El roster mide la ventana del turno; la jornada completa, la asistencia.
    assert rows[0].in_at == bogota_utc(2026, 3, 10, 11, 0)
    assert _entries(db, cook.id)[0].in_at == bogota_utc(2026, 3, 10, 7, 0)


def test_mark_exit_one_tap_closes_attendance_and_roster(
    device_client: TestClient, identify: Any, employees: dict[str, Any], open_shift: Any, clock: Any, db: Session
) -> None:
    clock.set(bogota_utc(2026, 3, 10, 8, 0))
    shift = open_shift(cash_responsible=employees["cashier"])
    waiter = employees["operator"]
    identify(device_client, waiter)

    clock.set(bogota_utc(2026, 3, 10, 15, 30))
    # La sesión de persona dura minutos: vuelve a teclear su PIN (no crea
    # otra entrada) y marca la salida en un toque.
    assert identify(device_client, waiter).json()["attendance"]["created"] is False
    resp = device_client.post(f"{API}/attendance/out", json={})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "closed"
    assert body["out_source"] == "self"

    entry = _entries(db, waiter.id)[0]
    assert entry.out_at == bogota_utc(2026, 3, 10, 15, 30)
    assert all(r.out_at == bogota_utc(2026, 3, 10, 15, 30) for r in _roster(db, shift["id"], waiter.id))

    again = device_client.post(f"{API}/attendance/out", json={})
    assert again.status_code == 400
    assert again.json()["error"]["code"] == "ATTENDANCE_NOT_OPEN"


def test_mark_exit_with_own_pin_from_the_identify_screen(
    device_client: TestClient, identify: Any, employees: dict[str, Any], clock: Any, db: Session
) -> None:
    clock.set(bogota_utc(2026, 3, 10, 7, 0))
    cook = employees["operator2"]
    identify(device_client, cook)
    device_client.post(f"{API}/auth/device/release")

    wrong = device_client.post(f"{API}/attendance/out", json={"employee_id": cook.id, "pin": "0000"})
    assert wrong.status_code == 400
    assert wrong.json()["error"]["code"] == "PIN_INVALID"

    clock.set(bogota_utc(2026, 3, 10, 15, 0))
    ok = device_client.post(
        f"{API}/attendance/out", json={"employee_id": cook.id, "pin": KNOWN_PINS["Operator2"]}
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["out_source"] == "self"


def test_only_a_supervisor_marks_someone_elses_exit(
    device_client: TestClient, identify: Any, employees: dict[str, Any], clock: Any, db: Session
) -> None:
    clock.set(bogota_utc(2026, 3, 10, 7, 0))
    cook = employees["operator2"]
    identify(device_client, cook)

    identify(device_client, employees["operator"])
    denied = device_client.post(f"{API}/attendance/out", json={"employee_id": cook.id})
    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "EXIT_REQUIRES_SUPERVISOR"

    identify(device_client, employees["supervisor"])
    ok = device_client.post(f"{API}/attendance/out", json={"employee_id": cook.id})
    assert ok.status_code == 200, ok.text
    assert ok.json()["out_source"] == "other"
    assert ok.json()["out_by_employee_name"] == "Supervisor"


def test_cash_responsible_cannot_mark_exit_while_holding_the_drawer(
    device_client: TestClient, employees: dict[str, Any], open_shift: Any, clock: Any
) -> None:
    clock.set(bogota_utc(2026, 3, 10, 8, 0))
    open_shift(cash_responsible=employees["cashier"])
    resp = device_client.post(f"{API}/attendance/out", json={})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "NOT_CASH_RESPONSIBLE"


def test_forgotten_exit_stays_for_review_and_admin_fixes_it_with_reason(
    device_client: TestClient,
    admin_client: TestClient,
    identify: Any,
    employees: dict[str, Any],
    store: Any,
    clock: Any,
    db: Session,
) -> None:
    clock.set(bogota_utc(2026, 3, 10, 7, 0))
    cook = employees["operator2"]
    identify(device_client, cook)

    clock.set(bogota_utc(2026, 3, 12, 9, 0))
    listing = admin_client.get(
        f"{API}/admin/attendance", params={"store_id": store.id, "from": "2026-03-12", "to": "2026-03-12"}
    )
    assert listing.status_code == 200, listing.text
    body = listing.json()
    # Fuera del rango pedido, pero una salida a revisar no se esconde.
    assert body["pending_review"] == 1
    assert [e["status"] for e in body["entries"]] == ["review"]
    entry_id = body["entries"][0]["id"]

    no_reason = admin_client.post(
        f"{API}/admin/attendance/{entry_id}/exit",
        json={"store_id": store.id, "out_at": "2026-03-10T15:00", "reason": " "},
    )
    assert no_reason.status_code == 400

    fixed = admin_client.post(
        f"{API}/admin/attendance/{entry_id}/exit",
        json={"store_id": store.id, "out_at": "2026-03-10T15:00", "reason": "Salió a las 3, lo confirmó el jefe de cocina"},
    )
    assert fixed.status_code == 200, fixed.text
    assert fixed.json()["status"] == "closed"
    assert _entries(db, cook.id)[0].out_at == bogota_utc(2026, 3, 10, 15, 0)

    twice = admin_client.post(
        f"{API}/admin/attendance/{entry_id}/exit",
        json={"store_id": store.id, "out_at": "2026-03-10T16:00", "reason": "otra vez"},
    )
    assert twice.status_code == 400
    assert twice.json()["error"]["code"] == "ATTENDANCE_ALREADY_CLOSED"


def test_legacy_admin_roster_row_is_left_out_of_the_tip_split(
    device_client: TestClient,
    admin_client: TestClient,
    identify: Any,
    employees: dict[str, Any],
    open_shift: Any,
    store: Any,
    clock: Any,
    db: Session,
) -> None:
    from app.payroll import service as payroll_service

    clock.set(bogota_utc(2026, 3, 10, 8, 0))
    shift = open_shift(cash_responsible=employees["cashier"])
    identify(device_client, employees["operator"])
    admin = employees["admin"]
    db.add(
        ShiftRoster(
            organization_id=store.organization_id,
            store_id=store.id,
            shift_id=shift["id"],
            employee_id=admin.id,
            employee_name=admin.name,
            in_at=bogota_utc(2026, 3, 10, 8, 0),
            pauses=[],
        )
    )
    db.commit()

    participants = payroll_service._participants(db, store=store, shift_ids=[shift["id"]])
    assert admin.id not in participants
    assert employees["operator"].id in participants
    assert employees["cashier"].id in participants
