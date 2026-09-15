"""Modelos del maestro de clientes y habeas data (`docs/SPEC-NEGOCIO.md §8.4`,
Ley 1581 de 2012 y Decreto 1377 de 2013; `features/fase-1b-venta/spec.md`
«Customers»).

**El punto delicado de este dominio**: `POST /admin/customers/{id}/erase`
anonimiza `Customer` (el maestro) pero JAMÁS toca `app.fiscal.models.FiscalDocument`
— el snapshot (`customer_doc_type`/`customer_doc_number`/`customer_name`) de un
documento ya emitido es evidencia fiscal inmutable (conservación 5 años,
SPEC-NEGOCIO §8.3) y vive en una tabla de otro dominio que este módulo nunca
escribe.

Convenciones heredadas (`docs/ESTADO.md`, `AGENTS.md`):
- `app.core.db.UTCDateTime` en todo `Mapped[datetime]`.
- Enums `native_enum=False`, comparados por valor.
- Nada se borra físicamente: `erase` es una anonimización en el lugar (columnas
  a placeholder), nunca un DELETE; la bitácora de solicitudes queda aparte y
  también es de sólo agregar.
- Único por `(organization_id, doc_type, doc_number)`: los clientes se
  reutilizan por número de documento **dentro de la organización** (una
  persona puede comprar en varias sedes de la misma cadena); tras `erase`,
  `doc_type`/`doc_number` pasan a un placeholder único por fila para liberar
  el documento original y permitir que un futuro cobro cree un cliente nuevo
  con ese mismo número.
"""

from __future__ import annotations

import enum
from datetime import datetime

import sqlalchemy as sa
from sqlalchemy import ForeignKey, Index, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UTCDateTime

ENUM_LENGTH = 16


def _enum(pyenum: type[enum.Enum], *, length: int = ENUM_LENGTH) -> sa.Enum:
    return sa.Enum(pyenum, native_enum=False, length=length, validate_strings=True)


class ConsentPurpose(str, enum.Enum):
    """`docs/SPEC-NEGOCIO.md §8.4`: los datos mínimos para facturar se amparan
    en la obligación legal; cualquier uso adicional (mercadeo) exige
    autorización separada."""

    INVOICE = "invoice"
    MARKETING = "marketing"


class DataRequestKind(str, enum.Enum):
    """Derechos del titular (§8.4): consultar, rectificar, revocar, suprimir."""

    ACCESS = "access"
    RECTIFY = "rectify"
    REVOKE = "revoke"
    ERASE = "erase"


# Placeholders que deja `erase` en el maestro (nunca `NULL`: un `name`/`doc_number`
# vacío rompería otras pantallas que asumen el campo presente).
ERASED_NAME = "Cliente anonimizado"
ERASED_DOC_TYPE = "ERASED"


class Customer(Base):
    """El maestro de clientes. `store_id` es la sede donde se creó (o la
    última que lo tocó al cobrar); la unicidad y la búsqueda son a nivel de
    **organización** porque "los clientes se reutilizan por número de
    documento" sin importar en qué sede de la cadena compraron.

    El dispositivo sólo lo crea/actualiza vía `app.customers.hooks
    .upsert_customer_with_consent` (llamado desde `app.payments.service
    .pay_order`); nunca lo lista ni lo exporta (minimización, §8.4). El admin
    lo administra por `app.customers.router`.
    """

    __tablename__ = "customers"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int | None] = mapped_column(ForeignKey("stores.id"), nullable=True, index=True)

    # Códigos DIAN de tipo de documento: "13" cédula, "31" NIT, "22", "41"...
    doc_type: Mapped[str] = mapped_column(sa.String(4))
    doc_number: Mapped[str] = mapped_column(sa.String(20))
    dv: Mapped[str | None] = mapped_column(sa.String(1), nullable=True)

    name: Mapped[str] = mapped_column(sa.String(200))
    email: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)
    address: Mapped[str | None] = mapped_column(sa.String(300), nullable=True)
    municipality_dane: Mapped[str | None] = mapped_column(sa.String(10), nullable=True)

    created_at: Mapped[datetime] = mapped_column(UTCDateTime())
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime())

    # Anonimización (§8.4 "suprimir"). `erased_at IS NOT NULL` marca el
    # maestro como anonimizado; la fila NUNCA se borra ni se oculta del admin
    # (queda visible con el placeholder, con su bitácora de solicitudes).
    erased_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    erased_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    erased_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    __table_args__ = (
        UniqueConstraint("organization_id", "doc_type", "doc_number", name="uq_customers_org_doc"),
        Index("ix_customers_org_doc_number", "organization_id", "doc_number"),
    )


class CustomerConsent(Base):
    """Prueba de autorización: finalidad declarada, canal, versión del texto y
    quién la registró (§8.4 "autorización previa, expresa e informada").
    Nunca se edita ni se borra: un cambio de decisión (revocar) es una fila
    NUEVA con `granted=False`, no una edición de la anterior — así la
    bitácora completa de consentimientos queda intacta."""

    __tablename__ = "customer_consents"

    id: Mapped[int] = mapped_column(primary_key=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"), index=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int | None] = mapped_column(ForeignKey("stores.id"), nullable=True)

    purpose: Mapped[ConsentPurpose] = mapped_column(_enum(ConsentPurpose))
    granted: Mapped[bool] = mapped_column(sa.Boolean)
    channel: Mapped[str] = mapped_column(sa.String(50))
    text_version: Mapped[str] = mapped_column(sa.String(50))

    registered_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    registered_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)
    at: Mapped[datetime] = mapped_column(UTCDateTime())

    __table_args__ = (Index("ix_customer_consents_customer_at", "customer_id", "at"),)


class CustomerDataRequest(Base):
    """Bitácora de solicitudes del titular (`GET /admin/customers/{id}/requests`):
    consultar, rectificar, revocar, suprimir — con fecha y respuesta. Sólo se
    agrega; nunca se edita una fila ya escrita (una corrección es una fila
    nueva)."""

    __tablename__ = "customer_data_requests"

    id: Mapped[int] = mapped_column(primary_key=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"), index=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int | None] = mapped_column(ForeignKey("stores.id"), nullable=True)

    kind: Mapped[DataRequestKind] = mapped_column(_enum(DataRequestKind))
    note: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    response: Mapped[str | None] = mapped_column(sa.Text, nullable=True)

    requested_at: Mapped[datetime] = mapped_column(UTCDateTime())
    responded_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)

    employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    __table_args__ = (Index("ix_customer_data_requests_customer_at", "customer_id", "requested_at"),)


CustomerDataRequestKindValues = tuple(k.value for k in DataRequestKind)
ConsentPurposeValues = tuple(p.value for p in ConsentPurpose)
