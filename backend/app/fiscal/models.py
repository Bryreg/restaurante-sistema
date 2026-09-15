"""Modelos del comprobante interno de venta y su consecutivo
(`features/fase-1b-venta/CONTRATO-INTERNO-1b-1.md §2.2`, vinculante: nombres
de tabla y columna los leen tal cual el auditor, `backend-comanda`
(`app.orders.service._order_document_id`) y el frontend).

**Nada de esto se emite ni se transmite en 1b-1.** El modelo ya se llama
`FiscalDocument` (tipo `pos_equivalent`) para que 1b-2 sólo tenga que agregar
el adaptador `FiscalProvider`, rangos DIAN y estados de validación; acá
`dian_status` queda `pending` (o `NULL` en `internal_receipt`) y los campos de
evidencia (`cude`, `qr_url`, `xml_ref`, `provider_response`,
`fiscal_range_id`, `validated_at`) quedan `NULL` siempre.

Convenciones heredadas (`docs/ESTADO.md`, `AGENTS.md`):
- `app.core.db.UTCDateTime` en todo `Mapped[datetime]`.
- Dinero en `Integer` (pesos enteros); tasas de impuesto como entero por
  ciento (`8`, `19`, `0`).
- Enums `native_enum=False`, comparados por valor.
- Nada se borra ni se edita después de emitido: reimprimir sólo cuenta
  (`DocumentReprint`), nunca reescribe el documento.
"""

from __future__ import annotations

import enum
from datetime import date, datetime
from typing import Any

import sqlalchemy as sa
from sqlalchemy import CheckConstraint, ForeignKey, Index, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UTCDateTime

ENUM_LENGTH = 32


def _enum(pyenum: type[enum.Enum], *, length: int = ENUM_LENGTH) -> sa.Enum:
    return sa.Enum(pyenum, native_enum=False, length=length, validate_strings=True)


class FiscalDocumentType(str, enum.Enum):
    POS_EQUIVALENT = "pos_equivalent"
    INVOICE = "invoice"  # 1b-2
    ADJUSTMENT_NOTE = "adjustment_note"  # 1b-2
    CREDIT_NOTE = "credit_note"  # 1b-2
    DEBIT_NOTE = "debit_note"  # 1b-2
    INTERNAL_RECEIPT = "internal_receipt"


class DianStatus(str, enum.Enum):
    PENDING = "pending"
    SENT = "sent"  # 1b-2
    VALIDATED = "validated"  # 1b-2
    REJECTED = "rejected"  # 1b-2
    CONTINGENCY = "contingency"  # 1b-2


DOCUMENT_STATUS_VALUES = ("issued", "reversed")


