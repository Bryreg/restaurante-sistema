"""Insumos y el libro único de movimientos de inventario (pedido 2a):
`ingredients`, `stock_movements`, `wastes`.

DDL escrito a mano (Postgres-first), como `0003_shifts.py`/`0004_orders.py`:
un índice por cada FK y por cada filtro de pantalla, `CheckConstraint` para
"insumo o preparación, exactamente uno" y para "costo con origen" en las dos
tablas append-only.

`stock_movements.preparation_id` y `wastes.preparation_id` son `Integer`
**sin FK dura**: `preparations` es tabla del dominio `recipes` (otro agente
de este mismo pedido 2a) que puede no existir todavía cuando esta migración
corre — mismo patrón que `fiscal_range_id` antes de tener FK real en 1b-2
(`0007_fiscal_ranges_notes.py`). Cuando `app.recipes` cree `preparations` y
esté en `MODEL_MODULES`, una migración de una línea agrega la FK real.
`ingredients.supplier_id` sigue el mismo patrón: `suppliers` es tabla de 2b.

Revision ID: 0008
Revises: 0007
Create Date: 2026-09-15
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from app.inventory.models import BaseUnit, CostSource, MovementCause, WasteType

# revision identifiers, used by Alembic.
revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def _enum(pyenum: type, *, length: int = 32) -> sa.Enum:
    return sa.Enum(pyenum, native_enum=False, length=length, validate_strings=True)


def upgrade() -> None:
    # -- ingredients --------------------------------------------------------
    op.create_table(
        "ingredients",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("category", sa.String(100), nullable=True),
        sa.Column("base_unit", _enum(BaseUnit, length=8), nullable=False),
        sa.Column("purchase_unit", sa.String(50), nullable=False),
        sa.Column("purchase_factor", sa.Integer(), nullable=False),
        sa.Column("yield_pct", sa.Integer(), nullable=False, server_default="100"),
        sa.Column("official_cost_micros", sa.BigInteger(), nullable=True),
        sa.Column("estimated_cost_micros", sa.BigInteger(), nullable=True),
        sa.Column("min_stock", sa.Integer(), nullable=False),
        sa.Column("lead_time_days", sa.Integer(), nullable=True),
        sa.Column("perishable", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("key_item", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("consumption_untracked", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("substitute_ingredient_id", sa.Integer(), sa.ForeignKey("ingredients.id"), nullable=True),
        # Sin FK dura: `suppliers` es tabla de 2b (ver docstring del módulo).
        sa.Column("supplier_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("min_stock > 0", name="ck_ingredients_min_stock_positive"),
        sa.CheckConstraint("purchase_factor > 0", name="ck_ingredients_purchase_factor_positive"),
        sa.CheckConstraint("yield_pct >= 1 AND yield_pct <= 100", name="ck_ingredients_yield_pct_range"),
    )
    op.create_index("ix_ingredients_organization_id", "ingredients", ["organization_id"])
    op.create_index("ix_ingredients_store_id", "ingredients", ["store_id"])
    op.create_index("ix_ingredients_store_active", "ingredients", ["store_id", "active"])
    op.create_index("ix_ingredients_store_key_item", "ingredients", ["store_id", "key_item"])

    # -- stock_movements ------------------------------------------------------
    op.create_table(
        "stock_movements",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("ingredient_id", sa.Integer(), sa.ForeignKey("ingredients.id"), nullable=True),
        # Sin FK dura: `preparations` es tabla de `recipes` (ver docstring).
        sa.Column("preparation_id", sa.Integer(), nullable=True),
        sa.Column("qty_base", sa.Integer(), nullable=False),
        sa.Column("cause", _enum(MovementCause), nullable=False),
        sa.Column("cost_micros", sa.BigInteger(), nullable=True),
        sa.Column("cost_source", _enum(CostSource, length=20), nullable=False),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("employee_name", sa.String(200), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("business_date", sa.Date(), nullable=False),
        sa.Column("ref_type", sa.String(40), nullable=True),
        sa.Column("ref_id", sa.Integer(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "(ingredient_id IS NOT NULL AND preparation_id IS NULL) "
            "OR (ingredient_id IS NULL AND preparation_id IS NOT NULL)",
            name="ck_stock_movements_target_exactly_one",
        ),
        sa.CheckConstraint("qty_base != 0", name="ck_stock_movements_qty_base_nonzero"),
        sa.CheckConstraint(
            "(cost_micros IS NULL AND cost_source = 'NONE') OR (cost_micros IS NOT NULL AND cost_source != 'NONE')",
            name="ck_stock_movements_cost_source_consistent",
        ),
    )
    op.create_index("ix_stock_movements_organization_id", "stock_movements", ["organization_id"])
    op.create_index("ix_stock_movements_store_id", "stock_movements", ["store_id"])
    op.create_index("ix_stock_movements_ingredient_id", "stock_movements", ["ingredient_id"])
    op.create_index("ix_stock_movements_preparation_id", "stock_movements", ["preparation_id"])
    op.create_index(
        "ix_stock_movements_store_ingredient_at", "stock_movements", ["store_id", "ingredient_id", "at"]
    )
    op.create_index(
        "ix_stock_movements_store_prep_at", "stock_movements", ["store_id", "preparation_id", "at"]
    )
    op.create_index(
        "ix_stock_movements_store_date_cause", "stock_movements", ["store_id", "business_date", "cause"]
    )
    op.create_index("ix_stock_movements_ref", "stock_movements", ["ref_type", "ref_id"])

    # -- wastes ---------------------------------------------------------------
    op.create_table(
        "wastes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("type", _enum(WasteType, length=20), nullable=False),
        sa.Column("ingredient_id", sa.Integer(), sa.ForeignKey("ingredients.id"), nullable=True),
        # Sin FK dura: `preparations` es tabla de `recipes` (ver docstring).
        sa.Column("preparation_id", sa.Integer(), nullable=True),
        sa.Column("qty_base", sa.Integer(), nullable=False),
        sa.Column("cost_micros", sa.BigInteger(), nullable=True),
        sa.Column("cost_source", _enum(CostSource, length=20), nullable=False),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("employee_name", sa.String(200), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("photo_url", sa.String(500), nullable=True),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("business_date", sa.Date(), nullable=False),
        sa.Column("stock_movement_id", sa.Integer(), sa.ForeignKey("stock_movements.id"), nullable=True),
        sa.CheckConstraint(
            "(ingredient_id IS NOT NULL AND preparation_id IS NULL) "
            "OR (ingredient_id IS NULL AND preparation_id IS NOT NULL)",
            name="ck_wastes_target_exactly_one",
        ),
        sa.CheckConstraint("qty_base > 0", name="ck_wastes_qty_base_positive"),
        sa.CheckConstraint(
            "(cost_micros IS NULL AND cost_source = 'NONE') OR (cost_micros IS NOT NULL AND cost_source != 'NONE')",
            name="ck_wastes_cost_source_consistent",
        ),
    )
    op.create_index("ix_wastes_organization_id", "wastes", ["organization_id"])
    op.create_index("ix_wastes_store_id", "wastes", ["store_id"])
    op.create_index("ix_wastes_ingredient_id", "wastes", ["ingredient_id"])
    op.create_index("ix_wastes_preparation_id", "wastes", ["preparation_id"])
    op.create_index("ix_wastes_store_date_type", "wastes", ["store_id", "business_date", "type"])
    op.create_index("ix_wastes_store_ingredient_date", "wastes", ["store_id", "ingredient_id", "business_date"])


def downgrade() -> None:
    op.drop_table("wastes")
    op.drop_table("stock_movements")
    op.drop_table("ingredients")
