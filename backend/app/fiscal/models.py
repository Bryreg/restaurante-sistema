"""Modelos del documento fiscal, su consecutivo y los rangos de numeración
DIAN (`features/fase-1b-venta/CONTRATO-INTERNO-1b-1.md §2.2`, extendido por
`features/fase-1b-venta/outputs-1b-2/backend-fiscal.md`). Nombres de tabla y
columna son vinculantes: el auditor y el frontend los leen tal cual.

**Pedido 1b-2** activa lo que 1b-1 dejó moldeado: `DianStatus` ya usa
`sent`/`validated`/`rejected`/`contingency`; `FiscalDocumentType` ya usa
`invoice`/`adjustment_note`/`credit_note`/`debit_note`; los campos de
evidencia (`cude`, `qr_url`, `xml_ref`, `provider_response`, `validated_at`)
se llenan de verdad vía `app.fiscal.provider.FiscalProvider`.

**Decisión declarada** (`backend-fiscal`, 1b-2): `FiscalCounter` NO se
absorbe en `FiscalRange` — se mantiene, pero acotado a `internal_receipt`
(el comprobante interno de una sede que declaró no estar obligada a facturar
no es un documento DIAN y no exige que el admin cargue un rango). Todo tipo
DIAN-trazable (`pos_equivalent`, `invoice`, `adjustment_note`, `credit_note`,
`debit_note`) reserva su número DENTRO de un `FiscalRange` vigente
(`app.fiscal.service.reserve_next_number`); sin rango vigente, el cobro
falla con `400 NO_FISCAL_RANGE`/`FISCAL_RANGE_EXHAUSTED`, nunca un `500`.
`fiscal_range_id` pasa de `Integer` pelado a FK real a `fiscal_ranges.id`
(mismo patrón que dejó `fiscal_documents.fiscal_range_id` listo desde 1b-1).

`FiscalDocument.customer_id` queda **Integer sin FK dura** a propósito: el
dominio `app.customers` puede no tener `models.py` todavía cuando este
archivo se importa (construcción en paralelo, mismo patrón que dejó
`fiscal_range_id` pelado en 1b-1 — `docs/ESTADO.md`, `find_spec_safe`); una
FK a una tabla que `app.core.models_registry.MODEL_MODULES` todavía no
registra rompería `Base.metadata.create_all()` de TODO el árbol, no sólo el
mío. Cuando `customers` esté consolidado en `MODEL_MODULES`, un pedido
futuro la convierte en FK real, igual que este pedido hizo con
`fiscal_range_id`.

`FiscalDocument.reverses_document_id` es nuevo (1b-2): FK real y
auto-referencial — NULL en un documento normal; en una nota
(`adjustment_note`/`credit_note`/`debit_note`) apunta al documento que
corrige, que a su vez queda `status="reversed"`. No se necesita una tabla
`notes` aparte: una nota **es** un `FiscalDocument` con otro `document_type`
y su propio consecutivo (su propio `fiscal_range_id`), como pide
SPEC-NEGOCIO §8.3 («toda corrección va por nota, nunca editando ni
borrando»).

Convenciones heredadas (`docs/ESTADO.md`, `AGENTS.md`):
- `app.core.db.UTCDateTime` en todo `Mapped[datetime]`.
- Dinero en `Integer` (pesos enteros); tasas de impuesto como entero por
  ciento (`8`, `19`, `0`).
- Enums `native_enum=False`, comparados por valor.
- Nada se borra ni se edita después de emitido: reimprimir sólo cuenta
  (`DocumentReprint`), nunca reescribe el documento; una nota reversa por
  fila nueva, nunca por `UPDATE` del documento original salvo su `status`.
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
    """Consecutivo simple por sede, tipo de documento y prefijo — **acotado a
    `internal_receipt`** desde 1b-2 (decisión declarada arriba). Todo lo
    demás usa `FiscalRange`. `SELECT ... FOR UPDATE` dentro de la
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


