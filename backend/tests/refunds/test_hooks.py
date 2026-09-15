"""`app.refunds.hooks.settle_or_queue_refund` — firma exacta del contrato:

    settle_or_queue_refund(db, *, organization_id, store_id, document_id,
                            method, amount, actor, now) -> RefundOutcome

Prueba la función directamente (no hay ruta de dispositivo: sólo la llama
`POST /admin/documents/{id}/notes`, territorio de `backend-fiscal`, que
todavía no existe — ver `tests/refunds/test_pending_refund_e2e.py` y
`gaps`)."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.deps import Actor
from app.auth.models import Employee
from app.core import clock as clock_module
from app.notifications.models import Notification
from app.refunds.hooks import settle_or_queue_refund
from app.refunds.models import PendingRefund, PendingRefundStatus
from app.shifts.models import CashMovement, CashMovementCause, CashMovementKind, Shift, ShiftStatus
from app.stores.models import Organization, Store


def _admin_actor(org: Organization, admin: Employee) -> Actor:
    return Actor(
        kind="admin", organization_id=org.id, store_id=None, employee_id=admin.id, employee_name=admin.name, role="admin"
    )


def test_cash_refund_with_open_shift_creates_a_refund_cash_movement(
    db: Session, org: Organization, store: Store, employees: dict[str, Employee], paid_order: Any
) -> None:
    payment = paid_order()
    document_id = payment["document"]["id"]
    shift_id = db.execute(select(Shift).where(Shift.store_id == store.id)).scalars().one().id

    outcome = settle_or_queue_refund(
        db,
        organization_id=org.id,
        store_id=store.id,
        document_id=document_id,
        method="cash",
        amount=5000,
        actor=_admin_actor(org, employees["admin"]),
        now=clock_module.now_utc(),
    )

    assert outcome.status == "settled_in_shift"
    assert outcome.shift_id == shift_id
    movement = db.get(CashMovement, outcome.cash_movement_id)
    assert movement is not None
    assert movement.cause == CashMovementCause.REFUND
    assert movement.kind == CashMovementKind.EXPENSE
    assert movement.amount == 5000
    assert movement.shift_id == shift_id

    # No debe crear ninguna devolución pendiente cuando sí había turno.
    pending = list(db.execute(select(PendingRefund).where(PendingRefund.store_id == store.id)).scalars())
    assert pending == []


def test_cash_refund_without_open_shift_queues_a_pending_refund_and_notifies(
    db: Session, org: Organization, store: Store, employees: dict[str, Employee], paid_order: Any
) -> None:
    payment = paid_order()
    document_id = payment["document"]["id"]

    shift = db.execute(select(Shift).where(Shift.store_id == store.id)).scalars().one()
    shift.status = ShiftStatus.CLOSED
    db.commit()

    outcome = settle_or_queue_refund(
        db,
        organization_id=org.id,
        store_id=store.id,
        document_id=document_id,
        method="cash",
        amount=5000,
        actor=_admin_actor(org, employees["admin"]),
        now=clock_module.now_utc(),
    )

    assert outcome.status == "pending"
    assert outcome.cash_movement_id is None
    pending = db.get(PendingRefund, outcome.pending_refund_id)
    assert pending is not None
    assert pending.status == PendingRefundStatus.PENDING
    assert pending.amount == 5000
    assert pending.document_id == document_id
    assert pending.customer_name == "Consumidor final"

    notifications = list(
        db.execute(select(Notification).where(Notification.type == "pending_refund", Notification.store_id == store.id)).scalars()
    )
    assert len(notifications) == 1
    assert notifications[0].payload["pending_refund_id"] == pending.id

    # No debe tocar ningún turno (el cerrado sigue igual, sin nuevos movimientos).
    movements = list(db.execute(select(CashMovement).where(CashMovement.shift_id == shift.id)).scalars())
    assert movements == []


def test_non_cash_method_is_settled_externally_without_creating_rows(
    db: Session, org: Organization, store: Store, employees: dict[str, Employee], paid_order: Any
) -> None:
    payment = paid_order()
    document_id = payment["document"]["id"]

    outcome = settle_or_queue_refund(
        db,
        organization_id=org.id,
        store_id=store.id,
        document_id=document_id,
        method="card",
        amount=5000,
        actor=_admin_actor(org, employees["admin"]),
        now=clock_module.now_utc(),
    )

    assert outcome.status == "settled_externally"
    assert outcome.pending_refund_id is None
    assert outcome.cash_movement_id is None
    pending = list(db.execute(select(PendingRefund)).scalars())
    assert pending == []