class FiscalCounter(Base):
    """Consecutivo por sede, tipo de documento y prefijo. `reserve_next_number`
    (`app.fiscal.service`) lo lee con `SELECT ... FOR UPDATE` dentro de la
    transacción del cobro: sin huecos, sin reutilización (SPEC-NEGOCIO §8.3)."""

    __tablename__ = "fiscal_counters"

    id: Mapped[int] = mapped_column(primary_key=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    document_type: Mapped[FiscalDocumentType] = mapped_column(_enum(FiscalDocumentType, length=24))
    prefix: Mapped[str] = mapped_column(sa.String(10))
    next_number: Mapped[int] = mapped_column(sa.Integer, default=1)

    __table_args__ = (
        UniqueConstraint("store_id", "document_type", "prefix", name="uq_fiscal_counters_scope"),
        CheckConstraint("next_number >= 1", name="ck_fiscal_counters_next_number_positive"),
    )


class FiscalDocument(Base):
    """El comprobante emitido al cobrar (o al cobrar una sub-cuenta). En 1b-1
    es siempre `pos_equivalent` (con `fiscal.dee_pos` encendida) o
    `internal_receipt` (apagada); nunca se transmite ni se valida: eso es
    1b-2, y por eso `cude`/`qr_url`/`xml_ref`/`provider_response`/
    `fiscal_range_id`/`validated_at` quedan siempre `NULL`."""

    __tablename__ = "fiscal_documents"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    sub_account_id: Mapped[int | None] = mapped_column(
        ForeignKey("order_sub_accounts.id"), nullable=True, index=True
    )
    shift_id: Mapped[int] = mapped_column(ForeignKey("shifts.id"), index=True)

    # "order:{order_id}" o "sub:{sub_account_id}" -> un documento por comanda
    # o por sub-cuenta (índice único: el respaldo de `claim_payment` ante una
    # carrera que se le escape, `CONTRATO-INTERNO-1b-1.md §2.4`).
    target_key: Mapped[str] = mapped_column(sa.String(40), unique=True)

    document_type: Mapped[FiscalDocumentType] = mapped_column(_enum(FiscalDocumentType, length=24))
    prefix: Mapped[str] = mapped_column(sa.String(10))
    number: Mapped[int] = mapped_column(sa.Integer)

    dian_status: Mapped[DianStatus | None] = mapped_column(_enum(DianStatus, length=16), nullable=True)
    legend: Mapped[str] = mapped_column(sa.String(200))

    business_date: Mapped[date] = mapped_column(sa.Date)
    issued_at: Mapped[datetime] = mapped_column(UTCDateTime())

    customer_doc_type: Mapped[str] = mapped_column(sa.String(4), default="13")
    customer_doc_number: Mapped[str] = mapped_column(sa.String(20), default="222222222222")
    customer_name: Mapped[str] = mapped_column(sa.String(200), default="Consumidor final")

    # {legal_name, nit, dv, address, municipality_dane, regime, person_type}
    store_snapshot: Mapped[dict[str, Any]] = mapped_column(sa.JSON)
    # [{item_id, qty, description, unit_price, gross, discount, net, tax_rate, base, tax, courtesy}]
    lines: Mapped[list[dict[str, Any]]] = mapped_column(sa.JSON)

    subtotal: Mapped[int] = mapped_column(sa.Integer)
    discount_total: Mapped[int] = mapped_column(sa.Integer)
    tax_total: Mapped[int] = mapped_column(sa.Integer)
    total: Mapped[int] = mapped_column(sa.Integer)
    tax_lines: Mapped[list[dict[str, Any]]] = mapped_column(sa.JSON)  # [{rate, base, tax}]

    tip_amount: Mapped[int] = mapped_column(sa.Integer, default=0)
    tip_suggested_pct: Mapped[Any] = mapped_column(sa.Numeric(5, 2), nullable=True)
    tip_accepted: Mapped[bool | None] = mapped_column(sa.Boolean, nullable=True)
    tip_modified: Mapped[bool | None] = mapped_column(sa.Boolean, nullable=True)

    # [{method, label, dian_code, amount, tip_amount, tendered, change, reference}]
    payments_snapshot: Mapped[list[dict[str, Any]]] = mapped_column(sa.JSON)

    channel: Mapped[str] = mapped_column(sa.String(16))
    tables_text: Mapped[str | None] = mapped_column(sa.String(100), nullable=True)
    covers: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    served_by_name: Mapped[str] = mapped_column(sa.String(200))
    charged_by_employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    charged_by_employee_name: Mapped[str] = mapped_column(sa.String(200))

    # Evidencia DIAN: siempre NULL en 1b-1 (1b-2 los llena vía FiscalProvider).
    fiscal_range_id: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    cude: Mapped[str | None] = mapped_column(sa.String(96), nullable=True)
    qr_url: Mapped[str | None] = mapped_column(sa.String(500), nullable=True)
    xml_ref: Mapped[str | None] = mapped_column(sa.String(500), nullable=True)
    provider_response: Mapped[dict[str, Any] | None] = mapped_column(sa.JSON, nullable=True)
    validated_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)

    status: Mapped[str] = mapped_column(
        sa.Enum(*DOCUMENT_STATUS_VALUES, name="fiscal_document_status", native_enum=False, length=16),
        default="issued",
    )
    print_count: Mapped[int] = mapped_column(sa.Integer, default=1)
    reprint_count: Mapped[int] = mapped_column(sa.Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime())

    __table_args__ = (
        UniqueConstraint(
            "store_id", "document_type", "prefix", "number", name="uq_fiscal_documents_consecutive"
        ),
        Index("ix_fiscal_documents_order", "order_id"),
        Index("ix_fiscal_documents_store_business_date", "store_id", "business_date"),
        Index("ix_fiscal_documents_shift", "shift_id"),
        CheckConstraint("number >= 1", name="ck_fiscal_documents_number_positive"),
    )


class DocumentReprint(Base):
    """Cada reimpresión cuenta (SPEC-NEGOCIO §3.4): nunca se borra ni se
    resta; `FiscalDocument.reprint_count` es la suma de estas filas."""

    __tablename__ = "document_reprints"

    id: Mapped[int] = mapped_column(primary_key=True)
    document_id: Mapped[int] = mapped_column(ForeignKey("fiscal_documents.id"), index=True)
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    employee_name: Mapped[str] = mapped_column(sa.String(200))
    at: Mapped[datetime] = mapped_column(UTCDateTime())
