"""Carta plana: categorías, productos, modificadores, combos y menú del día.

Revision ID: 0002
Revises: 0001
Create Date: 2026-09-14

DDL escrito a mano (Postgres-first), no autogenerado
(`features/fase-1a-cimientos/CONTRATO-INTERNO.md §4`). Índices en toda FK y en
toda columna que un router filtra (`store_id`, `category_id`, `product_id`,
`modifier_group_id`, `combo_id`, `combo_group_id`). Enums no nativos
(`native_enum=False`): igual que `0001_core.py`, quedan como VARCHAR + CHECK,
nunca un tipo nativo de Postgres que SQLite no puede replicar.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TAX_CODE = sa.Enum("inc_8", "iva_19", "excluded", name="product_tax_code", native_enum=False, length=16)


def upgrade() -> None:
    # -- categories -------------------------------------------------------------
    op.create_table(
        "categories",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("name", sa.String(length=150), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("default_course", sa.String(length=50), nullable=True),
        sa.Column("default_station", sa.String(length=50), nullable=True),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.create_index("ix_categories_organization_id", "categories", ["organization_id"])
    op.create_index("ix_categories_store_id", "categories", ["store_id"])
    op.create_index("ix_categories_store_active", "categories", ["store_id", "active"])

    # -- products -----------------------------------------------------------------
    op.create_table(
        "products",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("category_id", sa.Integer(), sa.ForeignKey("categories.id"), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("description", sa.String(length=1000), nullable=True),
        sa.Column("station", sa.String(length=50), nullable=True),
        sa.Column("default_course", sa.String(length=50), nullable=True),
        sa.Column("price_dine_in", sa.Integer(), nullable=False),
        sa.Column("price_takeout", sa.Integer(), nullable=True),
        sa.Column("price_delivery", sa.Integer(), nullable=True),
        sa.Column("price_platform", sa.Integer(), nullable=True),
        sa.Column("tax_code", TAX_CODE, nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("available", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("daily_count", sa.Integer(), nullable=True),
        sa.Column("daily_remaining", sa.Integer(), nullable=True),
        sa.Column("unavailable_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("unavailable_by_employee_name", sa.String(length=200), nullable=True),
        sa.Column("unavailable_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("price_dine_in >= 0", name="ck_products_price_dine_in_nonneg"),
        sa.CheckConstraint("price_takeout IS NULL OR price_takeout >= 0", name="ck_products_price_takeout_nonneg"),
        sa.CheckConstraint("price_delivery IS NULL OR price_delivery >= 0", name="ck_products_price_delivery_nonneg"),
        sa.CheckConstraint("price_platform IS NULL OR price_platform >= 0", name="ck_products_price_platform_nonneg"),
        sa.CheckConstraint("daily_count IS NULL OR daily_count >= 0", name="ck_products_daily_count_nonneg"),
        sa.CheckConstraint(
            "daily_remaining IS NULL OR daily_remaining >= 0", name="ck_products_daily_remaining_nonneg"
        ),
    )
    op.create_index("ix_products_organization_id", "products", ["organization_id"])
    op.create_index("ix_products_store_id", "products", ["store_id"])
    op.create_index("ix_products_category_id", "products", ["category_id"])
    op.create_index("ix_products_store_active", "products", ["store_id", "active"])
    op.create_index("ix_products_unavailable_by_employee_id", "products", ["unavailable_by_employee_id"])

    # -- modifier_groups ------------------------------------------------------------
    op.create_table(
        "modifier_groups",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("product_id", sa.Integer(), sa.ForeignKey("products.id"), nullable=False),
        sa.Column("name", sa.String(length=150), nullable=False),
        sa.Column("required", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("min", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("max", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.CheckConstraint("min >= 0", name="ck_modifier_groups_min_nonneg"),
        sa.CheckConstraint("max >= min", name="ck_modifier_groups_max_ge_min"),
    )
    op.create_index("ix_modifier_groups_organization_id", "modifier_groups", ["organization_id"])
    op.create_index("ix_modifier_groups_store_id", "modifier_groups", ["store_id"])
    op.create_index("ix_modifier_groups_product_id", "modifier_groups", ["product_id"])

    # -- modifier_options -----------------------------------------------------------
    op.create_table(
        "modifier_options",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("modifier_group_id", sa.Integer(), sa.ForeignKey("modifier_groups.id"), nullable=False),
        sa.Column("name", sa.String(length=150), nullable=False),
        sa.Column("price_delta", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("available", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("unavailable_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("unavailable_by_employee_name", sa.String(length=200), nullable=True),
        sa.Column("unavailable_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("recipe_effect", sa.JSON(), nullable=True),
    )
    op.create_index("ix_modifier_options_organization_id", "modifier_options", ["organization_id"])
    op.create_index("ix_modifier_options_store_id", "modifier_options", ["store_id"])
    op.create_index("ix_modifier_options_modifier_group_id", "modifier_options", ["modifier_group_id"])
    op.create_index(
        "ix_modifier_options_unavailable_by_employee_id", "modifier_options", ["unavailable_by_employee_id"]
    )

    # -- combos -----------------------------------------------------------------------
    op.create_table(
        "combos",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("price", sa.Integer(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("schedule", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("price >= 0", name="ck_combos_price_nonneg"),
    )
    op.create_index("ix_combos_organization_id", "combos", ["organization_id"])
    op.create_index("ix_combos_store_id", "combos", ["store_id"])
    op.create_index("ix_combos_store_active", "combos", ["store_id", "active"])

    # -- combo_groups -------------------------------------------------------------------
    op.create_table(
        "combo_groups",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("combo_id", sa.Integer(), sa.ForeignKey("combos.id"), nullable=False),
        sa.Column("name", sa.String(length=150), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index("ix_combo_groups_organization_id", "combo_groups", ["organization_id"])
    op.create_index("ix_combo_groups_store_id", "combo_groups", ["store_id"])
    op.create_index("ix_combo_groups_combo_id", "combo_groups", ["combo_id"])

    # -- combo_options -------------------------------------------------------------------
    op.create_table(
        "combo_options",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("combo_group_id", sa.Integer(), sa.ForeignKey("combo_groups.id"), nullable=False),
        sa.Column("product_id", sa.Integer(), sa.ForeignKey("products.id"), nullable=False),
        sa.Column("active_today", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("available_today", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("unavailable_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("unavailable_by_employee_name", sa.String(length=200), nullable=True),
        sa.Column("unavailable_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_combo_options_organization_id", "combo_options", ["organization_id"])
    op.create_index("ix_combo_options_store_id", "combo_options", ["store_id"])
    op.create_index("ix_combo_options_combo_group_id", "combo_options", ["combo_group_id"])
    op.create_index("ix_combo_options_product_id", "combo_options", ["product_id"])
    op.create_index(
        "ix_combo_options_unavailable_by_employee_id", "combo_options", ["unavailable_by_employee_id"]
    )


def downgrade() -> None:
    op.drop_table("combo_options")
    op.drop_table("combo_groups")
    op.drop_table("combos")
    op.drop_table("modifier_options")
    op.drop_table("modifier_groups")
    op.drop_table("products")
    op.drop_table("categories")
