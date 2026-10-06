"""El libro del banco completo (c2, «igual que la Plata del café»).

- `bank_accounts`: las cuentas de la sede (una principal por sede, defendida
  con índice único parcial), con el 4×1000 exento o no por cuenta.
- `bank_balance_anchors`: el saldo del extracto que teclea el dueño; el libro
  corre desde ahí. Se anula con motivo, nunca se borra.
- `bank_movements`: lo que el sistema no sabe por otro lado (nómina pagada por
  transferencia, cuota de manejo, aportes y retiros del dueño, traslados entre
  cuentas), con causa tipada. Se anula con motivo, nunca se borra.
- `bank_entry_assignments`: a qué cuenta va un renglón derivado de otro
  dominio (sin fila, a la principal).

Cuatro tablas nuevas: 123 → 127.

Revision ID: 0046
Revises: 0044
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0046"
down_revision = "0044"
branch_labels: str | None = None
depends_on: str | None = None


def _org_store() -> list[sa.Column]:
    return [
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False, index=True),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False, index=True),
    ]


def _voided() -> list[sa.Column]:
    return [
        sa.Column("voided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("voided_reason", sa.Text(), nullable=True),
        sa.Column("voided_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("voided_by_employee_name", sa.String(200), nullable=True),
    ]


def upgrade() -> None:
    op.create_table(
        "bank_accounts",
        sa.Column("id", sa.Integer(), primary_key=True),
        *_org_store(),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("is_default", sa.Boolean(), nullable=False),
        sa.Column("gmf_exempt", sa.Boolean(), nullable=False),
        sa.Column("receives_transfers", sa.Boolean(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("created_by_employee_name", sa.String(200), nullable=True),
    )
    op.create_index(
        "uq_bank_accounts_one_default_per_store",
        "bank_accounts",
        ["store_id"],
        unique=True,
        postgresql_where=sa.text("is_default"),
        sqlite_where=sa.text("is_default = 1"),
    )

    op.create_table(
        "bank_balance_anchors",
        sa.Column("id", sa.Integer(), primary_key=True),
        *_org_store(),
        sa.Column("account_id", sa.Integer(), sa.ForeignKey("bank_accounts.id"), nullable=False, index=True),
        sa.Column("balance_date", sa.Date(), nullable=False),
        sa.Column("balance", sa.Integer(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("employee_name", sa.String(200), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        *_voided(),
    )
    op.create_index("ix_bank_balance_anchors_account_date", "bank_balance_anchors", ["account_id", "balance_date"])

    op.create_table(
        "bank_movements",
        sa.Column("id", sa.Integer(), primary_key=True),
        *_org_store(),
        sa.Column("account_id", sa.Integer(), sa.ForeignKey("bank_accounts.id"), nullable=False, index=True),
        sa.Column("counter_account_id", sa.Integer(), sa.ForeignKey("bank_accounts.id"), nullable=True),
        sa.Column("direction", sa.String(8), nullable=False),
        sa.Column("cause", sa.String(24), nullable=False),
        sa.Column("business_date", sa.Date(), nullable=False),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("description", sa.String(200), nullable=False),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("employee_name", sa.String(200), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        *_voided(),
        sa.CheckConstraint("amount > 0", name="ck_bank_movements_amount_positive"),
    )
    op.create_index("ix_bank_movements_store_date", "bank_movements", ["store_id", "business_date"])

    op.create_table(
        "bank_entry_assignments",
        sa.Column("id", sa.Integer(), primary_key=True),
        *_org_store(),
        sa.Column("source_kind", sa.String(32), nullable=False),
        sa.Column("source_id", sa.Integer(), nullable=False),
        sa.Column("account_id", sa.Integer(), sa.ForeignKey("bank_accounts.id"), nullable=False, index=True),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("employee_name", sa.String(200), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("store_id", "source_kind", "source_id", name="uq_bank_entry_assignments_source"),
    )


def downgrade() -> None:
    op.drop_table("bank_entry_assignments")
    op.drop_index("ix_bank_movements_store_date", table_name="bank_movements")
    op.drop_table("bank_movements")
    op.drop_index("ix_bank_balance_anchors_account_date", table_name="bank_balance_anchors")
    op.drop_table("bank_balance_anchors")
    op.drop_index("uq_bank_accounts_one_default_per_store", table_name="bank_accounts")
    op.drop_table("bank_accounts")
