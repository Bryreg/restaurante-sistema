"""Proveedores, recepciones de compra, cuentas por pagar y pagos (pedido 2b,
`features/fase-2-costo-inventario/spec.md § Alcance de 2b`, `docs/SPEC-
NEGOCIO.md §5.6`).

Convenciones heredadas (`docs/ESTADO.md`, `AGENTS.md`, y el contrato numérico
de 2a en `app.core.quantity`):
- `app.core.db.UTCDateTime` en todo `Mapped[datetime]`.
- Dinero (`Payable.amount`, `Payment.amount`, `ReceptionLine.tax_base`/
  `.tax_amount`) en `Integer`, pesos enteros — igual que `shifts`/`orders`.
- Cantidades de insumo en `Integer`, milésimas de la unidad base
  (`app.core.quantity.QTY_SCALE`); costos por unidad base en `BigInteger`,
  millonésimas de peso (`app.core.quantity.COST_SCALE`) — mismo contrato que
  `app.inventory.models`. Nunca `float`.
- Enums `native_enum=False`, comparados por valor.
- Todo modelo lleva `organization_id` y `store_id`.
- **Nada financiero se borra**: `Supplier.active` es baja lógica;
  `Reception`/`Payable`/`Payment` nunca se hacen `DELETE` — se revierten o se
  anulan con motivo, siempre agregando una fila o un campo de estado nuevo.
- **El saldo de una cuenta por pagar NO es una columna**: `Payable` no tiene
  campo `balance`. Se deriva siempre de `Payment` vivos
  (`app.purchases.service.payable_balance`) — regla dura de `AGENTS.md`
  ("una sola matemática, en el backend"), la misma que ya rige el esperado de
  caja.
- `ReceptionLine.stock_batch_id` es `Integer` **sin FK dura**: `stock_batches`
  es tabla de `app.inventory` (territorio ajeno, construida en paralelo en
  este mismo pedido 2b) que puede no existir todavía cuando esta migración
  corre — mismo patrón que `StockMovement.preparation_id` en
  `0008_inventory.py`. `ReceptionLine.stock_movement_id`, en cambio, SÍ es FK
  real: `stock_movements` ya existe desde 2a.
"""

from __future__ import annotations

import enum
from datetime import date, datetime

import sqlalchemy as sa
from sqlalchemy import CheckConstraint, ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UTCDateTime

ENUM_LENGTH = 32


def _enum(pyenum: type[enum.Enum], *, length: int = ENUM_LENGTH) -> sa.Enum:
    return sa.Enum(pyenum, native_enum=False, length=length, validate_strings=True)


# ---------------------------------------------------------------------------
# Enums publicados.
# ---------------------------------------------------------------------------


class ReceptionStatus(str, enum.Enum):
    CONFIRMED = "confirmed"
    REVERSED = "reversed"


class PayableStatus(str, enum.Enum):
    PENDING_REVIEW = "pending_review"
    APPROVED = "approved"
    # No está en el contrato de 2a/2b como estado nombrado, pero hace falta
    # uno para "esta cuenta ya no aplica" cuando su recepción se revierte
    # (`app.purchases.service.reverse_reception`) sin haber tenido pagos
    # vivos: nunca se borra la fila, y `pending_review`/`approved` mentirían
    # sobre una deuda que ya no existe. Decisión declarada en el entregable
    # §5 (no la pide el contrato explícitamente, pero "nada financiero se
    # borra" + "una recepción revertida no puede dejar una cuenta viva" la
    # exigen juntas).
    CANCELLED = "cancelled"


class PaymentMethod(str, enum.Enum):
    CASH = "cash"
    CARD = "card"
    TRANSFER = "transfer"
    OTHER = "other"


# ---------------------------------------------------------------------------
# Proveedores.
# ---------------------------------------------------------------------------


class Supplier(Base):
    """Entidad canónica (SPEC-NEGOCIO §5.6): nunca texto libre en la
    recepción. Baja lógica únicamente."""

    __tablename__ = "suppliers"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)

    name: Mapped[str] = mapped_column(sa.String(200))
    nit: Mapped[str | None] = mapped_column(sa.String(20), nullable=True)
    payment_term_days: Mapped[int] = mapped_column(sa.Integer, default=0)
    contact_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)
    contact_phone: Mapped[str | None] = mapped_column(sa.String(40), nullable=True)
    invoices_required: Mapped[bool] = mapped_column(sa.Boolean, default=True)
    active: Mapped[bool] = mapped_column(sa.Boolean, default=True)

    created_at: Mapped[datetime] = mapped_column(UTCDateTime())
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime())

    __table_args__ = (
        CheckConstraint("payment_term_days >= 0", name="ck_suppliers_payment_term_nonneg"),
        Index("ix_suppliers_store_active", "store_id", "active"),
        Index(
            "uq_suppliers_store_nit",
            "store_id",
            "nit",
            unique=True,
            postgresql_where=sa.text("nit IS NOT NULL"),
            sqlite_where=sa.text("nit IS NOT NULL"),
        ),
    )


