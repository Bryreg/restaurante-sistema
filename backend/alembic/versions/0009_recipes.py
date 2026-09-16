"""Fichas técnicas, preparaciones y `recipe_effect` de modificadores
(pedido 2a, `backend-recetas`).

Revision ID: 0009
Revises: 0008
Create Date: 2026-09-15

DDL escrito a mano (Postgres-first), como el resto del proyecto. Depende de
que `0008` (dominio `inventory`, `backend-inventario`) ya haya creado
`ingredients` — todas las FK de este archivo hacia `ingredients.id` asumen
esa tabla viva. Enums no nativos (`native_enum=False`), igual que en todo el
proyecto.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0009"
down_revision: Union[str, None] = "0008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

PREP_MODE = sa.Enum("batch", "exploded", name="prep_mode", native_enum=False, length=20)
RECIPE_EFFECT_TYPE = sa.Enum("add", "remove", "replace", name="recipe_effect_type", native_enum=False, length=20)


def upgrade() -> None:
    # -- preparations ---------------------------------------------------------
    op.create_table(
        "preparations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("mode", PREP_MODE, nullable=False, server_default="exploded"),
        sa.Column("standard_yield_qty", sa.BigInteger(), nullable=False),
        sa.Column("standard_yield_unit", sa.String(length=8), nullable=False),
        sa.Column("process_loss_pct", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("shelf_life_days", sa.Integer(), nullable=True),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("standard_yield_qty > 0", name="ck_preparations_yield_qty_positive"),
        sa.CheckConstraint("standard_yield_unit in ('g','ml','unit')", name="ck_preparations_yield_unit_valid"),
        sa.CheckConstraint(
            "process_loss_pct >= 0 AND process_loss_pct <= 100", name="ck_preparations_process_loss_pct_range"
        ),
    )
    op.create_index("ix_preparations_organization_id", "preparations", ["organization_id"])
    op.create_index("ix_preparations_store_id", "preparations", ["store_id"])
    op.create_index("ix_preparations_store_active", "preparations", ["store_id", "active"])

    # -- preparation_lines ------------------------------------------------------
    op.create_table(
        "preparation_lines",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("preparation_id", sa.Integer(), sa.ForeignKey("preparations.id"), nullable=False),
        sa.Column("ingredient_id", sa.Integer(), sa.ForeignKey("ingredients.id"), nullable=True),
        sa.Column("component_preparation_id", sa.Integer(), sa.ForeignKey("preparations.id"), nullable=True),
        sa.Column("qty_base", sa.BigInteger(), nullable=False),
        sa.Column("unit", sa.String(length=8), nullable=False),
        sa.CheckConstraint(
            "(ingredient_id IS NOT NULL AND component_preparation_id IS NULL) OR "
            "(ingredient_id IS NULL AND component_preparation_id IS NOT NULL)",
            name="ck_preparation_lines_exactly_one_component",
        ),
        sa.CheckConstraint("qty_base > 0", name="ck_preparation_lines_qty_positive"),
    )
    op.create_index("ix_preparation_lines_preparation_id", "preparation_lines", ["preparation_id"])
    op.create_index("ix_preparation_lines_ingredient_id", "preparation_lines", ["ingredient_id"])
    op.create_index(
        "ix_preparation_lines_component_preparation_id", "preparation_lines", ["component_preparation_id"]
    )

    # -- prep_batches -------------------------------------------------------------
    op.create_table(
        "prep_batches",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("preparation_id", sa.Integer(), sa.ForeignKey("preparations.id"), nullable=False),
        sa.Column("qty_expected", sa.BigInteger(), nullable=False),
        sa.Column("qty_real", sa.BigInteger(), nullable=False),
        sa.Column("unit", sa.String(length=8), nullable=False),
        sa.Column("variance_pct_x100", sa.Integer(), nullable=False),
        sa.Column("variance_alert", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("total_cost_micros", sa.BigInteger(), nullable=True),
        sa.Column("unit_cost_micros", sa.BigInteger(), nullable=True),
        sa.Column("cost_source", sa.String(length=20), nullable=False),
        sa.Column("expiry_date", sa.Date(), nullable=True),
        sa.Column("produced_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("produced_by_employee_name", sa.String(length=200), nullable=False),
        sa.Column("produced_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("business_date", sa.Date(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("closed_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("closed_by_employee_name", sa.String(length=200), nullable=True),
        sa.Column("closed_reason", sa.String(length=200), nullable=True),
        sa.CheckConstraint("qty_expected > 0", name="ck_prep_batches_qty_expected_positive"),
        sa.CheckConstraint("qty_real >= 0", name="ck_prep_batches_qty_real_nonneg"),
    )
    op.create_index("ix_prep_batches_organization_id", "prep_batches", ["organization_id"])
    op.create_index("ix_prep_batches_store_id", "prep_batches", ["store_id"])
    op.create_index("ix_prep_batches_preparation_id", "prep_batches", ["preparation_id"])
    op.create_index("ix_prep_batches_prep_produced", "prep_batches", ["preparation_id", "produced_at"])

    # -- recipes ------------------------------------------------------------------
    op.create_table(
        "recipes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("product_id", sa.Integer(), sa.ForeignKey("products.id"), nullable=False),
        sa.Column("current_version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("product_id", name="uq_recipes_product_id"),
    )
    op.create_index("ix_recipes_organization_id", "recipes", ["organization_id"])
    op.create_index("ix_recipes_store_id", "recipes", ["store_id"])
    op.create_index("ix_recipes_product_id", "recipes", ["product_id"])

    # -- recipe_versions ------------------------------------------------------------
    op.create_table(
        "recipe_versions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("recipe_id", sa.Integer(), sa.ForeignKey("recipes.id"), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("created_by_employee_name", sa.String(length=200), nullable=True),
        sa.UniqueConstraint("recipe_id", "version", name="uq_recipe_versions_recipe_version"),
    )
    op.create_index("ix_recipe_versions_recipe_id", "recipe_versions", ["recipe_id"])

    # -- recipe_lines ------------------------------------------------------------
    op.create_table(
        "recipe_lines",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("recipe_version_id", sa.Integer(), sa.ForeignKey("recipe_versions.id"), nullable=False),
        sa.Column("ingredient_id", sa.Integer(), sa.ForeignKey("ingredients.id"), nullable=True),
        sa.Column("preparation_id", sa.Integer(), sa.ForeignKey("preparations.id"), nullable=True),
        sa.Column("qty_base", sa.BigInteger(), nullable=False),
        sa.Column("unit", sa.String(length=8), nullable=False),
        sa.CheckConstraint(
            "(ingredient_id IS NOT NULL AND preparation_id IS NULL) OR "
            "(ingredient_id IS NULL AND preparation_id IS NOT NULL)",
            name="ck_recipe_lines_exactly_one_component",
        ),
        sa.CheckConstraint("qty_base > 0", name="ck_recipe_lines_qty_positive"),
    )
    op.create_index("ix_recipe_lines_recipe_version_id", "recipe_lines", ["recipe_version_id"])
    op.create_index("ix_recipe_lines_ingredient_id", "recipe_lines", ["ingredient_id"])
    op.create_index("ix_recipe_lines_preparation_id", "recipe_lines", ["preparation_id"])

    # -- modifier_option_recipe_effects ------------------------------------------
    op.create_table(
        "modifier_option_recipe_effects",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("modifier_option_id", sa.Integer(), sa.ForeignKey("modifier_options.id"), nullable=False),
        sa.Column("effect", RECIPE_EFFECT_TYPE, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("modifier_option_id", name="uq_modifier_option_recipe_effects_option"),
    )
    op.create_index(
        "ix_modifier_option_recipe_effects_organization_id", "modifier_option_recipe_effects", ["organization_id"]
    )
    op.create_index("ix_modifier_option_recipe_effects_store_id", "modifier_option_recipe_effects", ["store_id"])
    op.create_index(
        "ix_modifier_option_recipe_effects_modifier_option_id",
        "modifier_option_recipe_effects",
        ["modifier_option_id"],
    )

    # -- modifier_option_recipe_effect_lines --------------------------------------
    op.create_table(
        "modifier_option_recipe_effect_lines",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "effect_id", sa.Integer(), sa.ForeignKey("modifier_option_recipe_effects.id"), nullable=False
        ),
        sa.Column("ingredient_id", sa.Integer(), sa.ForeignKey("ingredients.id"), nullable=True),
        sa.Column("preparation_id", sa.Integer(), sa.ForeignKey("preparations.id"), nullable=True),
        sa.Column("qty_base", sa.BigInteger(), nullable=False),
        sa.Column("unit", sa.String(length=8), nullable=False),
        sa.Column("replaces_ingredient_id", sa.Integer(), sa.ForeignKey("ingredients.id"), nullable=True),
        sa.Column("replaces_preparation_id", sa.Integer(), sa.ForeignKey("preparations.id"), nullable=True),
        sa.CheckConstraint(
            "(ingredient_id IS NOT NULL AND preparation_id IS NULL) OR "
            "(ingredient_id IS NULL AND preparation_id IS NOT NULL)",
            name="ck_modifier_effect_lines_exactly_one_component",
        ),
        sa.CheckConstraint("qty_base > 0", name="ck_modifier_effect_lines_qty_positive"),
        sa.CheckConstraint(
            "NOT (replaces_ingredient_id IS NOT NULL AND replaces_preparation_id IS NOT NULL)",
            name="ck_modifier_effect_lines_replaces_at_most_one",
        ),
    )
    op.create_index(
        "ix_modifier_option_recipe_effect_lines_effect_id", "modifier_option_recipe_effect_lines", ["effect_id"]
    )
    op.create_index(
        "ix_modifier_option_recipe_effect_lines_ingredient_id",
        "modifier_option_recipe_effect_lines",
        ["ingredient_id"],
    )
    op.create_index(
        "ix_modifier_option_recipe_effect_lines_preparation_id",
        "modifier_option_recipe_effect_lines",
        ["preparation_id"],
    )
    op.create_index(
        "ix_modifier_option_recipe_effect_lines_replaces_ingredient_id",
        "modifier_option_recipe_effect_lines",
        ["replaces_ingredient_id"],
    )
    op.create_index(
        "ix_modifier_option_recipe_effect_lines_replaces_preparation_id",
        "modifier_option_recipe_effect_lines",
        ["replaces_preparation_id"],
    )


def downgrade() -> None:
    op.drop_table("modifier_option_recipe_effect_lines")
    op.drop_table("modifier_option_recipe_effects")
    op.drop_table("recipe_lines")
    op.drop_table("recipe_versions")
    op.drop_table("recipes")
    op.drop_table("prep_batches")
    op.drop_table("preparation_lines")
    op.drop_table("preparations")
