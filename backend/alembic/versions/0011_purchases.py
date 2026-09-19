"""Proveedores, recepciones, cuentas por pagar y pagos (pedido 2b,
`backend-compras`): `suppliers`, `receptions`, `reception_lines`,
`payables`, `purchase_payments`.

DDL escrito a mano (Postgres-first), como `0008_inventory.py`/
`0009_recipes.py`/`0010_consumption.py`: un índice por FK y por filtro de
pantalla, `CheckConstraint` para las mismas reglas que valida el modelo.
`reception_lines.stock_batch_id` es `Integer` **sin FK dura**:
`stock_batches` es tabla de `app.inventory` (territorio ajeno, en
construcción en paralelo en este mismo pedido 2b) que puede no existir
todavía cuando esta migración corre — mismo patrón que
`StockMovement.preparation_id` en `0008_inventory.py`. `stock_movement_id`
sí es FK real: `stock_movements` ya existe desde 2a.

También agrega `CashMovementCause.SUPPLIER_PAYMENT` (misión de este agente,
"el egreso del cajón" — `app/shifts/**`): `cash_movements.cause` se recrea
con `batch_alter_table(..., recreate="always")` para que el `CHECK` del
enum (`native_enum=False`) acepte el valor nuevo en SQLite **y** en
Postgres (`recreate="always"` fuerza la reconstrucción completa de la tabla
en cualquier dialecto, no sólo en SQLite — ver `_enum` en
`0008_inventory.py` para el mismo patrón de enum no nativo).

Revision ID: 0011
Revises: 0010
Create Date: 2026-09-16
"""

from __future__ import annotations

import enum
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from app.purchases.models import PayableStatus, PaymentMethod, ReceptionStatus
from app.shifts.models import CashMovementCause

# revision identifiers, used by Alembic.
revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def _enum(pyenum: type, *, length: int = 32) -> sa.Enum:
    return sa.Enum(pyenum, native_enum=False, length=length, validate_strings=True)


class _CashMovementCauseBefore0011(str, enum.Enum):
    """Copia congelada de `CashMovementCause` tal como estaba ANTES de esta
    migración (sin `SUPPLIER_PAYMENT`), sólo para que `downgrade()` recree
    el `CHECK` original de verdad — importar el enum vivo de
    `app.shifts.models` acá abajo daría el conjunto de HOY (con
    `SUPPLIER_PAYMENT` todavía adentro), que no es lo que esta sede tenía
    antes de aplicar `0011`. Mismo motivo por el que `upgrade()` sí puede
    importar el enum vivo: ahí el conjunto final ES el de hoy."""

    PETTY_EXPENSE = "petty_expense"
    EMERGENCY_PURCHASE = "emergency_purchase"
    REFUND = "refund"
    TIP_PAYOUT = "tip_payout"
    OTHER_INCOME = "other_income"
    OTHER_EXPENSE = "other_expense"


