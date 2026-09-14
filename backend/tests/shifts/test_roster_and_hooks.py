"""Roster (entradas, salidas, pausas) y el hook `on_employee_identified` que
`backend-core` llama desde `POST /auth/device/identify`.
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.shifts import hooks
from app.shifts.models import Shift, ShiftRoster
from tests.shifts.conftest import idem


def _open(db: Session) -> Shift:
    shift = db.query(Shift).filter(Shift.status == "open").order_by(Shift.id.desc()).first()
    assert shift is not None
    return shift


def test_on_employee_identified_adds_to_roster_of_the_open_shift(store, employees, open_shift, db: Session) -> None:
    open_shift(cash_responsible=employees["cashier"])
    shift = _open(db)

    before = (
        db.query(ShiftRoster)
        .filter(ShiftRoster.shift_id == shift.id, ShiftRoster.employee_id == employees["operator"].id)
        .count()
    )
    assert before == 0

    hooks.on_employee_identified(db, store_id=store.id, employee=employees["operator"])
    db.commit()

    after = (
        db.query(ShiftRoster)
        .filter(ShiftRoster.shift_id == shift.id, ShiftRoster.employee_id == employees["operator"].id)
        .count()
    )
    assert after == 1

    # Es idempotente: identificarse de nuevo no duplica la entrada abierta.
    hooks.on_employee_identified(db, store_id=store.id, employee=employees["operator"])
    db.commit()
    still_one = (
        db.query(ShiftRoster)
        .filter(ShiftRoster.shift_id == shift.id, ShiftRoster.employee_id == employees["operator"].id)
        .count()
    )
    assert still_one == 1


def test_on_employee_identified_without_open_shift_is_a_noop(store, employees, db: Session) -> None:
    # Sin turno abierto no hay dónde agregar el roster; no debe fallar.
    hooks.on_employee_identified(db, store_id=store.id, employee=employees["operator"])
    db.commit()


def test_roster_out_for_the_cash_responsible_is_rejected(device_client, employees, open_shift, db: Session) -> None:
    open_shift(cash_responsible=employees["cashier"])
    shift = _open(db)

    resp = device_client.post(
        f"/api/v1/shifts/{shift.id}/roster",
        json={"employee_id": employees["cashier"].id, "action": "out", "pin": "1111"},
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "NOT_CASH_RESPONSIBLE"


def test_roster_in_and_out_for_a_regular_employee(device_client, employees, open_shift, db: Session) -> None:
    open_shift(cash_responsible=employees["cashier"])
    shift = _open(db)

    in_resp = device_client.post(
        f"/api/v1/shifts/{shift.id}/roster",
        json={"employee_id": employees["operator"].id, "action": "in", "pin": "2222"},
    )
    assert in_resp.status_code in (200, 201), in_resp.text

    out_resp = device_client.post(
        f"/api/v1/shifts/{shift.id}/roster",
        json={"employee_id": employees["operator"].id, "action": "out", "pin": "2222"},
    )
    assert out_resp.status_code in (200, 201), out_resp.text

    entry = (
        db.query(ShiftRoster)
        .filter(ShiftRoster.shift_id == shift.id, ShiftRoster.employee_id == employees["operator"].id)
        .one()
    )
    assert entry.out_at is not None


def test_roster_wrong_pin_is_rejected(device_client, employees, open_shift, db: Session) -> None:
    open_shift(cash_responsible=employees["cashier"])
    shift = _open(db)

    resp = device_client.post(
        f"/api/v1/shifts/{shift.id}/roster",
        json={"employee_id": employees["operator"].id, "action": "in", "pin": "0000"},
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "PIN_INVALID"
