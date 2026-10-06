"""Contar preparaciones.

Pedido del dueño (2026-10-06): «las preparaciones necesitan conteo y
control». Una preparación en modo lote tiene stock propio (lo que se produjo
menos lo que se usó) y hasta acá no se podía contar: el faltante de una salsa
no se veía nunca.

- `stock_count_prep_lines`: un renglón por preparación en modo lote dentro
  de un conteo completo (o de críticos, si la preparación es crítica).
- `preparations.key_item`: la preparación entra al conteo de críticos.

Suma una tabla: el conteo pasa de 116 a 117.

Revision ID: 0038
Revises: 0037
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0038"
down_revision = "0037"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column(
        "preparations", sa.Column("key_item", sa.Boolean(), nullable=False, server_default=sa.false())
    )
    op.create_table(
        "stock_count_prep_lines",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("count_id", sa.Integer(), sa.ForeignKey("stock_counts.id"), nullable=False),
        sa.Column("preparation_id", sa.Integer(), nullable=False),
        sa.Column("qty_counted", sa.BigInteger(), nullable=True),
        sa.Column("was_counted", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("counted_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("count_id", "preparation_id", name="uq_stock_count_prep_lines_count_prep"),
        sa.CheckConstraint("qty_counted IS NULL OR qty_counted >= 0", name="ck_stock_count_prep_lines_qty_nonneg"),
    )
    op.create_index("ix_stock_count_prep_lines_count_id", "stock_count_prep_lines", ["count_id"])
    op.create_index("ix_stock_count_prep_lines_preparation_id", "stock_count_prep_lines", ["preparation_id"])


def downgrade() -> None:
    op.drop_index("ix_stock_count_prep_lines_preparation_id", table_name="stock_count_prep_lines")
    op.drop_index("ix_stock_count_prep_lines_count_id", table_name="stock_count_prep_lines")
    op.drop_table("stock_count_prep_lines")
    with op.batch_alter_table("preparations") as batch:
        batch.drop_column("key_item")
