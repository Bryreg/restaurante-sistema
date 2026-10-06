"""Presupuesto mensual por renglón del estado de resultados (h7).

- `pnl_budgets`: una fila por sede, año, mes y renglón (`net_sales`,
  `cost`, `payroll`, `obligations`, `expenses`); `amount = NULL` es «sin
  presupuesto». La utilidad presupuestada se deriva, no se guarda.

Una tabla nueva: 123 → 124.

**`down_revision` provisional**: 0045–0047 se están escribiendo en paralelo.
Esta migración cuelga de `0044` hasta que esas tres entren; al integrarlas,
el `down_revision` pasa a `"0047"` y el poste de la cadena se mueve con él.

Revision ID: 0048
Revises: 0047
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0048"
down_revision = "0047"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.create_table(
        "pnl_budgets",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False, index=True),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False, index=True),
        sa.Column("year", sa.Integer(), nullable=False),
        sa.Column("month", sa.Integer(), nullable=False),
        sa.Column("line", sa.String(32), nullable=False),
        sa.Column("amount", sa.Integer(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("updated_by_employee_name", sa.String(200), nullable=True),
        sa.UniqueConstraint("store_id", "year", "month", "line", name="uq_pnl_budgets_store_month_line"),
        sa.CheckConstraint("month >= 1 AND month <= 12", name="ck_pnl_budgets_month"),
        sa.CheckConstraint("amount IS NULL OR amount >= 0", name="ck_pnl_budgets_amount_nonneg"),
    )


def downgrade() -> None:
    op.drop_table("pnl_budgets")