class FiscalRange(Base):
    """Rango de numeración autorizado por la DIAN (SPEC-NEGOCIO §8.3): por
    sede y tipo de documento, prefijo, desde/hasta, resolución y vigencia.

    `next_number` (interno) es el próximo número a reservar; `consumed` NO se
    guarda como columna — se deriva (`next_number - from_number`) para que no
    exista un lugar donde quede desincronizado de la reserva real. El cobro
    (`app.fiscal.service.reserve_next_number`) selecciona con
    `SELECT ... FOR UPDATE` el rango de mayor `valid_from` cuya vigencia
    cubre la fecha de negocio y que todavía tiene números libres
    (`next_number <= to_number`); sin uno así, `400 NO_FISCAL_RANGE` (nada
    vigente) o `400 FISCAL_RANGE_EXHAUSTED` (vigente pero agotado) — nunca
    `500`. Puede haber varias filas históricas por `(store, document_type,
    prefix)`: cuando un rango se agota o vence, el admin carga uno nuevo (una
    nueva resolución) sin borrar el anterior."""

    __tablename__ = "fiscal_ranges"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    document_type: Mapped[FiscalDocumentType] = mapped_column(_enum(FiscalDocumentType, length=24))
    prefix: Mapped[str] = mapped_column(sa.String(10))
    from_number: Mapped[int] = mapped_column(sa.Integer)
    to_number: Mapped[int] = mapped_column(sa.Integer)
    next_number: Mapped[int] = mapped_column(sa.Integer)
    resolution_number: Mapped[str] = mapped_column(sa.String(50))
    resolution_date: Mapped[date] = mapped_column(sa.Date)
    valid_from: Mapped[date] = mapped_column(sa.Date)
    valid_until: Mapped[date] = mapped_column(sa.Date)
    technical_key: Mapped[str | None] = mapped_column(sa.String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime())

    __table_args__ = (
        Index("ix_fiscal_ranges_store_type", "store_id", "document_type"),
        CheckConstraint("from_number >= 1", name="ck_fiscal_ranges_from_positive"),
        CheckConstraint("to_number >= from_number", name="ck_fiscal_ranges_to_gte_from"),
        CheckConstraint("next_number >= from_number", name="ck_fiscal_ranges_next_gte_from"),
        CheckConstraint("next_number <= to_number + 1", name="ck_fiscal_ranges_next_lte_to_plus_one"),
        CheckConstraint("valid_until >= valid_from", name="ck_fiscal_ranges_valid_until_gte_from"),
    )


class FiscalDocument(Base):
    """El comprobante emitido al cobrar (o al cobrar una sub-cuenta), o una
    nota que corrige uno anterior (`adjustment_note`/`credit_note`/
    `debit_note`, con `reverses_document_id` apuntando al original). Desde
    1b-2 se transmite de verdad vía `app.fiscal.provider.FiscalProvider`:
    `cude`/`qr_url`/`xml_ref`/`provider_response`/`validated_at` se llenan
    según lo que responda el proveedor (siguen `NULL` mientras el proveedor
    no diga algo mejor, y siempre `NULL` en `internal_receipt`, que nunca se
    transmite). `fiscal_range_id` es `NULL` sólo en `internal_receipt`."""

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

    # Integer sin FK dura a propósito (ver docstring del módulo):
    # `app.customers` puede no estar en `MODEL_MODULES` todavía.
    customer_id: Mapped[int | None] = mapped_column(sa.Integer, nullable=True, index=True)
    customer_doc_type: Mapped[str] = mapped_column(sa.String(4), default="13")
    customer_doc_number: Mapped[str] = mapped_column(sa.String(20), default="222222222222")
    customer_name: Mapped[str] = mapped_column(sa.String(200), default="Consumidor final")
    customer_email: Mapped[str | None] = mapped_column(sa.String(255), nullable=True)
    customer_address: Mapped[str | None] = mapped_column(sa.String(300), nullable=True)
    customer_municipality_dane: Mapped[str | None] = mapped_column(sa.String(6), nullable=True)

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

    # Evidencia DIAN: NULL mientras el proveedor no responda algo mejor
    # (`app.fiscal.provider.FiscalProvider`). `fiscal_range_id` es FK real
    # desde 1b-2 (era Integer pelado en 1b-1): NULL sólo en `internal_receipt`
    # (usa `FiscalCounter`, no un rango DIAN).
    fiscal_range_id: Mapped[int | None] = mapped_column(
        ForeignKey("fiscal_ranges.id"), nullable=True, index=True
    )
    cude: Mapped[str | None] = mapped_column(sa.String(96), nullable=True)
    qr_url: Mapped[str | None] = mapped_column(sa.String(500), nullable=True)
    xml_ref: Mapped[str | None] = mapped_column(sa.String(500), nullable=True)
    provider_response: Mapped[dict[str, Any] | None] = mapped_column(sa.JSON, nullable=True)
    validated_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)

    # NULL en un documento normal; en una nota, el documento que corrige
    # (que a su vez queda `status="reversed"`). FK auto-referencial (1b-2).
    reverses_document_id: Mapped[int | None] = mapped_column(
        ForeignKey("fiscal_documents.id"), nullable=True, index=True
    )
    # NULL en un documento normal; en una nota, el motivo declarado en
    # `POST /admin/documents/{id}/notes` (spec §3.5, §6.3).
    reason: Mapped[str | None] = mapped_column(sa.String(300), nullable=True)

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
        Index("ix_fiscal_documents_dian_status", "dian_status"),
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
