"""Modelos de la tabla de pagos y la propina de la comanda
(`features/fase-1b-venta/CONTRATO-INTERNO-1b-1.md §2.2`, vinculante: nombres
de tabla y columna los leen tal cual el auditor, `app.shifts.hooks.get_sales_totals`
y el frontend).

Convenciones heredadas (`docs/ESTADO.md`, `AGENTS.md`):
- `app.core.db.UTCDateTime` en todo `Mapped[datetime]`.
- Dinero en `Integer` (pesos enteros). `Payment.amount` es la parte de la
  VENTA que cubre el pago (nunca incluye propina); `Payment.tip_amount` es la
  propina que viaja en ese medio. La propina nunca entra en `amount`.
- Nada se borra ni se edita: un pago sólo se anula lógicamente
  (`voided_at`), nunca en 1b-1 (no hay ruta que lo haga; queda preparado para
  1b-2 y las notas de ajuste/crédito).
"""

from __future__ import annotations

from datetime import date, datetime

import sqlalchemy as sa
from sqlalchemy import CheckConstraint, ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UTCDateTime

# Catálogo de códigos de medio de pago (SPEC-NEGOCIO §3.4). No es un enum de
# base de datos: la columna es `String(16)` libre porque el medio real y
# habilitado por sede vive en `StoreSalesSettings.payment_methods[].code`
# (`enabled=True`); acá sólo se documentan los valores que ese catálogo puede
# tomar (`app.payments.service._validate_split` los valida contra la sede).
PAYMENT_METHOD_VALUES = ("cash", "card", "transfer", "platform", "voucher", "other")


class Payment(Base):
    """Un pago (una fila por `split` del cobro). Varios pagos pueden cubrir
    una misma comanda o sub-cuenta (pagos mixtos); `app.shifts.hooks.get_sales_totals`
    lee esta tabla agrupada por `method`, filtrando `voided_at IS NULL`."""

    __tablename__ = "payments"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    shift_id: Mapped[int] = mapped_column(ForeignKey("shifts.id"), index=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    sub_account_id: Mapped[int | None] = mapped_column(
        ForeignKey("order_sub_accounts.id"), nullable=True, index=True
    )
    document_id: Mapped[int | None] = mapped_column(ForeignKey("fiscal_documents.id"), nullable=True, index=True)

    method: Mapped[str] = mapped_column(sa.String(16))
    amount: Mapped[int] = mapped_column(sa.Integer)
    tip_amount: Mapped[int] = mapped_column(sa.Integer, default=0)
    tendered: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    change: Mapped[int] = mapped_column(sa.Integer, default=0)
    reference: Mapped[str | None] = mapped_column(sa.String(120), nullable=True)

    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    employee_name: Mapped[str] = mapped_column(sa.String(200))
    business_date: Mapped[date] = mapped_column(sa.Date)
    at: Mapped[datetime] = mapped_column(UTCDateTime())
    voided_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)

    __table_args__ = (
        Index("ix_payments_shift", "shift_id"),
        Index("ix_payments_order", "order_id"),
        Index("ix_payments_shift_method", "shift_id", "method"),
        CheckConstraint("amount >= 0", name="ck_payments_amount_nonneg"),
        CheckConstraint("tip_amount >= 0", name="ck_payments_tip_amount_nonneg"),
        CheckConstraint("change >= 0", name="ck_payments_change_nonneg"),
    )


class OrderTip(Base):
    """La pregunta de propina de una comanda o sub-cuenta (SPEC-NEGOCIO §3.4,
    §6.2): se pregunta al presentar la cuenta; acá queda el registro de si se
    preguntó, si aceptó, si modificó el sugerido y el monto final. `amount`
    nunca entra en `subtotal`/`total`/`tax_*` de ningún reporte."""

    __tablename__ = "order_tips"

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    sub_account_id: Mapped[int | None] = mapped_column(
        ForeignKey("order_sub_accounts.id"), nullable=True, index=True
    )

    asked: Mapped[bool] = mapped_column(sa.Boolean)
    accepted: Mapped[bool] = mapped_column(sa.Boolean)
    modified: Mapped[bool] = mapped_column(sa.Boolean)
    amount: Mapped[int] = mapped_column(sa.Integer)
    suggested_pct: Mapped[object] = mapped_column(sa.Numeric(5, 2))
    suggested_amount: Mapped[int] = mapped_column(sa.Integer)
    base: Mapped[int] = mapped_column(sa.Integer)
    at: Mapped[datetime] = mapped_column(UTCDateTime())

    __table_args__ = (CheckConstraint("amount >= 0", name="ck_order_tips_amount_nonneg"),)
