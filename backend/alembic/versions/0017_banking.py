"""`banking`: consignaciones y su imputación a turnos, liquidaciones de
datáfono y de plataformas (pedido fase 3, T1 `backend-banco`).

DDL escrito a mano (Postgres-first), mismo patrón que `0014_channels_money.py`:
un índice por FK y por filtro de pantalla, `CheckConstraint` para las mismas
reglas que valida el modelo. Cuatro tablas NUEVAS (`bank_deposits`,
`bank_deposit_allocations`, `card_settlements`, `platform_settlements`): sin
`ALTER` sobre ninguna tabla ajena, así que no hay ningún
`batch_alter_table` que recree nada ni ningún `DependentObjectsStillExist`
que temer (la lección de `0011_purchases.py`, repetida en `0014`). `_enum`
(`app.banking.models`) no pide `create_constraint`: los `status` son
`VARCHAR` planos en los dos motores, sin CHECK que una migración futura
tenga que recrear.

`downgrade` simétrico: borra las cuatro tablas en el orden inverso al que
las crea (las que tienen FK hacia otra de este mismo archivo, primero).

Revision ID: 0017
Revises: 0016
Create Date: 2026-09-20
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from app.banking.models import BankDepositStatus, SettlementStatus

# revision identifiers, used by Alembic.
revision: str = "0017"
down_revision: str | None = "0016"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def _enum(pyenum: type, *, length: int = 16) -> sa.Enum:
    return sa.Enum(pyenum, native_enum=False, length=length, validate_strings=True)


def upgrade() -> None:
    # -- bank_deposits ------------------------------------------------------
    op.create_table(
        "bank_deposits",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("business_date", sa.Date(), nullable=False),
        sa.Column("deposited_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("bank_name", sa.String(120), nullable=True),
        sa.Column("bank_reference", sa.String(120), nullable=True),
        sa.Column("receipt_photo", sa.String(500), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("employee_name", sa.String(200), nullable=False),
        sa.Column("status", _enum(BankDepositStatus), nullable=False),
        sa.Column("reversed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reversed_reason", sa.Text(), nullable=True),
        sa.Column("reversed_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("reversed_by_employee_name", sa.String(200), nullable=True),
        sa.CheckConstraint("amount > 0", name="ck_bank_deposits_amount_positive"),
    )
    op.create_index("ix_bank_deposits_organization_id", "bank_deposits", ["organization_id"])
    op.create_index("ix_bank_deposits_store_id", "bank_deposits", ["store_id"])
    op.create_index("ix_bank_deposits_store_business_date", "bank_deposits", ["store_id", "business_date"])
    op.create_index("ix_bank_deposits_store_status", "bank_deposits", ["store_id", "status"])

    # -- bank_deposit_allocations --------------------------------------------
    # Tabla de línea (como `reception_lines`): sin `organization_id`/`store_id`
    # propios, se consulta siempre a través de `deposit_id` o `shift_id`.
    op.create_table(
        "bank_deposit_allocations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("deposit_id", sa.Integer(), sa.ForeignKey("bank_deposits.id"), nullable=False),
        sa.Column("shift_id", sa.Integer(), sa.ForeignKey("shifts.id"), nullable=False),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.UniqueConstraint("deposit_id", "shift_id", name="uq_bank_deposit_allocations_deposit_shift"),
        sa.CheckConstraint("amount > 0", name="ck_bank_deposit_allocations_amount_positive"),
    )
    op.create_index("ix_bank_deposit_allocations_deposit_id", "bank_deposit_allocations", ["deposit_id"])
    op.create_index("ix_bank_deposit_allocations_shift_id", "bank_deposit_allocations", ["shift_id"])

    # -- card_settlements -----------------------------------------------------
    op.create_table(
        "card_settlements",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("sales_business_date", sa.Date(), nullable=False),
        sa.Column("settled_business_date", sa.Date(), nullable=False),
        sa.Column("gross_amount", sa.Integer(), nullable=False),
        sa.Column("commission_amount", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("retention_amount", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("reference", sa.String(120), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("status", _enum(SettlementStatus), nullable=False),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("employee_name", sa.String(200), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("matched_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("matched_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("matched_by_employee_name", sa.String(200), nullable=True),
        sa.Column("reversed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reversed_reason", sa.Text(), nullable=True),
        sa.Column("reversed_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("reversed_by_employee_name", sa.String(200), nullable=True),
        sa.CheckConstraint("gross_amount >= 0", name="ck_card_settlements_gross_nonneg"),
        sa.CheckConstraint("commission_amount >= 0", name="ck_card_settlements_commission_nonneg"),
        sa.CheckConstraint("retention_amount >= 0", name="ck_card_settlements_retention_nonneg"),
    )
    op.create_index("ix_card_settlements_organization_id", "card_settlements", ["organization_id"])
    op.create_index("ix_card_settlements_store_id", "card_settlements", ["store_id"])
    op.create_index("ix_card_settlements_store_sales_date", "card_settlements", ["store_id", "sales_business_date"])
    op.create_index("ix_card_settlements_store_status", "card_settlements", ["store_id", "status"])

    # -- platform_settlements -------------------------------------------------
    op.create_table(
        "platform_settlements",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("platform_id", sa.Integer(), sa.ForeignKey("delivery_platforms.id"), nullable=False),
        sa.Column("period_from", sa.Date(), nullable=False),
        sa.Column("period_to", sa.Date(), nullable=False),
        sa.Column("gross_amount", sa.Integer(), nullable=False),
        sa.Column("commission_amount", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("reference", sa.String(120), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("status", _enum(SettlementStatus), nullable=False),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("employee_name", sa.String(200), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("matched_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("matched_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("matched_by_employee_name", sa.String(200), nullable=True),
        sa.Column("reversed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reversed_reason", sa.Text(), nullable=True),
        sa.Column("reversed_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("reversed_by_employee_name", sa.String(200), nullable=True),
        sa.CheckConstraint("gross_amount >= 0", name="ck_platform_settlements_gross_nonneg"),
        sa.CheckConstraint("commission_amount >= 0", name="ck_platform_settlements_commission_nonneg"),
        sa.CheckConstraint("period_to >= period_from", name="ck_platform_settlements_period_order"),
    )
    op.create_index("ix_platform_settlements_organization_id", "platform_settlements", ["organization_id"])
    op.create_index("ix_platform_settlements_store_id", "platform_settlements", ["store_id"])
    op.create_index("ix_platform_settlements_platform_id", "platform_settlements", ["platform_id"])
    op.create_index("ix_platform_settlements_store_platform", "platform_settlements", ["store_id", "platform_id"])
    op.create_index("ix_platform_settlements_store_status", "platform_settlements", ["store_id", "status"])


def downgrade() -> None:
    op.drop_table("platform_settlements")
    op.drop_table("card_settlements")
    op.drop_table("bank_deposit_allocations")
    op.drop_table("bank_deposits")
