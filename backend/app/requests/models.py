"""Modelos de `requests`: lo que el salón le pide al administrador.

Dos clases de solicitud comparten **una sola tabla** (`staff_requests`, herencia
de tabla única con `kind` como discriminador) por una razón de contrato: la
bandeja del administrador las resuelve con las mismas rutas
(`/admin/requests/{id}/approve`, `/reject`), y dos tablas darían dos series de
ids que chocan en esa ruta. Cada clase tiene su nombre en Python
(`SupplyRequest`, `ChangeRequest`) y sus columnas propias son nulables en la
tabla común; el servicio es quien exige las que a cada una le corresponden.

- `SupplyRequest` — pedido de insumos. Sus renglones viven en
  `staff_request_lines` (insumo, cantidad pedida, cantidad aprobada). Aprobar
  lo deja «aprobado · por comprar» y la lista queda para Compras
  (`hooks.approved_supply_lines`); «comprado» se marca al recibir.
- `ChangeRequest` — pedido de sencilla por denominaciones, con motivo
  obligatorio. Aprobar significa que el administrador la va a traer: queda
  «aprobado · por entregar». Cuando llega, el cajero la registra con el
  **Cambio** que ya existe (`cash_swaps`, neto cero) y la marca recibida;
  `cash_swap_id` ata la solicitud a ese Cambio. **Esta tabla no mueve plata**:
  el único canje del cajón sigue siendo el Cambio.

Convenciones heredadas: `UTCDateTime` en todo instante; cantidades en
milésimas de la unidad base (`app.core.quantity.QTY_SCALE`); plata en pesos
enteros; enums no nativos sin CHECK; `employee_id` como FK real más el nombre
congelado. **Nada se borra**: un pedido rechazado queda con su motivo, uno
comprado o recibido queda con quién y cuándo.
"""

from __future__ import annotations

import enum
from datetime import date, datetime

import sqlalchemy as sa
from sqlalchemy import CheckConstraint, ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UTCDateTime


def _enum(pyenum: type[enum.Enum], *, length: int = 16) -> sa.Enum:
    return sa.Enum(pyenum, native_enum=False, length=length, validate_strings=True)


class StaffRequestKind(str, enum.Enum):
    SUPPLY = "supply"
    CHANGE = "change"


class StaffRequestStatus(str, enum.Enum):
    """`pending` → `approved` → (`bought` para insumos | `received` para
    sencilla), o `pending` → `rejected`. Un estado final no se reabre: se
    pide de nuevo."""

    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    BOUGHT = "bought"
    RECEIVED = "received"


class StaffRequest(Base):
    __tablename__ = "staff_requests"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    # El turno en el que se pidió. Se pide con turno abierto, siempre.
    shift_id: Mapped[int] = mapped_column(ForeignKey("shifts.id"), index=True)
    business_date: Mapped[date] = mapped_column(sa.Date)

    kind: Mapped[str] = mapped_column(sa.String(16))
    status: Mapped[StaffRequestStatus] = mapped_column(
        _enum(StaffRequestStatus), default=StaffRequestStatus.PENDING
    )

    # Nota libre de quien pide (insumos) — opcional.
    note: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    # Motivo de la sencilla — obligatorio para `change`, nulo para `supply`.
    reason: Mapped[str | None] = mapped_column(sa.Text, nullable=True)

    # Sencilla: desglose `[{value, count}]` y total en pesos, pedido y aprobado.
    requested_denominations: Mapped[list | None] = mapped_column(sa.JSON, nullable=True)
    requested_total: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    approved_denominations: Mapped[list | None] = mapped_column(sa.JSON, nullable=True)
    approved_total: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    # El Cambio con el que el cajero registró la sencilla recibida (opcional:
    # puede marcarse recibida sin atarla, y queda a la vista que no se ató).
    cash_swap_id: Mapped[int | None] = mapped_column(ForeignKey("cash_swaps.id"), nullable=True)

    requested_by_employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    requested_by_employee_name: Mapped[str] = mapped_column(sa.String(200))
    requested_at: Mapped[datetime] = mapped_column(UTCDateTime())

    # Quién aprobó o rechazó, cuándo, y el motivo del rechazo o la nota de
    # la aprobación.
    resolved_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    resolved_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    resolution_note: Mapped[str | None] = mapped_column(sa.Text, nullable=True)

    # Quién la cerró (comprado / recibido) y cuándo.
    closed_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    closed_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)

    __mapper_args__ = {"polymorphic_on": "kind"}

    __table_args__ = (
        CheckConstraint("kind IN ('supply', 'change')", name="ck_staff_requests_kind"),
        CheckConstraint(
            "requested_total IS NULL OR requested_total > 0", name="ck_staff_requests_requested_total_positive"
        ),
        CheckConstraint(
            "approved_total IS NULL OR approved_total > 0", name="ck_staff_requests_approved_total_positive"
        ),
        Index("ix_staff_requests_store_status", "store_id", "status"),
    )


class SupplyRequest(StaffRequest):
    """Pedido de insumos. Renglones en `StaffRequestLine`."""

    __mapper_args__ = {"polymorphic_identity": StaffRequestKind.SUPPLY.value}


class ChangeRequest(StaffRequest):
    """Pedido de sencilla por denominaciones, con motivo obligatorio."""

    __mapper_args__ = {"polymorphic_identity": StaffRequestKind.CHANGE.value}


class StaffRequestLine(Base):
    """Un insumo de un pedido de insumos. Nombre y unidad se congelan al
    pedir: el administrador ve lo que se pidió aunque el insumo cambie de
    nombre después. Se consulta siempre a través de su pedido."""

    __tablename__ = "staff_request_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    request_id: Mapped[int] = mapped_column(ForeignKey("staff_requests.id"), index=True)
    ingredient_id: Mapped[int] = mapped_column(ForeignKey("ingredients.id"), index=True)
    ingredient_name: Mapped[str] = mapped_column(sa.String(200))
    base_unit: Mapped[str] = mapped_column(sa.String(8))
    # Milésimas de la unidad base.
    qty_requested: Mapped[int] = mapped_column(sa.Integer)
    # `None` hasta que se aprueba; `0` es «aprobado, pero éste no se compra».
    qty_approved: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    # Lo que el sistema sugería al pedir (para ver si se pidió de más o de
    # menos). `None` si el insumo no venía sugerido.
    suggested_qty: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)

    __table_args__ = (
        CheckConstraint("qty_requested > 0", name="ck_staff_request_lines_qty_requested_positive"),
        CheckConstraint(
            "qty_approved IS NULL OR qty_approved >= 0", name="ck_staff_request_lines_qty_approved_non_negative"
        ),
    )