# ---------------------------------------------------------------------------
# Recepciones.
# ---------------------------------------------------------------------------


class Reception(Base):
    """Una recepción de compra confirmada (SPEC-NEGOCIO §5.6). Pantalla de
    **administrador**, nunca de dispositivo: lleva precios (`received_by_*`
    es atribución de quien recibió físicamente, verificada por PIN, no una
    sesión — `created_by_*` es quien operó la pantalla de Admin)."""

    __tablename__ = "receptions"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    supplier_id: Mapped[int] = mapped_column(ForeignKey("suppliers.id"), index=True)

    invoice_number: Mapped[str | None] = mapped_column(sa.String(80), nullable=True)
    invoice_date: Mapped[date] = mapped_column(sa.Date)
    no_invoice: Mapped[bool] = mapped_column(sa.Boolean, default=False)
    photo: Mapped[str | None] = mapped_column(sa.String(500), nullable=True)

    received_by_employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    received_by_employee_name: Mapped[str] = mapped_column(sa.String(200))

    created_by_employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    created_by_employee_name: Mapped[str] = mapped_column(sa.String(200))

    status: Mapped[ReceptionStatus] = mapped_column(_enum(ReceptionStatus, length=16), default=ReceptionStatus.CONFIRMED)

    # Guardas de tecleo (§4.1/§5.6): true si CUALQUIER línea necesitó
    # `confirm_price: true` para pasar. Queda registrado quién confirmó.
    price_confirmed: Mapped[bool] = mapped_column(sa.Boolean, default=False)
    price_confirmed_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    price_confirmed_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    at: Mapped[datetime] = mapped_column(UTCDateTime())
    # Fecha de negocio sellada con la hora de corte de la sede en el instante
    # de la confirmación (una recepción a las 00:30 queda con el día del
    # turno) — nunca derivada de `at` en una consulta.
    business_date: Mapped[date] = mapped_column(sa.Date)

    reversed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    reversed_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    reversed_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    __table_args__ = (
        Index("ix_receptions_store_status", "store_id", "status"),
        Index("ix_receptions_store_supplier", "store_id", "supplier_id"),
        Index("ix_receptions_store_date", "store_id", "business_date"),
    )


class ReceptionLine(Base):
    """Una línea de recepción: un insumo, un lote, un costo (SPEC-NEGOCIO
    §5.6/§5.7). `unit_cost_micros` es el costo PRE-impuesto por unidad base
    (convertido de `purchase_unit_price` con `purchase_factor`);
    `final_unit_cost_micros` es el que de verdad viaja al lote y al
    movimiento — con el IVA sumado cuando la sede es responsable de INC
    (§4.1: "el IVA bajo INC es mayor valor del costo"), igual al primero
    bajo IVA (franquicia), donde el impuesto es descontable y se reporta
    aparte (`tax_base`/`tax_rate`/`tax_amount`, nunca perdidos)."""

    __tablename__ = "reception_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    reception_id: Mapped[int] = mapped_column(ForeignKey("receptions.id"), index=True)
    ingredient_id: Mapped[int] = mapped_column(ForeignKey("ingredients.id"), index=True)

    qty_received_base: Mapped[int] = mapped_column(sa.Integer)
    qty_invoiced_base: Mapped[int] = mapped_column(sa.Integer)

    # Micros por UNA unidad de compra, tal como se tecleó (antes de dividir
    # por `purchase_factor`) — se conserva para poder mostrar "lo que se
    # tecleó" en pantalla, nunca sólo el resultado ya convertido.
    purchase_unit_price_micros: Mapped[int] = mapped_column(sa.BigInteger)

    unit_cost_micros: Mapped[int] = mapped_column(sa.BigInteger)
    final_unit_cost_micros: Mapped[int] = mapped_column(sa.BigInteger)

    tax_base: Mapped[int] = mapped_column(sa.Integer)
    tax_rate: Mapped[int] = mapped_column(sa.Integer)
    tax_amount: Mapped[int] = mapped_column(sa.Integer)

    lot_code: Mapped[str | None] = mapped_column(sa.String(80), nullable=True)
    expires_at: Mapped[date | None] = mapped_column(sa.Date, nullable=True)

    # Sin FK dura: `stock_batches` es tabla de `app.inventory` (ver docstring
    # del módulo).
    stock_batch_id: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    stock_movement_id: Mapped[int | None] = mapped_column(ForeignKey("stock_movements.id"), nullable=True)

    __table_args__ = (
        CheckConstraint("qty_received_base > 0", name="ck_reception_lines_qty_received_positive"),
        CheckConstraint("qty_invoiced_base > 0", name="ck_reception_lines_qty_invoiced_positive"),
        CheckConstraint("tax_base >= 0", name="ck_reception_lines_tax_base_nonneg"),
        CheckConstraint("tax_amount >= 0", name="ck_reception_lines_tax_amount_nonneg"),
        CheckConstraint(
            "tax_rate >= 0 AND tax_rate <= 100", name="ck_reception_lines_tax_rate_range"
        ),
        Index("ix_reception_lines_reception", "reception_id"),
        Index("ix_reception_lines_ingredient", "ingredient_id"),
    )


