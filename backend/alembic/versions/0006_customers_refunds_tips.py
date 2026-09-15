"""Clientes y habeas data, devoluciones pendientes y reparto de propinas:
`customers`, `customer_consents`, `customer_data_requests`, `pending_refunds`,
`tip_payouts`, `tip_payout_distributions`.

DDL escrito a mano (Postgres-first), como `0004_orders.py`/`0005_payments_fiscal.py`:
índice por cada FK y por cada filtro de pantalla. Esta migración va **antes**
que la de rangos DIAN (`0007`, de `backend-fiscal`) a propósito:
`fiscal_documents.customer_id` (que agrega `0007`) necesita una FK real a
`customers.id`, así que la tabla `customers` tiene que existir primero.

Revision ID: 0006
Revises: 0005
Create Date: 2026-09-15
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from app.customers.models import ConsentPurpose, DataRequestKind
from app.refunds.models import PendingRefundStatus, SettleFrom

# revision identifiers, used by Alembic.
revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def _enum(pyenum: type, *, length: int = 16) -> sa.Enum:
    return sa.Enum(pyenum, native_enum=False, length=length, validate_strings=True)


def upgrade() -> None:
    # -- customers --------------------------------------------------------
    op.create_table(
        "customers",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=True),
        sa.Column("doc_type", sa.String(4), nullable=False),
        sa.Column("doc_number", sa.String(20), nullable=False),
        sa.Column("dv", sa.String(1), nullable=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("email", sa.String(200), nullable=True),
        sa.Column("address", sa.String(300), nullable=True),
        sa.Column("municipality_dane", sa.String(10), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("erased_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("erased_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("erased_by_employee_name", sa.String(200), nullable=True),
        sa.UniqueConstraint("organization_id", "doc_type", "doc_number", name="uq_customers_org_doc"),
    )
    op.create_index("ix_customers_organization_id", "customers", ["organization_id"])
    op.create_index("ix_customers_store_id", "customers", ["store_id"])
    op.create_index("ix_customers_org_doc_number", "customers", ["organization_id", "doc_number"])

    # -- customer_consents --------------------------------------------------
    op.create_table(
        "customer_consents",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("customer_id", sa.Integer(), sa.ForeignKey("customers.id"), nullable=False),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=True),
        sa.Column("purpose", _enum(ConsentPurpose), nullable=False),
        sa.Column("granted", sa.Boolean(), nullable=False),
        sa.Column("channel", sa.String(50), nullable=False),
        sa.Column("text_version", sa.String(50), nullable=False),
        sa.Column("registered_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("registered_by_employee_name", sa.String(200), nullable=True),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_customer_consents_customer_id", "customer_consents", ["customer_id"])
    op.create_index("ix_customer_consents_organization_id", "customer_consents", ["organization_id"])
    op.create_index("ix_customer_consents_customer_at", "customer_consents", ["customer_id", "at"])

    # -- customer_data_requests ----------------------------------------------
    op.create_table(
        "customer_data_requests",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("customer_id", sa.Integer(), sa.ForeignKey("customers.id"), nullable=False),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=True),
        sa.Column("kind", _enum(DataRequestKind), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("response", sa.Text(), nullable=True),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("responded_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("employee_name", sa.String(200), nullable=True),
    )
    op.create_index("ix_customer_data_requests_customer_id", "customer_data_requests", ["customer_id"])
    op.create_index("ix_customer_data_requests_organization_id", "customer_data_requests", ["organization_id"])
    op.create_index(
        "ix_customer_data_requests_customer_at", "customer_data_requests", ["customer_id", "requested_at"]
    )

    # -- pending_refunds ------------------------------------------------------
    op.create_table(
        "pending_refunds",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("document_id", sa.Integer(), sa.ForeignKey("fiscal_documents.id"), nullable=False),
        sa.Column("customer_id", sa.Integer(), sa.ForeignKey("customers.id"), nullable=True),
        sa.Column("customer_name", sa.String(200), nullable=False),
        sa.Column("customer_doc_number", sa.String(20), nullable=False),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("method", sa.String(16), nullable=False),
        sa.Column("authorized_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("authorized_by_employee_name", sa.String(200), nullable=False),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", _enum(PendingRefundStatus), nullable=False, server_default="pending"),
        sa.Column("settled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("settled_from", _enum(SettleFrom), nullable=True),
        sa.Column("settled_shift_id", sa.Integer(), sa.ForeignKey("shifts.id"), nullable=True),
        sa.Column("settled_cash_movement_id", sa.Integer(), sa.ForeignKey("cash_movements.id"), nullable=True),
        sa.Column("settled_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("settled_by_employee_name", sa.String(200), nullable=True),
        sa.CheckConstraint("amount > 0", name="ck_pending_refunds_amount_positive"),
    )
    op.create_index("ix_pending_refunds_organization_id", "pending_refunds", ["organization_id"])
    op.create_index("ix_pending_refunds_store_id", "pending_refunds", ["store_id"])
    op.create_index("ix_pending_refunds_document_id", "pending_refunds", ["document_id"])
    op.create_index("ix_pending_refunds_store_status", "pending_refunds", ["store_id", "status"])
    op.create_index("ix_pending_refunds_document", "pending_refunds", ["document_id"])

    # -- tip_payouts ----------------------------------------------------------
    op.create_table(
        "tip_payouts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("shift_ids", sa.JSON(), nullable=False),
        sa.Column("paid_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("method", sa.String(16), nullable=False),
        sa.Column("total_amount", sa.Integer(), nullable=False),
        sa.Column("created_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("created_by_employee_name", sa.String(200), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("total_amount >= 0", name="ck_tip_payouts_total_nonneg"),
    )
    op.create_index("ix_tip_payouts_organization_id", "tip_payouts", ["organization_id"])
    op.create_index("ix_tip_payouts_store_id", "tip_payouts", ["store_id"])

    # -- tip_payout_distributions ----------------------------------------------
    op.create_table(
        "tip_payout_distributions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("payout_id", sa.Integer(), sa.ForeignKey("tip_payouts.id"), nullable=False),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("employee_name", sa.String(200), nullable=False),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.CheckConstraint("amount >= 0", name="ck_tip_payout_distributions_amount_nonneg"),
    )
    op.create_index("ix_tip_payout_distributions_payout_id", "tip_payout_distributions", ["payout_id"])


def downgrade() -> None:
    op.drop_table("tip_payout_distributions")
    op.drop_table("tip_payouts")
    op.drop_table("pending_refunds")
    op.drop_table("customer_data_requests")
    op.drop_table("customer_consents")
    op.drop_table("customers")
