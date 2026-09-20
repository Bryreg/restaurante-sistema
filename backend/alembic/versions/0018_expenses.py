"""Gastos, obligaciones agendadas y configuración de costos fijos (fase 3,
`backend-obligaciones`, T2): `expenses`, `obligations`,
`store_expenses_settings`.

DDL escrito a mano (Postgres-first), como `0011_purchases.py`: un índice por
FK y por filtro de pantalla, `CheckConstraint` para las mismas reglas que
valida el modelo. Sin `batch_alter_table` — son tablas nuevas, no hay columna
existente que tocar. Los `_enum(...)` de acá son `VARCHAR` planos en los dos
motores (`native_enum=False`, sin `create_constraint`): no hay ningún `CHECK`
que un `downgrade` necesite recrear.

Revision ID: 0018
Revises: 0017
Create Date: 2026-09-20
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from app.expenses.models import ExpenseCategory, ExpenseSource, ObligationCategory, ObligationStatus

# revision identifiers, used by Alembic.
revision: str = "0018"
down_revision: str | None = "0017"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def _enum(pyenum: type, *, length: int = 32) -> sa.Enum:
    return sa.Enum(pyenum, native_enum=False, length=length, validate_strings=True)


def upgrade() -> None:
    # -- expenses ---------------------------------------------------------
    op.create_table(
        "expenses",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("category", _enum(ExpenseCategory), nullable=False),
        sa.Column("description", sa.String(300), nullable=False),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("business_date", sa.Date(), nullable=False),
        sa.Column("source", _enum(ExpenseSource, length=16), nullable=False),
        sa.Column("cash_movement_id", sa.Integer(), sa.ForeignKey("cash_movements.id"), nullable=True),
        sa.Column("created_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("created_by_employee_name", sa.String(200), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("voided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("voided_reason", sa.Text(), nullable=True),
        sa.Column("voided_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("voided_by_employee_name", sa.String(200), nullable=True),
        sa.CheckConstraint("amount > 0", name="ck_expenses_amount_positive"),
    )
    op.create_index("ix_expenses_organization_id", "expenses", ["organization_id"])
    op.create_index("ix_expenses_store_id", "expenses", ["store_id"])
    op.create_index("ix_expenses_store_date", "expenses", ["store_id", "business_date"])
    op.create_index("ix_expenses_store_category", "expenses", ["store_id", "category"])

    # -- obligations --------------------------------------------------------
    op.create_table(
        "obligations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("category", _enum(ObligationCategory), nullable=False),
        sa.Column("description", sa.String(300), nullable=False),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("due_date", sa.Date(), nullable=False),
        sa.Column(
            "status", _enum(ObligationStatus, length=16), nullable=False, server_default=ObligationStatus.PENDING.value
        ),
        sa.Column("settled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("settled_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("settled_by_employee_name", sa.String(200), nullable=True),
        sa.Column("settled_source", _enum(ExpenseSource, length=16), nullable=True),
        sa.Column("cash_movement_id", sa.Integer(), sa.ForeignKey("cash_movements.id"), nullable=True),
        sa.Column("created_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("created_by_employee_name", sa.String(200), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancelled_reason", sa.Text(), nullable=True),
        sa.Column("cancelled_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("cancelled_by_employee_name", sa.String(200), nullable=True),
        sa.CheckConstraint("amount > 0", name="ck_obligations_amount_positive"),
    )
    op.create_index("ix_obligations_organization_id", "obligations", ["organization_id"])
    op.create_index("ix_obligations_store_id", "obligations", ["store_id"])
    op.create_index("ix_obligations_store_due", "obligations", ["store_id", "due_date"])
    op.create_index("ix_obligations_store_status", "obligations", ["store_id", "status"])

    # -- store_expenses_settings --------------------------------------------
    op.create_table(
        "store_expenses_settings",
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), primary_key=True),
        sa.Column("fixed_costs", sa.Integer(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.CheckConstraint(
            "fixed_costs IS NULL OR fixed_costs >= 0", name="ck_store_expenses_settings_fixed_nonneg"
        ),
    )


def downgrade() -> None:
    op.drop_table("store_expenses_settings")
    op.drop_table("obligations")
    op.drop_table("expenses")
