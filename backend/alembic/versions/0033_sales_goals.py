"""La meta de ventas del mes, por sede (Informe del contador).

Decisión del dueño (2026-09): «dejar el informe contador igual que café
sistema», con meta mensual y sin nómina. En café la meta era una sola por
sede; acá es **por sede y por mes**, porque un mes de temporada no tiene la
misma meta que uno flojo y la meta de un mes cerrado no se reescribe al
cambiar la del siguiente. Un mes sin fila hereda la del último mes que sí la
tenía; `amount = NULL` es «sin meta» dicho a propósito.

Una tabla nueva, `sales_goals`, con sus llaves foráneas desde el
`create_table` (las dos bases lo aceptan) y un único por sede, año y mes
(dos «Guardar» a la vez no dejan dos metas). No toca tablas existentes.
113 → 114.

Revision ID: 0033
Revises: 0032
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0033"
down_revision = "0032"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.create_table(
        "sales_goals",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("year", sa.Integer(), nullable=False),
        sa.Column("month", sa.Integer(), nullable=False),
        sa.Column("amount", sa.Integer(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("updated_by_employee_name", sa.String(200), nullable=True),
        sa.UniqueConstraint("store_id", "year", "month", name="uq_sales_goals_store_month"),
        sa.CheckConstraint("month >= 1 AND month <= 12", name="ck_sales_goals_month"),
        sa.CheckConstraint("amount IS NULL OR amount > 0", name="ck_sales_goals_amount_positive"),
    )
    op.create_index("ix_sales_goals_organization_id", "sales_goals", ["organization_id"])
    op.create_index("ix_sales_goals_store_id", "sales_goals", ["store_id"])


def downgrade() -> None:
    op.drop_index("ix_sales_goals_store_id", table_name="sales_goals")
    op.drop_index("ix_sales_goals_organization_id", table_name="sales_goals")
    op.drop_table("sales_goals")
