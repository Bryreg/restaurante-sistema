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


def test_identify_over_http_adds_the_person_to_the_open_shift_roster(
    device_client, identify, employees, open_shift, db: Session
) -> None:
    """Costura entre dominios (D-1 de la entrega del pedido 1a): el hook existe
    en ambos extremos, pero `POST /auth/device/identify` lo buscaba en el
    módulo equivocado y nunca corría desde HTTP. Este test lo prueba de punta a
    punta: abrir turno, identificar a otra persona por HTTP y encontrarla en el
    roster que devuelve `GET /shifts/{id}`.
    """
    open_shift(cash_responsible=employees["cashier"])
    shift = _open(db)

    identify(device_client, employees["operator"])

    resp = device_client.get(f"/api/v1/shifts/{shift.id}")
    assert resp.status_code == 200, resp.text
    roster_ids = [entry["employee_id"] for entry in resp.json()["roster"]]
    assert employees["operator"].id in roster_ids, resp.json()["roster"]

    # Idempotente: identificarse otra vez no duplica la entrada abierta.
    identify(device_client, employees["operator"])
    open_entries = (
        db.query(ShiftRoster)
        .filter(
            ShiftRoster.shift_id == shift.id,
            ShiftRoster.employee_id == employees["operator"].id,
            ShiftRoster.out_at.is_(None),
        )
        .count()
    )
    assert open_entries == 1


def test_closing_the_shift_ends_everyone_still_in_the_roster(
    device_client, identify, employees, open_shift, clock, db: Session
) -> None:
    """La persona responsable de caja no puede marcar salida por el roster
    (`NOT_CASH_RESPONSIBLE`), así que su entrada sólo puede terminar con el
    cierre. Antes quedaba abierta para siempre y nómina y el reparto de
    propinas por horas la contaban hasta «ahora»: en la operación simulada de
    `python -m app.demo`, 740 horas extra en una semana. Quien olvidó marcar
    salida (y su pausa abierta) termina también a la hora del cierre."""
    open_shift(cash_responsible=employees["cashier"])
    shift = _open(db)
    device_client.post(
        f"/api/v1/shifts/{shift.id}/roster",
        json={"employee_id": employees["operator"].id, "action": "in", "pin": "2222"},
    )
    device_client.post(
        f"/api/v1/shifts/{shift.id}/roster",
        json={"employee_id": employees["operator"].id, "action": "pause_start", "pin": "2222"},
    )
    clock.advance(hours=9)

    identify(device_client, employees["cashier"])
    count = device_client.post(
        f"/api/v1/shifts/{shift.id}/close/count",
        json={"counted_cash": {"denominations": [{"value": 50000, "count": 4}], "total": 200_000},
              "tips_cash_out": 0, "photo": "x.jpg"},
        headers=idem(),
    )
    assert count.status_code in (200, 201), count.text
    confirm = device_client.post(
        f"/api/v1/shifts/{shift.id}/close/{count.json()['count_id']}/confirm",
        json={"difference_seen": 0, "closes_day": True},
    )
    assert confirm.status_code in (200, 201), confirm.text

    db.expire_all()
    db.refresh(shift)
    entries = db.query(ShiftRoster).filter(ShiftRoster.shift_id == shift.id).all()
    assert {e.employee_id for e in entries} >= {employees["cashier"].id, employees["operator"].id}
    for entry in entries:
        assert entry.out_at == shift.closed_at
    operator_entry = next(e for e in entries if e.employee_id == employees["operator"].id)
    assert operator_entry.pauses[-1]["end"] is not None
