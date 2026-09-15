"""Comanda: mesas, rondas, ítems, descuentos, sub-cuentas, eventos y merma.

DDL escrito a mano (Postgres-first), como `0003_shifts.py`: índice por cada FK
y por cada filtro de pantalla; los dos índices únicos parciales
(`uq_order_tables_one_open_per_table`) llevan `postgresql_where` **y**
`sqlite_where`. El test de migraciones del auditor
(`tests/audit/test_migration_invariants.py`) compara esta tabla contra
`app.orders.models` columna por columna.

Revision ID: 0004
Revises: 0003
Create Date: 2026-09-15
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from app.orders.models import CourtesyReason, DiscountReason, OrderChannel, OrderItemStatus, OrderStatus, VoidReason

# revision identifiers, used by Alembic.
revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def _enum(pyenum: type, *, length: int = 32) -> sa.Enum:
    return sa.Enum(pyenum, native_enum=False, length=length, validate_strings=True)


def upgrade() -> None:
    # -- orders -------------------------------------------------------------
    op.create_table(
        "orders",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("shift_id", sa.Integer(), sa.ForeignKey("shifts.id"), nullable=True),
        sa.Column("business_date", sa.Date(), nullable=False),
        sa.Column("channel", _enum(OrderChannel, length=16), nullable=False),
        sa.Column("status", _enum(OrderStatus, length=16), nullable=False, server_default=OrderStatus.OPEN.value),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("covers", sa.Integer(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("takeout_customer_name", sa.String(200), nullable=True),
        sa.Column("takeout_phone", sa.String(30), nullable=True),
        sa.Column("promised_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("consumed_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("consumed_by_employee_name", sa.String(200), nullable=True),
        sa.Column("opened_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("opened_by_employee_name", sa.String(200), nullable=False),
        sa.Column("opened_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("bill_presented_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("bill_print_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("paid_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("paid_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("paid_by_employee_name", sa.String(200), nullable=True),
        sa.Column("voided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("void_reason", _enum(VoidReason), nullable=True),
        sa.Column("void_note", sa.Text(), nullable=True),
        sa.Column("voided_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("voided_by_employee_name", sa.String(200), nullable=True),
        sa.Column("void_authorized_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("void_authorized_by_employee_name", sa.String(200), nullable=True),
        sa.Column("void_after_bill", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("merged_into_order_id", sa.Integer(), sa.ForeignKey("orders.id"), nullable=True),
        sa.Column("merged_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("transferred_from_shift_id", sa.Integer(), sa.ForeignKey("shifts.id"), nullable=True),
        sa.Column("transferred_to_shift_id", sa.Integer(), sa.ForeignKey("shifts.id"), nullable=True),
        sa.Column("kitchen_view_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("split_parts", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("version >= 1", name="ck_orders_version_positive"),
    )
    op.create_index("ix_orders_organization_id", "orders", ["organization_id"])
    op.create_index("ix_orders_store_id", "orders", ["store_id"])
    op.create_index("ix_orders_shift_id", "orders", ["shift_id"])
    op.create_index("ix_orders_store_status", "orders", ["store_id", "status"])
    op.create_index("ix_orders_store_business_date", "orders", ["store_id", "business_date"])

    # -- order_tables ---------------------------------------------------
    op.create_table(
        "order_tables",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("order_id", sa.Integer(), sa.ForeignKey("orders.id"), nullable=False),
        sa.Column("table_id", sa.Integer(), sa.ForeignKey("tables.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("seated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("released_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_order_tables_order_id", "order_tables", ["order_id"])
    op.create_index("ix_order_tables_table_id", "order_tables", ["table_id"])
    op.create_index("ix_order_tables_store_id", "order_tables", ["store_id"])
    op.create_index(
        "uq_order_tables_one_open_per_table",
        "order_tables",
        ["table_id"],
        unique=True,
        postgresql_where=sa.text("released_at IS NULL"),
        sqlite_where=sa.text("released_at IS NULL"),
    )

    # -- order_rounds -----------------------------------------------------
    op.create_table(
        "order_rounds",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("order_id", sa.Integer(), sa.ForeignKey("orders.id"), nullable=False),
        sa.Column("round_no", sa.Integer(), nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("sent_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("sent_by_employee_name", sa.String(200), nullable=False),
        sa.Column("sent_at_payment", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.UniqueConstraint("order_id", "round_no", name="uq_order_rounds_order_round"),
    )
    op.create_index("ix_order_rounds_order_id", "order_rounds", ["order_id"])

    # -- order_items --------------------------------------------------------
    op.create_table(
        "order_items",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("order_id", sa.Integer(), sa.ForeignKey("orders.id"), nullable=False),
        sa.Column("product_id", sa.Integer(), sa.ForeignKey("products.id"), nullable=True),
        sa.Column("combo_id", sa.Integer(), sa.ForeignKey("combos.id"), nullable=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("qty", sa.Integer(), nullable=False),
        sa.Column("seat", sa.Integer(), nullable=True),
        sa.Column("course", sa.String(50), nullable=False),
        sa.Column("station", sa.String(50), nullable=True),
        sa.Column("list_price", sa.Integer(), nullable=False),
        sa.Column("unit_price", sa.Integer(), nullable=False),
        sa.Column("tax_code", sa.String(16), nullable=False),
        sa.Column("tax_rate", sa.Integer(), nullable=False),
        sa.Column("price_includes_tax", sa.Boolean(), nullable=False),
        sa.Column("modifiers", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("modifiers_text", sa.String(500), nullable=True),
        sa.Column("combo_selections", sa.JSON(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("status", _enum(OrderItemStatus, length=16), nullable=False, server_default=OrderItemStatus.PENDING.value),
        sa.Column("round_id", sa.Integer(), sa.ForeignKey("order_rounds.id"), nullable=True),
        sa.Column("round_no", sa.Integer(), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ready_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("served_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("sent_at_payment", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("discount_amount", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("courtesy_reason", _enum(CourtesyReason), nullable=True),
        sa.Column("courtesy_note", sa.Text(), nullable=True),
        sa.Column("courtesy_authorized_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("courtesy_authorized_by_employee_name", sa.String(200), nullable=True),
        sa.Column("courtesy_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("courtesy_after_bill", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("void_reason", _enum(VoidReason), nullable=True),
        sa.Column("void_note", sa.Text(), nullable=True),
        sa.Column("voided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("voided_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("voided_by_employee_name", sa.String(200), nullable=True),
        sa.Column("void_authorized_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("void_authorized_by_employee_name", sa.String(200), nullable=True),
        sa.Column("void_after_bill", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("void_minutes_since_sent", sa.Integer(), nullable=True),
        sa.Column("unit_cost", sa.Integer(), nullable=True),
        sa.Column("recipe_version", sa.Integer(), nullable=True),
        sa.Column("added_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("added_by_employee_name", sa.String(200), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("qty > 0", name="ck_order_items_qty_positive"),
    )
    op.create_index("ix_order_items_organization_id", "order_items", ["organization_id"])
    op.create_index("ix_order_items_store_id", "order_items", ["store_id"])
    op.create_index("ix_order_items_order_id", "order_items", ["order_id"])
    op.create_index("ix_order_items_product_id", "order_items", ["product_id"])
    op.create_index("ix_order_items_order_status", "order_items", ["order_id", "status"])

    # -- order_discounts ------------------------------------------------
    op.create_table(
        "order_discounts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("order_id", sa.Integer(), sa.ForeignKey("orders.id"), nullable=False),
        sa.Column("item_id", sa.Integer(), sa.ForeignKey("order_items.id"), nullable=True),
        sa.Column("scope", sa.Enum("order", "item", name="order_discount_scope", native_enum=False, length=16), nullable=False),
        sa.Column("kind", sa.Enum("percent", "amount", name="order_discount_kind", native_enum=False, length=16), nullable=False),
        sa.Column("value", sa.Integer(), nullable=False),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("reason", _enum(DiscountReason), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("employee_name", sa.String(200), nullable=False),
        sa.Column("authorized_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("authorized_by_employee_name", sa.String(200), nullable=True),
        sa.Column("after_bill", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("voided_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("value >= 0", name="ck_order_discounts_value_nonneg"),
    )
    op.create_index("ix_order_discounts_organization_id", "order_discounts", ["organization_id"])
    op.create_index("ix_order_discounts_store_id", "order_discounts", ["store_id"])
    op.create_index("ix_order_discounts_order_id", "order_discounts", ["order_id"])
    op.create_index("ix_order_discounts_item_id", "order_discounts", ["item_id"])

    # -- order_sub_accounts -----------------------------------------------
    op.create_table(
        "order_sub_accounts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("order_id", sa.Integer(), sa.ForeignKey("orders.id"), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("label", sa.String(100), nullable=False),
        sa.Column("seat", sa.Integer(), nullable=True),
        sa.Column("status", sa.Enum("open", "paid", name="sub_account_status", native_enum=False, length=16), nullable=False, server_default="open"),
        sa.Column("paid_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("document_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("order_id", "seq", name="uq_order_sub_accounts_order_seq"),
    )
    op.create_index("ix_order_sub_accounts_order_id", "order_sub_accounts", ["order_id"])

    # -- order_sub_account_items ------------------------------------------
    op.create_table(
        "order_sub_account_items",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("sub_account_id", sa.Integer(), sa.ForeignKey("order_sub_accounts.id"), nullable=False),
        sa.Column("order_item_id", sa.Integer(), sa.ForeignKey("order_items.id"), nullable=False),
        sa.Column("portions", sa.Integer(), nullable=False),
        sa.Column("of_portions", sa.Integer(), nullable=False),
        sa.CheckConstraint("portions > 0", name="ck_sub_account_items_portions_positive"),
        sa.CheckConstraint("of_portions > 0", name="ck_sub_account_items_of_portions_positive"),
    )
    op.create_index("ix_order_sub_account_items_sub_account_id", "order_sub_account_items", ["sub_account_id"])
    op.create_index("ix_order_sub_account_items_order_item_id", "order_sub_account_items", ["order_item_id"])

    # -- order_events -------------------------------------------------------
    op.create_table(
        "order_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("order_id", sa.Integer(), sa.ForeignKey("orders.id"), nullable=False),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("employee_name", sa.String(200), nullable=True),
        sa.Column("authorized_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("authorized_by_employee_name", sa.String(200), nullable=True),
        sa.Column("after_bill", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_order_events_organization_id", "order_events", ["organization_id"])
    op.create_index("ix_order_events_store_id", "order_events", ["store_id"])
    op.create_index("ix_order_events_order_id", "order_events", ["order_id"])
    op.create_index("ix_order_events_order_at", "order_events", ["order_id", "at"])

    # -- waste_stubs --------------------------------------------------------
    op.create_table(
        "waste_stubs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("order_id", sa.Integer(), sa.ForeignKey("orders.id"), nullable=False),
        sa.Column("order_item_id", sa.Integer(), sa.ForeignKey("order_items.id"), nullable=False),
        sa.Column("product_id", sa.Integer(), sa.ForeignKey("products.id"), nullable=True),
        sa.Column("product_name", sa.String(200), nullable=False),
        sa.Column("qty", sa.Integer(), nullable=False),
        sa.Column("reason", _enum(VoidReason), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("employee_name", sa.String(200), nullable=False),
        sa.Column("authorized_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("authorized_by_employee_name", sa.String(200), nullable=True),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ingredient_id", sa.Integer(), nullable=True),
        sa.Column("resolved", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.CheckConstraint("qty > 0", name="ck_waste_stubs_qty_positive"),
    )
    op.create_index("ix_waste_stubs_organization_id", "waste_stubs", ["organization_id"])
    op.create_index("ix_waste_stubs_store_id", "waste_stubs", ["store_id"])
    op.create_index("ix_waste_stubs_order_id", "waste_stubs", ["order_id"])
    op.create_index("ix_waste_stubs_order_item_id", "waste_stubs", ["order_item_id"])


def downgrade() -> None:
    op.drop_table("waste_stubs")
    op.drop_table("order_events")
    op.drop_table("order_sub_account_items")
    op.drop_table("order_sub_accounts")
    op.drop_table("order_discounts")
    op.drop_table("order_items")
    op.drop_table("order_rounds")
    op.drop_index("uq_order_tables_one_open_per_table", table_name="order_tables")
    op.drop_table("order_tables")
    op.drop_table("orders")
