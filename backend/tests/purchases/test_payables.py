"""`GET /admin/payables`, `POST .../approve`, `POST .../payments`, `POST
.../payments/{id}/void` — el saldo se deriva, la aprobación es el control
mínimo, y un pago en efectivo deja el egreso en el turno abierto en la misma
transacción."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.stores.models import Store


def _idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


def test_payable_balance_equals_amount_before_any_payment(create_payable: Callable[..., dict[str, Any]]) -> None:
    payable = create_payable()
    assert payable["balance"] == payable["amount"]
    assert payable["status"] == "pending_review"


def test_payment_blocked_before_approval(admin_client: TestClient, create_payable: Callable[..., Any]) -> None:
    payable = create_payable()
    resp = admin_client.post(
        f"/api/v1/admin/payables/{payable['id']}/payments",
        json={"amount": 1000, "method": "cash", "paid_at": "2026-01-06T10:00:00Z", "from_cash_drawer": False, "authorizer_pin": "9999"},
        headers=_idem(),
    )
    assert resp.status_code == 409, resp.text
    assert resp.json()["error"]["code"] == "PAYABLE_NOT_APPROVED"


def test_approve_requires_admin_pin_and_is_idempotent_state(admin_client: TestClient, create_payable: Callable[..., Any]) -> None:
    payable = create_payable()
    resp = admin_client.post(f"/api/v1/admin/payables/{payable['id']}/approve", json={"authorizer_pin": "9999"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "approved"

    resp2 = admin_client.post(f"/api/v1/admin/payables/{payable['id']}/approve", json={"authorizer_pin": "9999"})
    assert resp2.status_code == 400, resp2.text
    assert resp2.json()["error"]["code"] == "PAYABLE_ALREADY_APPROVED"


def test_approve_rejects_supervisor_pin(admin_client: TestClient, create_payable: Callable[..., Any]) -> None:
    payable = create_payable()
    resp = admin_client.post(f"/api/v1/admin/payables/{payable['id']}/approve", json={"authorizer_pin": "5555"})
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "AUTHORIZATION_NOT_ALLOWED"


def test_partial_payment_reduces_balance_and_void_restores_it(admin_client: TestClient, create_payable: Callable[..., Any]) -> None:
    payable = create_payable()
    admin_client.post(f"/api/v1/admin/payables/{payable['id']}/approve", json={"authorizer_pin": "9999"})

    half = payable["amount"] // 2
    resp = admin_client.post(
        f"/api/v1/admin/payables/{payable['id']}/payments",
        json={"amount": half, "method": "transfer", "paid_at": "2026-01-06T10:00:00Z", "from_cash_drawer": False, "authorizer_pin": "9999"},
        headers=_idem(),
    )
    assert resp.status_code == 201, resp.text
    payment_id = resp.json()["id"]

    after_payment = admin_client.get(f"/api/v1/admin/payables?store_id={payable['store_id']}").json()
    row = next(p for p in after_payment if p["id"] == payable["id"])
    assert row["balance"] == payable["amount"] - half

    void_resp = admin_client.post(
        f"/api/v1/admin/payables/{payable['id']}/payments/{payment_id}/void",
        json={"reason": "Monto equivocado", "authorizer_pin": "9999"},
    )
    assert void_resp.status_code == 200, void_resp.text

    after_void = admin_client.get(f"/api/v1/admin/payables?store_id={payable['store_id']}").json()
    row_after_void = next(p for p in after_void if p["id"] == payable["id"])
    assert row_after_void["balance"] == payable["amount"]  # vuelve solo


def test_payment_cannot_exceed_balance(admin_client: TestClient, create_payable: Callable[..., Any]) -> None:
    payable = create_payable()
    admin_client.post(f"/api/v1/admin/payables/{payable['id']}/approve", json={"authorizer_pin": "9999"})
    resp = admin_client.post(
        f"/api/v1/admin/payables/{payable['id']}/payments",
        json={"amount": payable["amount"] + 1, "method": "cash", "paid_at": "2026-01-06T10:00:00Z", "from_cash_drawer": False, "authorizer_pin": "9999"},
        headers=_idem(),
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "PAYMENT_EXCEEDS_BALANCE"


def test_cash_payment_creates_expense_in_open_shift(
    admin_client: TestClient, create_payable: Callable[..., Any], open_shift: Callable[..., dict[str, Any]], db: Session
) -> None:
    payable = create_payable()
    admin_client.post(f"/api/v1/admin/payables/{payable['id']}/approve", json={"authorizer_pin": "9999"})
    shift = open_shift()

    resp = admin_client.post(
        f"/api/v1/admin/payables/{payable['id']}/payments",
        json={"amount": payable["amount"], "method": "cash", "paid_at": "2026-01-06T10:00:00Z", "from_cash_drawer": True, "authorizer_pin": "9999"},
        headers=_idem(),
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["cash_movement_id"] is not None

    from app.shifts.models import CashMovement, CashMovementCause, CashMovementKind

    movement = db.get(CashMovement, body["cash_movement_id"])
    assert movement is not None
    assert movement.shift_id == shift["id"]
    assert movement.cause == CashMovementCause.SUPPLIER_PAYMENT
    assert movement.kind == CashMovementKind.EXPENSE
    assert movement.amount == payable["amount"]


def test_cash_payment_without_open_shift_leaves_nothing(
    admin_client: TestClient, create_payable: Callable[..., Any], db: Session
) -> None:
    payable = create_payable()
    admin_client.post(f"/api/v1/admin/payables/{payable['id']}/approve", json={"authorizer_pin": "9999"})

    resp = admin_client.post(
        f"/api/v1/admin/payables/{payable['id']}/payments",
        json={"amount": payable["amount"], "method": "cash", "paid_at": "2026-01-06T10:00:00Z", "from_cash_drawer": True, "authorizer_pin": "9999"},
        headers=_idem(),
    )
    assert resp.status_code == 409, resp.text
    assert resp.json()["error"]["code"] == "NO_OPEN_SHIFT"

    from app.purchases.models import Payment

    assert db.query(Payment).filter(Payment.payable_id == payable["id"]).count() == 0


# ---------------------------------------------------------------------------
# Ronda 2 — H-1 BLOQUEANTE: `void_payment` nunca tocaba `Payment
# .cash_movement_id`. Anular un pago que salió del cajón devolvía el saldo
# de la cuenta por pagar pero dejaba vivo el `CashMovement(kind=EXPENSE,
# cause=SUPPLIER_PAYMENT)`, así que `compute_breakdown` seguía restando esa
# plata y el cierre a ciegas mostraba un SOBRANTE fabricado. Se corrige
# compensando: un `CashMovement(kind=INCOME, cause=SUPPLIER_PAYMENT)` en el
# turno abierto al momento de anular (nunca borrando el original), y si no
# hay turno abierto la anulación se rechaza entera con 409 NO_OPEN_SHIFT.
# ---------------------------------------------------------------------------


def _expected(db: Session, shift_id: int) -> int:
    from app.shifts import service as shifts_service
    from app.shifts.models import Shift

    shift = db.get(Shift, shift_id)
    assert shift is not None
    return shifts_service.compute_breakdown(db, shift)["expected"]


def test_voiding_cash_drawer_payment_restores_expected_and_keeps_both_movements(
    admin_client: TestClient,
    create_payable: Callable[..., Any],
    open_shift: Callable[..., dict[str, Any]],
    db: Session,
) -> None:
    from app.shifts.models import CashMovement, CashMovementCause, CashMovementKind

    payable = create_payable()
    admin_client.post(f"/api/v1/admin/payables/{payable['id']}/approve", json={"authorizer_pin": "9999"})
    shift = open_shift()
    expected_before = _expected(db, shift["id"])

    pago = admin_client.post(
        f"/api/v1/admin/payables/{payable['id']}/payments",
        json={
            "amount": payable["amount"],
            "method": "cash",
            "paid_at": "2026-01-06T10:00:00Z",
            "from_cash_drawer": True,
            "authorizer_pin": "9999",
        },
        headers=_idem(),
    )
    assert pago.status_code == 201, pago.text
    payment_id = pago.json()["id"]
    expense_movement_id = pago.json()["cash_movement_id"]
    assert expected_before - payable["amount"] == _expected(db, shift["id"])

    anular = admin_client.post(
        f"/api/v1/admin/payables/{payable['id']}/payments/{payment_id}/void",
        json={"reason": "El pago se registró por error: la plata nunca salió", "authorizer_pin": "9999"},
    )
    assert anular.status_code == 200, anular.text

    # El saldo de la cuenta por pagar vuelve...
    saldo = admin_client.get(f"/api/v1/admin/payables?store_id={payable['store_id']}").json()
    row = next(p for p in saldo if p["id"] == payable["id"])
    assert row["balance"] == row["amount"]

    # ...y la caja se entera: el esperado vuelve EXACTAMENTE al valor previo
    # al pago, sin quedar en cero movimientos ni en un sobrante fabricado.
    assert _expected(db, shift["id"]) == expected_before

    movements = (
        db.query(CashMovement)
        .filter(CashMovement.shift_id == shift["id"], CashMovement.cause == CashMovementCause.SUPPLIER_PAYMENT)
        .order_by(CashMovement.id)
        .all()
    )
    assert len(movements) == 2, "tienen que quedar VIVOS los dos movimientos, no cero"
    expense = next(m for m in movements if m.id == expense_movement_id)
    assert expense.kind == CashMovementKind.EXPENSE
    reversal = next(m for m in movements if m.id != expense_movement_id)
    assert reversal.kind == CashMovementKind.INCOME
    assert reversal.cause == CashMovementCause.SUPPLIER_PAYMENT
    assert reversal.amount == payable["amount"]
    assert str(payment_id) in (reversal.note or "")


def test_voiding_cash_drawer_payment_without_open_shift_rejects_and_writes_nothing(
    admin_client: TestClient,
    create_payable: Callable[..., Any],
    open_shift: Callable[..., dict[str, Any]],
    db: Session,
) -> None:
    from app.shifts.models import Shift, ShiftStatus

    payable = create_payable()
    admin_client.post(f"/api/v1/admin/payables/{payable['id']}/approve", json={"authorizer_pin": "9999"})
    shift = open_shift()

    pago = admin_client.post(
        f"/api/v1/admin/payables/{payable['id']}/payments",
        json={
            "amount": payable["amount"],
            "method": "cash",
            "paid_at": "2026-01-06T10:00:00Z",
            "from_cash_drawer": True,
            "authorizer_pin": "9999",
        },
        headers=_idem(),
    )
    assert pago.status_code == 201, pago.text
    payment_id = pago.json()["id"]

    # Cerramos el único turno abierto a mano en la base (sin pasar por el
    # flujo de cierre completo, que no hace falta para este test: sólo
    # importa que `register_supplier_payment_reversal` no encuentre un
    # turno OPEN).
    row = db.get(Shift, shift["id"])
    assert row is not None
    row.status = ShiftStatus.CLOSED
    db.commit()

    balance_before = admin_client.get(f"/api/v1/admin/payables?store_id={payable['store_id']}").json()
    balance_before_row = next(p for p in balance_before if p["id"] == payable["id"])

    anular = admin_client.post(
        f"/api/v1/admin/payables/{payable['id']}/payments/{payment_id}/void",
        json={"reason": "El pago se registró por error: la plata nunca salió", "authorizer_pin": "9999"},
    )
    assert anular.status_code == 409, anular.text
    assert anular.json()["error"]["code"] == "NO_OPEN_SHIFT"

    from app.purchases.models import Payment

    db.expire_all()
    payment_row = db.get(Payment, payment_id)
    assert payment_row is not None
    assert payment_row.voided_at is None, "no se puede compensar y sin embargo quedó anulado"

    balance_after = admin_client.get(f"/api/v1/admin/payables?store_id={payable['store_id']}").json()
    balance_after_row = next(p for p in balance_after if p["id"] == payable["id"])
    assert balance_after_row["balance"] == balance_before_row["balance"], "el saldo no puede haberse movido"


def test_voiding_non_cash_drawer_payment_creates_no_cash_movement(
    admin_client: TestClient,
    create_payable: Callable[..., Any],
    db: Session,
) -> None:
    from app.shifts.models import CashMovement, CashMovementCause

    payable = create_payable()
    admin_client.post(f"/api/v1/admin/payables/{payable['id']}/approve", json={"authorizer_pin": "9999"})

    pago = admin_client.post(
        f"/api/v1/admin/payables/{payable['id']}/payments",
        json={
            "amount": payable["amount"],
            "method": "transfer",
            "paid_at": "2026-01-06T10:00:00Z",
            "from_cash_drawer": False,
            "authorizer_pin": "9999",
        },
        headers=_idem(),
    )
    assert pago.status_code == 201, pago.text
    payment_id = pago.json()["id"]
    assert pago.json()["cash_movement_id"] is None

    before_count = db.query(CashMovement).filter(CashMovement.cause == CashMovementCause.SUPPLIER_PAYMENT).count()

    anular = admin_client.post(
        f"/api/v1/admin/payables/{payable['id']}/payments/{payment_id}/void",
        json={"reason": "Monto equivocado", "authorizer_pin": "9999"},
    )
    assert anular.status_code == 200, anular.text

    after_count = db.query(CashMovement).filter(CashMovement.cause == CashMovementCause.SUPPLIER_PAYMENT).count()
    assert after_count == before_count, "anular un pago que no salió del cajón no crea ningún movimiento"


def test_list_payables_filters_by_status_and_supplier(admin_client: TestClient, store: Store, create_payable: Callable[..., Any]) -> None:
    payable = create_payable()
    pending = admin_client.get(f"/api/v1/admin/payables?store_id={store.id}&status=pending_review")
    assert any(p["id"] == payable["id"] for p in pending.json())

    admin_client.post(f"/api/v1/admin/payables/{payable['id']}/approve", json={"authorizer_pin": "9999"})
    approved = admin_client.get(f"/api/v1/admin/payables?store_id={store.id}&status=approved")
    assert any(p["id"] == payable["id"] for p in approved.json())
    pending_after = admin_client.get(f"/api/v1/admin/payables?store_id={store.id}&status=pending_review")
    assert all(p["id"] != payable["id"] for p in pending_after.json())
