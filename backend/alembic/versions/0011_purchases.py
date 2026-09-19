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
"el egreso del cajón" — `app/shifts/**`), y eso **no requiere DDL**: ver la
nota en el `upgrade`.

**Corregido al primer CI contra Postgres real.** Esta migración recreaba
`cash_movements` entera con `batch_alter_table(..., recreate="always")`,
creyendo que hacía falta para que el `CHECK` del enum aceptara el valor
nuevo. Ese `CHECK` no existe —`_enum` no pide `create_constraint`, así que
la columna es un `VARCHAR(32)` pelado en los dos motores— y la recreación
no arreglaba nada. En SQLite pasaba igual, porque recrear una tabla ahí es
barato y nada se opone. En Postgres, recrear obliga a soltar la clave
primaria, y `pending_refunds.settled_cash_movement_id` (de 1b) y
`purchase_payments.cash_movement_id` (de esta misma migración) dependen de
su índice: `DependentObjectsStillExist`, y `alembic upgrade head` no pasa
de acá. Es decir que esta fase **no podía desplegarse**, y ninguna suite
sobre SQLite podía verlo.

Revision ID: 0011
Revises: 0010
Create Date: 2026-09-16
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from app.purchases.models import PayableStatus, PaymentMethod, ReceptionStatus

# revision identifiers, used by Alembic.
revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def _enum(pyenum: type, *, length: int = 32) -> sa.Enum:
    return sa.Enum(pyenum, native_enum=False, length=length, validate_strings=True)


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
    # Sin DDL, a propósito. `_enum` construye
    # `sa.Enum(..., native_enum=False, validate_strings=True)` SIN
    # `create_constraint=True`, y el default de SQLAlchemy 2.x es no crearla:
    # la columna es un `VARCHAR(32)` pelado en Postgres **y** en SQLite, y la
    # validación del valor vive en Python, no en la base. Verificado en las
    # dos: el único CHECK de `cash_movements` es el de `amount > 0`.
    # Agregar un valor al enum de Python no necesita tocar el esquema.


def downgrade() -> None:
    # Simétrico al upgrade: estrechar el enum tampoco toca el esquema.
    op.drop_table("purchase_payments")
    op.drop_table("payables")
    op.drop_table("reception_lines")
    op.drop_table("receptions")
    op.drop_table("suppliers")
