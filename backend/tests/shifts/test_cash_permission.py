"""Inicio por rol: sólo quien puede manejar la caja toca la plata del cajón.

Antes bastaba con estar identificado (`current_operator`): un cocinero podía
sellar el cierre a ciegas, consignar, retirar o hacerse un relevo a sí mismo.
Ahora cada operación de caja exige ser el responsable de caja del turno, tener
permiso de cobrar (`can_charge`), o ser supervisor / administrador
(`app.shifts.hooks.can_handle_cash`), y responde `403
CASH_PERMISSION_REQUIRED` antes de escribir nada.
"""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.models import IdempotencyKey
from app.shifts.models import CashMovement, Shift, ShiftHandover
from tests.shifts.conftest import idem

API = "/api/v1"
CASH_200K = {"denominations": [{"value": 50000, "count": 4}], "total": 200_000}


def _current(db: Session) -> Shift:
    shift = db.execute(select(Shift).where(Shift.status == "open")).scalars().one()
    return shift


def _cash_writes(shift_id: int) -> list[tuple[str, dict[str, Any], bool]]:
    """(ruta, cuerpo, lleva Idempotency-Key) de cada operación de caja del turno."""
    return [
        (
            f"{API}/shifts/{shift_id}/cash-movements",
            {"kind": "expense", "cause": "petty_expense", "amount": 5_000, "note": "hielo"},
            True,
        ),
        (
            f"{API}/shifts/{shift_id}/cash-swaps",
            {
                "out": {"denominations": [{"value": 50000, "count": 1}], "total": 50000},
                "in": {"denominations": [{"value": 10000, "count": 5}], "total": 50000},
            },
            False,
        ),
        (
            f"{API}/shifts/{shift_id}/pickups",
            {"amount": 50_000, "authorizer_pin": "9999"},
            True,
        ),
        (
            f"{API}/shifts/{shift_id}/handovers",
            {"kind": "handover", "counted_cash": CASH_200K, "new_responsible_id": 0, "new_responsible_pin": "2222"},
            True,
        ),
        (f"{API}/shifts/{shift_id}/close/count", {"counted_cash": CASH_200K, "tips_cash_out": 0}, True),
    ]


def test_an_operator_who_cannot_charge_gets_403_on_every_cash_operation(
    device_client: Any, open_shift: Any, identify: Any, employees: dict, db: Session
) -> None:
    open_shift()
    shift = _current(db)
    identify(device_client, employees["operator"])  # can_charge=False, no es responsable

    for path, body, idempotent in _cash_writes(shift.id):
        if path.endswith("/handovers"):
            body = {**body, "new_responsible_id": employees["operator"].id}
        resp = device_client.post(path, json=body, headers=idem() if idempotent else {})
        assert resp.status_code == 403, (path, resp.text)
        error = resp.json()["error"]
        assert error["code"] == "CASH_PERMISSION_REQUIRED", (path, error)
        assert "caja" in error["message"]

    db.expire_all()
    assert db.execute(select(func.count()).select_from(CashMovement)).scalar_one() == 0
    assert db.execute(select(func.count()).select_from(ShiftHandover)).scalar_one() == 0
    # El rechazo va antes de reservar la llave: no queda grabado como respuesta.
    assert (
        db.execute(
            select(func.count()).select_from(IdempotencyKey).where(IdempotencyKey.scope != "shifts.open")
        ).scalar_one()
        == 0
    )
    assert _current(db).cash_responsible_id == employees["cashier"].id


def test_the_single_step_close_and_the_review_also_require_cash_permission(
    device_client: Any, open_shift: Any, identify: Any, employees: dict, db: Session, set_feature: Any, store: Any
) -> None:
    set_feature("cash.blind_close", False, store_id=store.id)
    open_shift()
    shift = _current(db)
    identify(device_client, employees["operator"])

    resp = device_client.post(
        f"{API}/shifts/{shift.id}/close",
        json={"counted_cash": CASH_200K, "tips_cash_out": 0, "closes_day": False},
        headers=idem(),
    )
    assert resp.status_code == 403, resp.text
    assert resp.json()["error"]["code"] == "CASH_PERMISSION_REQUIRED"
    db.expire_all()
    assert _current(db).status == "open"


def test_only_someone_who_can_charge_opens_the_shift(
    device_client: Any, identify: Any, employees: dict, db: Session
) -> None:
    identify(device_client, employees["operator"])
    resp = device_client.post(
        f"{API}/shifts/open",
        json={"opening_cash": CASH_200K, "cash_reserve": 0, "cash_responsible_id": employees["operator"].id},
        headers=idem(),
    )
    assert resp.status_code == 403, resp.text
    assert resp.json()["error"]["code"] == "CASH_PERMISSION_REQUIRED"
    assert db.execute(select(func.count()).select_from(Shift)).scalar_one() == 0


@pytest.mark.parametrize("who", ["supervisor", "cashier"])
def test_a_supervisor_or_someone_who_can_charge_can_move_cash(
    who: str, device_client: Any, open_shift: Any, identify: Any, employees: dict, db: Session
) -> None:
    open_shift()
    shift = _current(db)
    identify(device_client, employees[who])
    resp = device_client.post(
        f"{API}/shifts/{shift.id}/cash-movements",
        json={"kind": "income", "cause": "other_income", "amount": 5_000, "note": "sencilla"},
        headers=idem(),
    )
    assert resp.status_code == 201, resp.text


