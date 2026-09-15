"""Modelo de la devolución pendiente (`docs/SPEC-NEGOCIO.md §6.3`, `§3.5`;
`features/fase-1b-venta/spec.md` «Payments & fiscal document»).

Una nota (`POST /admin/documents/{id}/notes`, territorio de otro agente) que
devuelve plata en efectivo sin turno abierto no puede simplemente perderse:
`app.refunds.hooks.settle_or_queue_refund` deja acá el rastro (monto,
documento, cliente, quién autorizó) y `POST /admin/pending-refunds/{id}/settle`
la salda después, **desde un turno** (crea el egreso `refund` en ESE turno,
nunca en el original) **o «de la mano del dueño»** (sin movimiento de caja).

Convenciones heredadas (`docs/ESTADO.md`, `AGENTS.md`):
- `app.core.db.UTCDateTime` en todo `Mapped[datetime]`.
- Dinero en `Integer` (pesos enteros).
- Enums `native_enum=False`.
- Nada se borra: saldar es un cambio de estado (`status`, `settled_*`), nunca
  un DELETE ni una edición del monto/documento original.
"""

from __future__ import annotations

import enum
from datetime import datetime

import sqlalchemy as sa
from sqlalchemy import CheckConstraint, ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UTCDateTime

ENUM_LENGTH = 16


def _enum(pyenum: type[enum.Enum], *, length: int = ENUM_LENGTH) -> sa.Enum:
    return sa.Enum(pyenum, native_enum=False, length=length, validate_strings=True)


class PendingRefundStatus(str, enum.Enum):
    PENDING = "pending"
    SETTLED = "settled"


class SettleFrom(str, enum.Enum):
    """Quién puso la plata al saldar: un turno (crea egreso `refund` en ESE
    turno) o la mano del dueño (sin movimiento de caja, SPEC-NEGOCIO §6.3)."""

    SHIFT = "shift"
    OWNER = "owner"


class PendingRefund(Base):
    """Devolución en efectivo que no pudo salir de ningún turno porque no
    había uno abierto en el momento de la nota. `document_id` apunta al
    `FiscalDocument` (de otro dominio, sólo lectura: `app.fiscal.models`) que
    originó la devolución — igual que `app.payments.models.Payment
    .document_id`, ya un precedente de FK real cruzando dominios en este
    proyecto."""

    __tablename__ = "pending_refunds"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    document_id: Mapped[int] = mapped_column(ForeignKey("fiscal_documents.id"), index=True)

    customer_id: Mapped[int | None] = mapped_column(ForeignKey("customers.id"), nullable=True)
    # Snapshot del cliente al momento de la nota (nunca `NULL`: "Consumidor
    # final" / "222222222222" cuando el documento no tenía cliente
    # identificado) — igual criterio que `FiscalDocument.customer_name`.
    customer_name: Mapped[str] = mapped_column(sa.String(200))
    customer_doc_number: Mapped[str] = mapped_column(sa.String(20))

    amount: Mapped[int] = mapped_column(sa.Integer)
    method: Mapped[str] = mapped_column(sa.String(16))

    authorized_by_employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    authorized_by_employee_name: Mapped[str] = mapped_column(sa.String(200))
    requested_at: Mapped[datetime] = mapped_column(UTCDateTime())

    status: Mapped[PendingRefundStatus] = mapped_column(_enum(PendingRefundStatus), default=PendingRefundStatus.PENDING)

    settled_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    settled_from: Mapped[SettleFrom | None] = mapped_column(_enum(SettleFrom), nullable=True)
    settled_shift_id: Mapped[int | None] = mapped_column(ForeignKey("shifts.id"), nullable=True)
    settled_cash_movement_id: Mapped[int | None] = mapped_column(ForeignKey("cash_movements.id"), nullable=True)
    settled_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    settled_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    __table_args__ = (
        Index("ix_pending_refunds_store_status", "store_id", "status"),
        Index("ix_pending_refunds_document", "document_id"),
        CheckConstraint("amount > 0", name="ck_pending_refunds_amount_positive"),
    )