# ---------------------------------------------------------------------------
# Cuentas por pagar y pagos.
# ---------------------------------------------------------------------------


class Payable(Base):
    """Cuenta por pagar creada por una recepción confirmada (una por
    recepción). `amount` es el total original de la factura/recepción —
    snapshot inmutable, igual que un total de documento fiscal — **nunca**
    un campo `balance`: el saldo se deriva siempre de los pagos vivos
    (`app.purchases.service.payable_balance`)."""

    __tablename__ = "payables"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    supplier_id: Mapped[int] = mapped_column(ForeignKey("suppliers.id"), index=True)
    reception_id: Mapped[int] = mapped_column(ForeignKey("receptions.id"), unique=True)

    amount: Mapped[int] = mapped_column(sa.Integer)
    status: Mapped[PayableStatus] = mapped_column(_enum(PayableStatus, length=16), default=PayableStatus.PENDING_REVIEW)
    due_date: Mapped[date] = mapped_column(sa.Date)

    approved_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    approved_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    approved_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    created_at: Mapped[datetime] = mapped_column(UTCDateTime())
    business_date: Mapped[date] = mapped_column(sa.Date)

    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_payables_amount_positive"),
        Index("ix_payables_store_status", "store_id", "status"),
        Index("ix_payables_store_due_date", "store_id", "due_date"),
        Index("ix_payables_supplier", "supplier_id"),
    )


class Payment(Base):
    """Un pago contra una cuenta por pagar. Nunca se borra ni se edita:
    anular es un cambio de estado con motivo (`voided_*`), y el pago
    anulado deja de contar en `payable_balance` sin desaparecer del
    historial. Tabla propia (`purchase_payments`, no `payments`) para no
    chocar con `app.payments.models.Payment` (pagos de venta, dominio
    ajeno)."""

    __tablename__ = "purchase_payments"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    payable_id: Mapped[int] = mapped_column(ForeignKey("payables.id"), index=True)

    amount: Mapped[int] = mapped_column(sa.Integer)
    method: Mapped[PaymentMethod] = mapped_column(_enum(PaymentMethod, length=16))
    paid_at: Mapped[datetime] = mapped_column(UTCDateTime())
    reference: Mapped[str | None] = mapped_column(sa.String(120), nullable=True)

    from_cash_drawer: Mapped[bool] = mapped_column(sa.Boolean, default=False)
    # FK real: `cash_movements` (app.shifts) ya existe desde 1a.
    cash_movement_id: Mapped[int | None] = mapped_column(ForeignKey("cash_movements.id"), nullable=True)

    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    employee_name: Mapped[str] = mapped_column(sa.String(200))
    authorized_by_employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    authorized_by_employee_name: Mapped[str] = mapped_column(sa.String(200))

    created_at: Mapped[datetime] = mapped_column(UTCDateTime())

    voided_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    voided_reason: Mapped[str | None] = mapped_column(sa.Text(), nullable=True)
    voided_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    voided_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_purchase_payments_amount_positive"),
        Index("ix_purchase_payments_payable", "payable_id"),
        Index("ix_purchase_payments_store_created", "store_id", "created_at"),
    )
