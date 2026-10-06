"""Órdenes de compra (auditoría del dueño, tanda 5).

- `purchase_orders` y `purchase_order_lines` (i3): lo que se le pide a un
  proveedor, en borrador, enviada, recibida en parte, recibida o cancelada.
- `receptions.purchase_order_id`: la orden que cubre una recepción.

Dos tablas nuevas: 123 → 125.

**Cuelga de `0045` a propósito**: `0046`–`0048` se escriben en paralelo en
otras ramas y no existen en este árbol. Al juntar las ramas, `down_revision`
pasa a `"0048"` (y los postes de `tests/audit/` suman las tablas de las tres).

Igual que `0045`: en SQLite la FK de la columna nueva de `receptions` no se
agrega (obligaría a recrear la tabla); en Postgres sí, por nombre.

Revision ID: 0049
Revises: 0045
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0049"
down_revision = "0045"
branch_labels: str | None = None
depends_on: str | None = None

_RECEPTION_FK = "fk_receptions_purchase_order"


def upgrade() -> None:
    op.create_table(
        "purchase_orders",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False, index=True),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False, index=True),
        sa.Column("supplier_id", sa.Integer(), sa.ForeignKey("suppliers.id"), nullable=False, index=True),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("expected_date", sa.Date(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("created_by_employee_name", sa.String(200), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("business_date", sa.Date(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("sent_business_date", sa.Date(), nullable=True),
        sa.Column("sent_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("sent_by_employee_name", sa.String(200), nullable=True),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancelled_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("cancelled_by_employee_name", sa.String(200), nullable=True),
        sa.Column("cancel_reason", sa.Text(), nullable=True),
        sa.UniqueConstraint("store_id", "number", name="uq_purchase_orders_store_number"),
    )
    op.create_index("ix_purchase_orders_store_status", "purchase_orders", ["store_id", "status"])

    op.add_column("receptions", sa.Column("purchase_order_id", sa.Integer(), nullable=True))
    if op.get_bind().dialect.name != "sqlite":
        op.create_foreign_key(_RECEPTION_FK, "receptions", "purchase_orders", ["purchase_order_id"], ["id"])

    op.create_table(
        "purchase_order_lines",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("order_id", sa.Integer(), sa.ForeignKey("purchase_orders.id"), nullable=False, index=True),
        sa.Column("ingredient_id", sa.Integer(), sa.ForeignKey("ingredients.id"), nullable=False, index=True),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("qty_purchase_milli", sa.Integer(), nullable=False),
        sa.Column("purchase_unit", sa.String(50), nullable=False),
        sa.Column("purchase_factor", sa.Integer(), nullable=False),
        sa.Column("qty_base", sa.Integer(), nullable=False),
        sa.Column("expected_unit_price_micros", sa.BigInteger(), nullable=True),
        sa.Column("closed_reception_id", sa.Integer(), sa.ForeignKey("receptions.id"), nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("removed_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("order_id", "ingredient_id", name="uq_purchase_order_lines_order_ingredient"),
        sa.CheckConstraint("qty_purchase_milli > 0", name="ck_purchase_order_lines_qty_positive"),
        sa.CheckConstraint("purchase_factor > 0", name="ck_purchase_order_lines_factor_positive"),
        sa.CheckConstraint("qty_base > 0", name="ck_purchase_order_lines_qty_base_positive"),
        sa.CheckConstraint(
            "expected_unit_price_micros IS NULL OR expected_unit_price_micros >= 0",
            name="ck_purchase_order_lines_price_nonneg",
        ),
    )


def downgrade() -> None:
    op.drop_table("purchase_order_lines")
    if op.get_bind().dialect.name == "sqlite":
        with op.batch_alter_table("receptions") as batch_op:
            batch_op.drop_column("purchase_order_id")
    else:
        op.drop_constraint(_RECEPTION_FK, "receptions", type_="foreignkey")
        op.drop_column("receptions", "purchase_order_id")
    op.drop_index("ix_purchase_orders_store_status", table_name="purchase_orders")
    op.drop_table("purchase_orders")
