"""Lotes de compra, conteos a ciegas y umbrales de varianza (pedido 2b):
`stock_batches`, `stock_counts`, `stock_count_lines`, `store_inventory_settings`.

DDL escrito a mano (Postgres-first), mismo estilo que `0008_inventory.py`.

`down_revision = "0011"`: `0011` es la migración de `purchases` (proveedores,
recepciones, cuentas por pagar, pagos), construida por otro agente EN
PARALELO en este mismo pedido 2b. Esta migración no la escribe ni la toca —
sólo declara que corre DESPUÉS de ella. Si `0011` todavía no existe en el
árbol cuando alguien corre `alembic upgrade head` acá, es exactamente la
misma situación que `0008_inventory.py`/`0009_recipes.py` en 2a: dos agentes
construyendo dominios hermanos en paralelo, cada uno escribe su propia
migración con el `down_revision` que le corresponde, y el orquestador las
junta al final.

`stock_batches.ingredient_id` tiene FK dura (`ingredients` ya existe desde
`0008`). `stock_batches.source_id` (la recepción que lo originó) es
`Integer` **sin** FK dura a propósito: `receptions` es tabla de `purchases`
(`0011`) y este archivo no puede asumir en qué orden corren las dos
migraciones hermanas entre sí más allá de la cadena declarada — mismo patrón
que `ingredients.supplier_id` en `0008_inventory.py`.

**Nota sobre el enum `MovementCause`** (ver `app/inventory/models.py::_enum`):
`sa.Enum(..., native_enum=False)` en este repo (SQLAlchemy 2.0, sin
`create_constraint=True`) genera una columna `VARCHAR`, **no** un
`CHECK CONSTRAINT`, en ninguno de los dos dialectos (verificado contra
`CreateTable(...).compile(...)`: `stock_movements.cause` es `VARCHAR(32) NOT
NULL` a secas). Agregar `RECEPTION_REVERSAL` al enum de Python **no
requiere ninguna migración de esquema** — no hay una lista de valores que
recrear en la base. Se deja esta nota en vez de un `batch_alter_table` que
no tendría qué constraint recrear, para que quien lea esta migración no
salga a buscar un `DROP CONSTRAINT`/`ADD CONSTRAINT` que no existe.

Revision ID: 0012
Revises: 0011
Create Date: 2026-09-16
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from app.inventory.models import CostSource, StockCountScope, StockCountStatus

# revision identifiers, used by Alembic.
revision: str = "0012"
down_revision: str | None = "0011"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def _enum(pyenum: type, *, length: int = 32) -> sa.Enum:
    return sa.Enum(pyenum, native_enum=False, length=length, validate_strings=True)


def upgrade() -> None:
    # -- stock_batches --------------------------------------------------------
    op.create_table(
        "stock_batches",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("ingredient_id", sa.Integer(), sa.ForeignKey("ingredients.id"), nullable=False),
        sa.Column("qty_received", sa.Integer(), nullable=False),
        sa.Column("qty_remaining", sa.Integer(), nullable=False),
        sa.Column("unit_cost_micros", sa.BigInteger(), nullable=False),
        sa.Column("cost_source", _enum(CostSource, length=20), nullable=False),
        sa.Column("lot_code", sa.String(100), nullable=True),
        sa.Column("expires_at", sa.Date(), nullable=True),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("business_date", sa.Date(), nullable=False),
        # Sin FK dura: `receptions` es tabla de `purchases` (`0011`, ver
        # docstring del módulo).
        sa.Column("source_type", sa.String(30), nullable=False),
        sa.Column("source_id", sa.Integer(), nullable=False),
        sa.Column("reversed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("qty_received > 0", name="ck_stock_batches_qty_received_positive"),
        sa.CheckConstraint("qty_remaining >= 0", name="ck_stock_batches_qty_remaining_nonneg"),
        sa.CheckConstraint("qty_remaining <= qty_received", name="ck_stock_batches_qty_remaining_le_received"),
        sa.CheckConstraint("unit_cost_micros >= 0", name="ck_stock_batches_unit_cost_nonneg"),
    )
    op.create_index("ix_stock_batches_organization_id", "stock_batches", ["organization_id"])
    op.create_index("ix_stock_batches_store_id", "stock_batches", ["store_id"])
    op.create_index("ix_stock_batches_ingredient_id", "stock_batches", ["ingredient_id"])
    op.create_index(
        "ix_stock_batches_store_ingredient_expiry", "stock_batches", ["store_id", "ingredient_id", "expires_at"]
    )
    op.create_index(
        "ix_stock_batches_store_ingredient_received", "stock_batches", ["store_id", "ingredient_id", "received_at"]
    )
    op.create_index("ix_stock_batches_source", "stock_batches", ["source_type", "source_id"])

    # -- stock_counts -----------------------------------------------------------
    op.create_table(
        "stock_counts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("scope", _enum(StockCountScope, length=16), nullable=False),
        sa.Column("status", _enum(StockCountStatus, length=16), nullable=False, server_default="OPEN"),
        sa.Column("opened_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("business_date", sa.Date(), nullable=False),
        sa.Column("opened_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("opened_by_employee_name", sa.String(200), nullable=False),
        sa.Column("applied_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("applied_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("applied_by_employee_name", sa.String(200), nullable=True),
    )
    op.create_index("ix_stock_counts_organization_id", "stock_counts", ["organization_id"])
    op.create_index("ix_stock_counts_store_id", "stock_counts", ["store_id"])
    op.create_index("ix_stock_counts_store_status", "stock_counts", ["store_id", "status"])
    op.create_index("ix_stock_counts_store_scope_opened", "stock_counts", ["store_id", "scope", "opened_at"])

    # -- stock_count_lines --------------------------------------------------------
    op.create_table(
        "stock_count_lines",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("count_id", sa.Integer(), sa.ForeignKey("stock_counts.id"), nullable=False),
        sa.Column("ingredient_id", sa.Integer(), sa.ForeignKey("ingredients.id"), nullable=False),
        sa.Column("qty_counted", sa.Integer(), nullable=True),
        sa.Column("was_counted", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("counted_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("count_id", "ingredient_id", name="uq_stock_count_lines_count_ingredient"),
        sa.CheckConstraint("qty_counted IS NULL OR qty_counted >= 0", name="ck_stock_count_lines_qty_nonneg"),
    )
    op.create_index("ix_stock_count_lines_count_id", "stock_count_lines", ["count_id"])
    op.create_index("ix_stock_count_lines_ingredient", "stock_count_lines", ["ingredient_id"])

    # -- store_inventory_settings -------------------------------------------------
    op.create_table(
        "store_inventory_settings",
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), primary_key=True),
        sa.Column("variance_yellow_threshold_bp", sa.Integer(), nullable=False, server_default="200"),
        sa.Column("variance_red_threshold_bp", sa.Integer(), nullable=False, server_default="400"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("variance_yellow_threshold_bp > 0", name="ck_store_inv_settings_yellow_positive"),
        sa.CheckConstraint(
            "variance_red_threshold_bp > variance_yellow_threshold_bp", name="ck_store_inv_settings_red_gt_yellow"
        ),
    )


def downgrade() -> None:
    op.drop_table("store_inventory_settings")
    op.drop_table("stock_count_lines")
    op.drop_table("stock_counts")
    op.drop_table("stock_batches")