def test_the_cash_responsible_without_can_charge_can_handle_the_drawer_after_a_handover(
    device_client: Any, open_shift: Any, identify: Any, employees: dict, db: Session
) -> None:
    open_shift()
    shift = _current(db)
    relevo = device_client.post(
        f"{API}/shifts/{shift.id}/handovers",
        json={
            "kind": "handover",
            "counted_cash": CASH_200K,
            "new_responsible_id": employees["operator"].id,
            "new_responsible_pin": "2222",
        },
        headers=idem(),
    )
    assert relevo.status_code == 201, relevo.text

    identify(device_client, employees["operator"])
    resp = device_client.post(
        f"{API}/shifts/{shift.id}/cash-movements",
        json={"kind": "income", "cause": "other_income", "amount": 5_000, "note": "sencilla"},
        headers=idem(),
    )
    assert resp.status_code == 201, resp.text

    # Y quien entregó la caja, si puede cobrar, sigue pudiendo; el que no puede
    # cobrar y no la tiene, no.
    identify(device_client, employees["operator2"])
    resp = device_client.post(
        f"{API}/shifts/{shift.id}/cash-movements",
        json={"kind": "income", "cause": "other_income", "amount": 5_000, "note": "sencilla"},
        headers=idem(),
    )
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# Relevo: quien recibe confirma con su PIN.
# ---------------------------------------------------------------------------


def _handover(client: Any, shift_id: int, **extra: Any) -> Any:
    return client.post(
        f"{API}/shifts/{shift_id}/handovers",
        json={"kind": "handover", "counted_cash": CASH_200K, **extra},
        headers=idem(),
    )


def test_a_handover_without_the_incoming_pin_is_rejected_before_writing(
    device_client: Any, open_shift: Any, employees: dict, db: Session
) -> None:
    open_shift()
    shift = _current(db)
    resp = _handover(device_client, shift.id, new_responsible_id=employees["operator"].id)
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "NEW_RESPONSIBLE_PIN_REQUIRED"
    db.expire_all()
    assert db.execute(select(func.count()).select_from(ShiftHandover)).scalar_one() == 0
    assert _current(db).cash_responsible_id == employees["cashier"].id


def test_a_handover_with_a_wrong_incoming_pin_is_rejected_before_writing(
    device_client: Any, open_shift: Any, employees: dict, db: Session
) -> None:
    open_shift()
    shift = _current(db)
    resp = _handover(
        device_client, shift.id, new_responsible_id=employees["operator"].id, new_responsible_pin="0000"
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "NEW_RESPONSIBLE_PIN_INVALID"
    db.expire_all()
    assert db.execute(select(func.count()).select_from(ShiftHandover)).scalar_one() == 0
    assert _current(db).cash_responsible_id == employees["cashier"].id


def test_a_handover_to_the_current_responsible_is_rejected(
    device_client: Any, open_shift: Any, employees: dict, db: Session
) -> None:
    open_shift()
    shift = _current(db)
    resp = _handover(
        device_client, shift.id, new_responsible_id=employees["cashier"].id, new_responsible_pin="1111"
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "HANDOVER_SAME_RESPONSIBLE"


def test_handover_candidates_are_the_ones_who_can_handle_cash_minus_the_responsible(
    device_client: Any, open_shift: Any, identify: Any, employees: dict, db: Session
) -> None:
    open_shift()
    shift = _current(db)
    identify(device_client, employees["supervisor"])  # entra al roster del turno

    resp = device_client.get(f"{API}/shifts/{shift.id}/handover-candidates")
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    ids = [r["id"] for r in rows]
    assert employees["cashier"].id not in ids, "quien ya tiene la caja no se la entrega a sí mismo"
    assert employees["operator"].id not in ids, "sin permiso de cobrar no recibe la caja"
    assert employees["supervisor"].id in ids
    assert rows[0]["id"] == employees["supervisor"].id and rows[0]["on_shift"] is True, (
        "los que están en el turno van primero"
    )
    for row in rows:
        assert set(row) == {"id", "name", "on_shift"}, row


# ---------------------------------------------------------------------------
# Los otros dominios que mueven el cajón desde el POS.
# ---------------------------------------------------------------------------


def test_pos_deposit_and_delivery_settlement_require_cash_permission(
    device_client: Any, open_shift: Any, identify: Any, employees: dict, db: Session, set_feature: Any, store: Any
) -> None:
    set_feature("money.deposits", True, store_id=store.id)
    set_feature("pos.delivery", True, store_id=store.id)
    open_shift()
    shift = _current(db)
    identify(device_client, employees["operator"])

    deposito = device_client.post(
        f"{API}/deposits", json={"source_shift_id": shift.id, "amount": 10_000, "receipt_photo": "c.jpg"}, headers=idem()
    )
    assert deposito.status_code == 403, deposito.text
    assert deposito.json()["error"]["code"] == "CASH_PERMISSION_REQUIRED"

    liquidacion = device_client.post(
        f"{API}/delivery-settlements",
        json={"courier_employee_id": employees["operator2"].id},
        headers=idem(),
    )
    assert liquidacion.status_code == 403, liquidacion.text
    assert liquidacion.json()["error"]["code"] == "CASH_PERMISSION_REQUIRED"
