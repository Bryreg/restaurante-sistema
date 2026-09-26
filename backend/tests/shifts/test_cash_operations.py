"""Movimientos, cambio y retiros: la reserva y el cambio no tocan el esperado,
el retiro sí y guarda el snapshot, el límite de gasto menor exige PIN de
administrador, y el replay de `Idempotency-Key` no duplica.
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.shifts import service
from app.shifts.models import CashMovement, Shift
from tests.shifts.conftest import idem


def _open(db: Session) -> Shift:
    shift = db.query(Shift).filter(Shift.status == "open").order_by(Shift.id.desc()).first()
    assert shift is not None
    return shift


def test_cash_reserve_does_not_change_expected(device_client, open_shift, db: Session) -> None:
    open_shift(cash_reserve=100_000)
    shift = _open(db)
    breakdown = service.compute_breakdown(db, shift)
    assert breakdown["expected"] == shift.opening_cash_total
    assert shift.cash_reserve == 100_000


def test_cash_swap_is_net_zero_and_does_not_change_expected(device_client, open_shift, db: Session) -> None:
    open_shift()
    shift = _open(db)
    before = service.compute_breakdown(db, shift)["expected"]

    resp = device_client.post(
        f"/api/v1/shifts/{shift.id}/cash-swaps",
        json={
            "out": {"denominations": [{"value": 50000, "count": 1}], "total": 50000},
            "in": {"denominations": [{"value": 10000, "count": 5}], "total": 50000},
        },
    )
    assert resp.status_code in (200, 201), resp.text

    db.refresh(shift)
    after = service.compute_breakdown(db, shift)["expected"]
    assert after == before


def test_cash_swap_not_zero_is_rejected(device_client, open_shift, db: Session) -> None:
    open_shift()
    shift = _open(db)

    resp = device_client.post(
        f"/api/v1/shifts/{shift.id}/cash-swaps",
        json={
            "out": {"denominations": [{"value": 50000, "count": 1}], "total": 50000},
            "in": {"denominations": [{"value": 10000, "count": 4}], "total": 40000},
        },
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "SWAP_NOT_ZERO"


def test_pickup_lowers_expected_and_snapshots_it(device_client, employees, open_shift, db: Session) -> None:
    open_shift()
    shift = _open(db)
    before = service.compute_breakdown(db, shift)["expected"]

    resp = device_client.post(
        f"/api/v1/shifts/{shift.id}/pickups",
        json={"amount": 50_000, "authorizer_pin": "9999", "note": "para el banco", "photo": "retiro.jpg"},
        headers=idem(),
    )
    assert resp.status_code in (200, 201), resp.text
    body = resp.json()
    assert body["expected_at_pickup"] == before

    db.refresh(shift)
    after = service.compute_breakdown(db, shift)["expected"]
    assert after == before - 50_000


def test_pickup_reverse_keeps_the_row_and_marks_it(device_client, employees, open_shift, db: Session) -> None:
    open_shift()
    shift = _open(db)

    created = device_client.post(
        f"/api/v1/shifts/{shift.id}/pickups",
        json={"amount": 30_000, "authorizer_pin": "9999", "photo": "retiro.jpg"},
        headers=idem(),
    )
    assert created.status_code in (200, 201), created.text
    pickup_id = created.json()["id"]

    reversed_resp = device_client.post(
        f"/api/v1/shifts/{shift.id}/pickups/{pickup_id}/reverse",
        json={"reason": "se registró de más", "authorizer_pin": "9999"},
    )
    assert reversed_resp.status_code in (200, 201), reversed_resp.text
    assert reversed_resp.json()["reversed_at"] is not None

    again = device_client.post(
        f"/api/v1/shifts/{shift.id}/pickups/{pickup_id}/reverse",
        json={"reason": "otra vez", "authorizer_pin": "9999"},
    )
    assert again.status_code == 400
    assert again.json()["error"]["code"] == "PICKUP_ALREADY_REVERSED"


def test_petty_cash_limit_requires_authorizer_pin(device_client, open_shift, db: Session) -> None:
    open_shift()
    shift = _open(db)

    over_limit = device_client.post(
        f"/api/v1/shifts/{shift.id}/cash-movements",
        json={"kind": "expense", "cause": "emergency_purchase", "amount": 80_000, "note": "compra urgente"},
        headers=idem(),
    )
    assert over_limit.status_code == 400
    assert over_limit.json()["error"]["code"] == "PETTY_CASH_LIMIT"

    with_admin = device_client.post(
        f"/api/v1/shifts/{shift.id}/cash-movements",
        json={
            "kind": "expense",
            "cause": "emergency_purchase",
            "amount": 80_000,
            "note": "compra urgente",
            "authorizer_pin": "9999",
        },
        headers=idem(),
    )
    assert with_admin.status_code in (200, 201), with_admin.text


def test_petty_cash_under_limit_needs_no_authorizer(device_client, open_shift, db: Session) -> None:
    open_shift()
    shift = _open(db)

    resp = device_client.post(
        f"/api/v1/shifts/{shift.id}/cash-movements",
        json={"kind": "expense", "cause": "petty_expense", "amount": 10_000, "note": "hielo"},
        headers=idem(),
    )
    assert resp.status_code in (200, 201), resp.text


def test_idempotency_key_replay_does_not_duplicate_the_movement(device_client, open_shift, db: Session) -> None:
    open_shift()
    shift = _open(db)
    key = idem()
    payload = {"kind": "income", "cause": "other_income", "amount": 10_000, "note": "ajuste"}

    first = device_client.post(f"/api/v1/shifts/{shift.id}/cash-movements", json=payload, headers=key)
    second = device_client.post(f"/api/v1/shifts/{shift.id}/cash-movements", json=payload, headers=key)

    assert first.status_code in (200, 201), first.text
    assert second.status_code == first.status_code
    assert second.json() == first.json()

    count = (
        db.query(CashMovement)
        .filter(CashMovement.shift_id == shift.id, CashMovement.cause == "other_income")
        .count()
    )
    assert count == 1


def test_handover_and_spot_check_return_the_string_kind_never_500(
    device_client, employees, open_shift, db: Session
) -> None:
    """Iteración 2, B-2: `ShiftHandover.kind` se guarda como el enum
    (`service.create_handover` usa `HandoverKind(payload.kind)`, no el `str`
    del payload) y el router normaliza con `_kind_str` en vez de asumir
    `.value` a ciegas: antes reventaba en cuanto la instancia recién creada
    perdía el atributo Python y quedaba el `str` plano de la fila releída."""
    open_shift()
    shift = _open(db)

    spot_check = device_client.post(
        f"/api/v1/shifts/{shift.id}/handovers",
        json={
            "kind": "spot_check",
            "counted_cash": {"denominations": [{"value": 50000, "count": 4}], "total": 200_000},
            "authorizer_pin": "9999",
        },
        headers=idem(),
    )
    assert spot_check.status_code == 201, spot_check.text
    assert spot_check.json()["kind"] == "spot_check"

    handover = device_client.post(
        f"/api/v1/shifts/{shift.id}/handovers",
        json={
            "kind": "handover",
            "counted_cash": {"denominations": [{"value": 50000, "count": 4}], "total": 200_000},
            "new_responsible_id": employees["operator"].id,
            "new_responsible_pin": "2222",
        },
        headers=idem(),
    )
    assert handover.status_code == 201, handover.text
    assert handover.json()["kind"] == "handover"
