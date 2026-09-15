"""Gancho que consume la emisión de notas (`POST /admin/documents/{id}/notes`,
territorio de `backend-fiscal`) para devolver plata en efectivo
(`docs/SPEC-NEGOCIO.md §6.3`, §3.5).

`settle_or_queue_refund` es la ÚNICA puerta por la que una nota mueve caja:
si hay turno abierto en la sede, el egreso `refund` se crea ahí mismo; si no,
la devolución queda **pendiente** (monto, cliente, documento, quién la
autorizó) y dispara `notify("pending_refund")`. El dueño del test de punta a
punta de este gancho (nota → pendiente → `settle`) es este mismo territorio
(`backend-clientes-dinero`): `tests/refunds/test_pending_refund_e2e.py`
llama `POST /admin/documents/{id}/notes` si ya existe; si no, deja el test
escrito y lo declara en `gaps`.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.customers.models import Customer
from app.fiscal.models import FiscalDocument
from app.notifications.service import notify
from app.refunds.models import PendingRefund, PendingRefundStatus
from app.shifts.models import CashMovement, CashMovementCause, CashMovementKind, Shift, ShiftStatus

_DEFAULT_CUSTOMER_NAME = "Consumidor final"
_DEFAULT_CUSTOMER_DOC_NUMBER = "222222222222"


@dataclass(frozen=True)
class RefundOutcome:
    """Resultado de `settle_or_queue_refund`.

    - `"settled_in_shift"`: había turno abierto; se creó el `CashMovement`
      (`cash_movement_id`, `shift_id` llenos).
    - `"pending"`: no había turno abierto; se creó la fila de
      `pending_refunds` (`pending_refund_id` lleno) y se notificó.
    - `"settled_externally"`: el medio no es efectivo (tarjeta/transferencia):
      la reversa la hace el adquirente/banco fuera de este sistema, así que
      no hay ni movimiento de caja ni devolución pendiente que rastrear acá
      (decisión declarada en el entregable — SPEC-NEGOCIO §6.3 sólo describe
      el circuito de efectivo).
    """

    status: Literal["settled_in_shift", "pending", "settled_externally"]
    pending_refund_id: int | None = None
    cash_movement_id: int | None = None
    shift_id: int | None = None


def _document_customer_snapshot(db: Session, document_id: int) -> tuple[int | None, str, str]:
    """Lee (sólo lectura) el snapshot de cliente del `FiscalDocument` — nunca
    se escribe nada en `app.fiscal`. Si el documento tiene un `Customer`
    administrado con el mismo documento, se linkea por `customer_id`; si no
    (consumidor final, o el documento fue emitido antes de que existiera un
    maestro para ese número), se guarda igual el nombre/documento como texto
    congelado — nunca `NULL`."""

    document = db.get(FiscalDocument, document_id)
    if document is None:
        return None, _DEFAULT_CUSTOMER_NAME, _DEFAULT_CUSTOMER_DOC_NUMBER

    customer_id: int | None = None
    if document.customer_doc_number != _DEFAULT_CUSTOMER_DOC_NUMBER:
        customer = db.execute(
            select(Customer).where(
                Customer.organization_id == document.organization_id,
                Customer.doc_type == document.customer_doc_type,
                Customer.doc_number == document.customer_doc_number,
            )
        ).scalar_one_or_none()
        customer_id = customer.id if customer is not None else None

    return customer_id, document.customer_name, document.customer_doc_number


def settle_or_queue_refund(
    db: Session,
    *,
    organization_id: int,
    store_id: int,
    document_id: int,
    method: str,
    amount: int,
    actor: Any,
    now: datetime,
    order_id: int | None = None,
    reason: str | None = None,
) -> RefundOutcome:
    """`order_id`/`reason` son OPCIONALES y no forman parte de la firma que
    publica el contrato (`organization_id, store_id, document_id, method,
    amount, actor, now`) — se aceptan además porque
    `app.fiscal.service.settle_or_queue_refund_for_note` (territorio de
    `backend-fiscal`) ya los manda al llamar este gancho (`note.order_id`,
    `note.reason`); ignorarlos con un `TypeError` de argumento inesperado
    rompería la integración real, así que se usan sólo para enriquecer la
    nota del movimiento/la devolución pendiente, nunca para decidir el
    resultado."""

    if method != "cash":
        # Fuera de efectivo: la reversa la resuelve el adquirente/el banco,
        # no el cajón. Nada que crear acá (ver `RefundOutcome.status` doc).
        return RefundOutcome(status="settled_externally")

    customer_id, customer_name, customer_doc_number = _document_customer_snapshot(db, document_id)
    note_suffix = f" — {reason}" if reason else ""

    open_shift = db.execute(
        select(Shift).where(Shift.store_id == store_id, Shift.status == ShiftStatus.OPEN)
    ).scalar_one_or_none()

    if open_shift is not None:
        movement = CashMovement(
            organization_id=organization_id,
            store_id=store_id,
            shift_id=open_shift.id,
            kind=CashMovementKind.EXPENSE,
            cause=CashMovementCause.REFUND,
            amount=amount,
            note=f"Devolución por nota — documento #{document_id}{note_suffix}",
            employee_id=getattr(actor, "employee_id", None),
            employee_name=getattr(actor, "employee_name", None),
            authorized_by_employee_id=getattr(actor, "employee_id", None),
            authorized_by_employee_name=getattr(actor, "employee_name", None),
            at=now,
        )
        db.add(movement)
        db.flush()
        return RefundOutcome(status="settled_in_shift", cash_movement_id=movement.id, shift_id=open_shift.id)

    pending = PendingRefund(
        organization_id=organization_id,
        store_id=store_id,
        document_id=document_id,
        customer_id=customer_id,
        customer_name=customer_name,
        customer_doc_number=customer_doc_number,
        amount=amount,
        method=method,
        authorized_by_employee_id=getattr(actor, "employee_id", None),
        authorized_by_employee_name=getattr(actor, "employee_name", None),
        requested_at=now,
        status=PendingRefundStatus.PENDING,
    )
    db.add(pending)
    db.flush()

    notify(
        db,
        organization_id=organization_id,
        store_id=store_id,
        type="pending_refund",
        level="warning",
        title="Devolución pendiente",
        body=f"Hay ${amount:,} por devolver a {customer_name} sin turno abierto para pagarla".replace(",", "."),
        payload={"pending_refund_id": pending.id, "document_id": document_id, "amount": amount},
    )
    return RefundOutcome(status="pending", pending_refund_id=pending.id)