def upgrade() -> None:
    # -- suppliers ------------------------------------------------------
    op.create_table(
        "suppliers",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("nit", sa.String(20), nullable=True),
        sa.Column("payment_term_days", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("contact_name", sa.String(200), nullable=True),
        sa.Column("contact_phone", sa.String(40), nullable=True),
        sa.Column("invoices_required", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("payment_term_days >= 0", name="ck_suppliers_payment_term_nonneg"),
    )
    op.create_index("ix_suppliers_organization_id", "suppliers", ["organization_id"])
    op.create_index("ix_suppliers_store_id", "suppliers", ["store_id"])
    op.create_index("ix_suppliers_store_active", "suppliers", ["store_id", "active"])
    op.create_index(
        "uq_suppliers_store_nit",
        "suppliers",
        ["store_id", "nit"],
        unique=True,
        postgresql_where=sa.text("nit IS NOT NULL"),
        sqlite_where=sa.text("nit IS NOT NULL"),
    )

    # -- receptions -------------------------------------------------------
    op.create_table(
        "receptions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("supplier_id", sa.Integer(), sa.ForeignKey("suppliers.id"), nullable=False),
        sa.Column("invoice_number", sa.String(80), nullable=True),
        sa.Column("invoice_date", sa.Date(), nullable=False),
        sa.Column("no_invoice", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("photo", sa.String(500), nullable=True),
        sa.Column("received_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("received_by_employee_name", sa.String(200), nullable=False),
        sa.Column("created_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("created_by_employee_name", sa.String(200), nullable=False),
        sa.Column("status", _enum(ReceptionStatus, length=16), nullable=False, server_default=ReceptionStatus.CONFIRMED.value),
        sa.Column("price_confirmed", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("price_confirmed_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("price_confirmed_by_employee_name", sa.String(200), nullable=True),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("business_date", sa.Date(), nullable=False),
        sa.Column("reversed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reversed_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("reversed_by_employee_name", sa.String(200), nullable=True),
    )
    op.create_index("ix_receptions_organization_id", "receptions", ["organization_id"])
    op.create_index("ix_receptions_store_id", "receptions", ["store_id"])
    op.create_index("ix_receptions_supplier_id", "receptions", ["supplier_id"])
    op.create_index("ix_receptions_store_status", "receptions", ["store_id", "status"])
    op.create_index("ix_receptions_store_supplier", "receptions", ["store_id", "supplier_id"])
    op.create_index("ix_receptions_store_date", "receptions", ["store_id", "business_date"])

    # -- reception_lines ----------------------------------------------------
    op.create_table(
        "reception_lines",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("reception_id", sa.Integer(), sa.ForeignKey("receptions.id"), nullable=False),
        sa.Column("ingredient_id", sa.Integer(), sa.ForeignKey("ingredients.id"), nullable=False),
        sa.Column("qty_received_base", sa.Integer(), nullable=False),
        sa.Column("qty_invoiced_base", sa.Integer(), nullable=False),
        sa.Column("purchase_unit_price_micros", sa.BigInteger(), nullable=False),
        sa.Column("unit_cost_micros", sa.BigInteger(), nullable=False),
        sa.Column("final_unit_cost_micros", sa.BigInteger(), nullable=False),
        sa.Column("tax_base", sa.Integer(), nullable=False),
        sa.Column("tax_rate", sa.Integer(), nullable=False),
        sa.Column("tax_amount", sa.Integer(), nullable=False),
        sa.Column("lot_code", sa.String(80), nullable=True),
        sa.Column("expires_at", sa.Date(), nullable=True),
        # Sin FK dura: `stock_batches` es tabla de `app.inventory` (ver docstring).
        sa.Column("stock_batch_id", sa.Integer(), nullable=True),
        sa.Column("stock_movement_id", sa.Integer(), sa.ForeignKey("stock_movements.id"), nullable=True),
        sa.CheckConstraint("qty_received_base > 0", name="ck_reception_lines_qty_received_positive"),
        sa.CheckConstraint("qty_invoiced_base > 0", name="ck_reception_lines_qty_invoiced_positive"),
        sa.CheckConstraint("tax_base >= 0", name="ck_reception_lines_tax_base_nonneg"),
        sa.CheckConstraint("tax_amount >= 0", name="ck_reception_lines_tax_amount_nonneg"),
        sa.CheckConstraint("tax_rate >= 0 AND tax_rate <= 100", name="ck_reception_lines_tax_rate_range"),
    )
    op.create_index("ix_reception_lines_reception", "reception_lines", ["reception_id"])
    op.create_index("ix_reception_lines_ingredient", "reception_lines", ["ingredient_id"])

    # -- payables -------------------------------------------------------
    op.create_table(
        "payables",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("supplier_id", sa.Integer(), sa.ForeignKey("suppliers.id"), nullable=False),
        sa.Column("reception_id", sa.Integer(), sa.ForeignKey("receptions.id"), nullable=False, unique=True),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("status", _enum(PayableStatus, length=16), nullable=False, server_default=PayableStatus.PENDING_REVIEW.value),
        sa.Column("due_date", sa.Date(), nullable=False),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("approved_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("approved_by_employee_name", sa.String(200), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("business_date", sa.Date(), nullable=False),
        sa.CheckConstraint("amount > 0", name="ck_payables_amount_positive"),
    )
    op.create_index("ix_payables_organization_id", "payables", ["organization_id"])
    op.create_index("ix_payables_store_id", "payables", ["store_id"])
    op.create_index("ix_payables_store_status", "payables", ["store_id", "status"])
    op.create_index("ix_payables_store_due_date", "payables", ["store_id", "due_date"])
    op.create_index("ix_payables_supplier", "payables", ["supplier_id"])

    # -- purchase_payments ----------------------------------------------
    op.create_table(
        "purchase_payments",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("payable_id", sa.Integer(), sa.ForeignKey("payables.id"), nullable=False),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("method", _enum(PaymentMethod, length=16), nullable=False),
        sa.Column("paid_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reference", sa.String(120), nullable=True),
        sa.Column("from_cash_drawer", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("cash_movement_id", sa.Integer(), sa.ForeignKey("cash_movements.id"), nullable=True),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("employee_name", sa.String(200), nullable=False),
        sa.Column("authorized_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("authorized_by_employee_name", sa.String(200), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("voided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("voided_reason", sa.Text(), nullable=True),
        sa.Column("voided_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("voided_by_employee_name", sa.String(200), nullable=True),
        sa.CheckConstraint("amount > 0", name="ck_purchase_payments_amount_positive"),
    )
    op.create_index("ix_purchase_payments_organization_id", "purchase_payments", ["organization_id"])
    op.create_index("ix_purchase_payments_store_id", "purchase_payments", ["store_id"])
    op.create_index("ix_purchase_payments_payable", "purchase_payments", ["payable_id"])
    op.create_index("ix_purchase_payments_store_created", "purchase_payments", ["store_id", "created_at"])

    # -- cash_movements.cause gana SUPPLIER_PAYMENT ----------------------
    with op.batch_alter_table("cash_movements", recreate="always") as batch_op:
        batch_op.alter_column(
            "cause",
            existing_type=_enum(CashMovementCause),
            type_=_enum(CashMovementCause),
        )


def downgrade() -> None:
    with op.batch_alter_table("cash_movements", recreate="always") as batch_op:
        batch_op.alter_column(
            "cause",
            existing_type=_enum(CashMovementCause),
            type_=_enum(_CashMovementCauseBefore0011),
        )
    op.drop_table("purchase_payments")
    op.drop_table("payables")
    op.drop_table("reception_lines")
    op.drop_table("receptions")
    op.drop_table("suppliers")
