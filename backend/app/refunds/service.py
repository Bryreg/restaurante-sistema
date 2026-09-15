"""`GET /admin/pending-refunds` y `POST /admin/pending-refunds/{id}/settle`.

Saldar **desde un turno** crea el egreso `refund` en ESE turno (nunca toca el
turno/documento original); saldar **de la mano del dueño** no mueve caja
(`docs/SPEC-NEGOCIO.md §6.3`).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.core.errors import AppError, NotFoundError
from app.refunds.models import PendingRefund, PendingRefundStatus, SettleFrom
from app.shifts.models import CashMovement, CashMovementCause, CashMovementKind, Shift, ShiftStatus


def get_pending_refund_or_404(db: Session, *, organization_id: int, pending_refund_id: int) -> PendingRefund:
    row = db.get(PendingRefund, pending_refund_id)
    if row is None or row.organization_id != organization_id:
        raise NotFoundError("La devolución pendiente no existe en esta organización")
    return row


def list_pending_refunds(
    db: Session, *, organization_id: int, store_id: int | None = None, status: str | None = None
) -> list[PendingRefund]:
    stmt = select(PendingRefund).where(PendingRefund.organization_id == organization_id)
    if store_id is not None:
        stmt = stmt.where(PendingRefund.store_id == store_id)
    if status is not None:
        stmt = stmt.where(PendingRefund.status == status)
    stmt = stmt.order_by(PendingRefund.requested_at.desc())
    return list(db.execute(stmt).scalars())


def settle_pending_refund(
    db: Session,
    *,
    actor: Any,
    pending_refund: PendingRefund,
    settle_from: str,
    shift_id: int | None,
    now: datetime,
) -> PendingRefund:
    if pending_refund.status == PendingRefundStatus.SETTLED:
        raise AppError(
            code="PENDING_REFUND_ALREADY_SETTLED",
            message="Esta devolución pendiente ya fue saldada",
            status=400,
        )

    before = {"status": pending_refund.status.value}

    if settle_from == "shift":
        if shift_id is None:
            raise AppError(
                code="SHIFT_ID_REQUIRED",
                message="Indicá desde qué turno se salda la devolución (shift_id)",
                status=400,
            )
        shift = db.get(Shift, shift_id)
        if shift is None or shift.organization_id != pending_refund.organization_id or shift.store_id != pending_refund.store_id:
            raise NotFoundError("El turno no existe en esta sede")
        if shift.status != ShiftStatus.OPEN:
            raise AppError(
                code="SHIFT_NOT_OPEN",
                message="El turno elegido no está abierto; abrí un turno para saldar la devolución desde caja",
                status=400,
            )

        movement = CashMovement(
            organization_id=pending_refund.organization_id,
            store_id=pending_refund.store_id,
            shift_id=shift.id,
            kind=CashMovementKind.EXPENSE,
            cause=CashMovementCause.REFUND,
            amount=pending_refund.amount,
            note=f"Devolución pendiente #{pending_refund.id} saldada desde este turno",
            employee_id=getattr(actor, "employee_id", None),
            employee_name=getattr(actor, "employee_name", None),
            authorized_by_employee_id=getattr(actor, "employee_id", None),
            authorized_by_employee_name=getattr(actor, "employee_name", None),
            at=now,
        )
        db.add(movement)
        db.flush()
        pending_refund.settled_shift_id = shift.id
        pending_refund.settled_cash_movement_id = movement.id
        pending_refund.settled_from = SettleFrom.SHIFT
    else:
        # "De la mano del dueño": no crea movimiento de caja (SPEC-NEGOCIO §6.3).
        pending_refund.settled_from = SettleFrom.OWNER

    pending_refund.status = PendingRefundStatus.SETTLED
    pending_refund.settled_at = now
    pending_refund.settled_by_employee_id = getattr(actor, "employee_id", None)
    pending_refund.settled_by_employee_name = getattr(actor, "employee_name", None)
    db.flush()

    record_audit(
        db,
        actor=actor,
        organization_id=pending_refund.organization_id,
        store_id=pending_refund.store_id,
        entity="pending_refund",
        entity_id=pending_refund.id,
        action="settle",
        before=before,
        after={"status": pending_refund.status.value, "settled_from": pending_refund.settled_from.value},
        reason=None,
    )
    return pending_refund
