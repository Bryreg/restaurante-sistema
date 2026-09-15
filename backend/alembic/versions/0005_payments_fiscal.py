"""Pagos y comprobante interno: `fiscal_counters`, `fiscal_documents`,
`document_reprints`, `payments`, `order_tips`.

DDL escrito a mano (Postgres-first), como `0003_shifts.py`/`0004_orders.py`:
índice por cada FK y por cada filtro de pantalla. El test de migraciones del
auditor (`tests/audit/test_migration_invariants.py`) compara esta migración
contra `app.payments.models`/`app.fiscal.models` columna por columna.

Revision ID: 0005
Revises: 0004
Create Date: 2026-09-15
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from app.fiscal.models import DianStatus, FiscalDocumentType

# revision identifiers, used by Alembic.
revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def _enum(pyenum: type, *, length: int = 32) -> sa.Enum:
    return sa.Enum(pyenum, native_enum=False, length=length, validate_strings=True)


def upgrade() -> None:
    # -- fiscal_counters ----------------------------------------------------
    op.create_table(
        "fiscal_counters",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("document_type", _enum(FiscalDocumentType, length=24), nullable=False),
        sa.Column("prefix", sa.String(10), nullable=False),
        sa.Column("next_number", sa.Integer(), nullable=False, server_default="1"),
        sa.UniqueConstraint("store_id", "document_type", "prefix", name="uq_fiscal_counters_scope"),
        sa.CheckConstraint("next_number >= 1", name="ck_fiscal_counters_next_number_positive"),
    )
    op.create_index("ix_fiscal_counters_store_id", "fiscal_counters", ["store_id"])

    # -- fiscal_documents -----------------------------------------------------
    op.create_table(
        "fiscal_documents",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("order_id", sa.Integer(), sa.ForeignKey("orders.id"), nullable=False),
        sa.Column(
            "sub_account_id", sa.Integer(), sa.ForeignKey("order_sub_accounts.id"), nullable=True
        ),
        sa.Column("shift_id", sa.Integer(), sa.ForeignKey("shifts.id"), nullable=False),
        sa.Column("target_key", sa.String(40), nullable=False, unique=True),
        sa.Column("document_type", _enum(FiscalDocumentType, length=24), nullable=False),
        sa.Column("prefix", sa.String(10), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("dian_status", _enum(DianStatus, length=16), nullable=True),
        sa.Column("legend", sa.String(200), nullable=False),
        sa.Column("business_date", sa.Date(), nullable=False),
        sa.Column("issued_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("customer_doc_type", sa.String(4), nullable=False, server_default="13"),
        sa.Column("customer_doc_number", sa.String(20), nullable=False, server_default="222222222222"),
        sa.Column("customer_name", sa.String(200), nullable=False, server_default="Consumidor final"),
        sa.Column("store_snapshot", sa.JSON(), nullable=False),
        sa.Column("lines", sa.JSON(), nullable=False),
        sa.Column("subtotal", sa.Integer(), nullable=False),
        sa.Column("discount_total", sa.Integer(), nullable=False),
        sa.Column("tax_total", sa.Integer(), nullable=False),
        sa.Column("total", sa.Integer(), nullable=False),
        sa.Column("tax_lines", sa.JSON(), nullable=False),
        sa.Column("tip_amount", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("tip_suggested_pct", sa.Numeric(5, 2), nullable=True),
        sa.Column("tip_accepted", sa.Boolean(), nullable=True),
        sa.Column("tip_modified", sa.Boolean(), nullable=True),
        sa.Column("payments_snapshot", sa.JSON(), nullable=False),
        sa.Column("channel", sa.String(16), nullable=False),
        sa.Column("tables_text", sa.String(100), nullable=True),
        sa.Column("covers", sa.Integer(), nullable=True),
        sa.Column("served_by_name", sa.String(200), nullable=False),
        sa.Column("charged_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("charged_by_employee_name", sa.String(200), nullable=False),
        sa.Column("fiscal_range_id", sa.Integer(), nullable=True),
        sa.Column("cude", sa.String(96), nullable=True),
        sa.Column("qr_url", sa.String(500), nullable=True),
        sa.Column("xml_ref", sa.String(500), nullable=True),
        sa.Column("provider_response", sa.JSON(), nullable=True),
        sa.Column("validated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "status",
            sa.Enum("issued", "reversed", name="fiscal_document_status", native_enum=False, length=16),
            nullable=False,
            server_default="issued",
        ),
        sa.Column("print_count", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("reprint_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint(
            "store_id", "document_type", "prefix", "number", name="uq_fiscal_documents_consecutive"
        ),
        sa.CheckConstraint("number >= 1", name="ck_fiscal_documents_number_positive"),
    )
    op.create_index("ix_fiscal_documents_organization_id", "fiscal_documents", ["organization_id"])
    op.create_index("ix_fiscal_documents_store_id", "fiscal_documents", ["store_id"])
    op.create_index("ix_fiscal_documents_order_id", "fiscal_documents", ["order_id"])
    op.create_index("ix_fiscal_documents_sub_account_id", "fiscal_documents", ["sub_account_id"])
    op.create_index("ix_fiscal_documents_shift_id", "fiscal_documents", ["shift_id"])
    op.create_index("ix_fiscal_documents_order", "fiscal_documents", ["order_id"])
    op.create_index("ix_fiscal_documents_store_business_date", "fiscal_documents", ["store_id", "business_date"])
    op.create_index("ix_fiscal_documents_shift", "fiscal_documents", ["shift_id"])

    # -- document_reprints ----------------------------------------------------
    op.create_table(
        "document_reprints",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("document_id", sa.Integer(), sa.ForeignKey("fiscal_documents.id"), nullable=False),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("employee_name", sa.String(200), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_document_reprints_document_id", "document_reprints", ["document_id"])

    # -- payments -------------------------------------------------------------
    op.create_table(
        "payments",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("shift_id", sa.Integer(), sa.ForeignKey("shifts.id"), nullable=False),
        sa.Column("order_id", sa.Integer(), sa.ForeignKey("orders.id"), nullable=False),
        sa.Column(
            "sub_account_id", sa.Integer(), sa.ForeignKey("order_sub_accounts.id"), nullable=True
        ),
        sa.Column("document_id", sa.Integer(), sa.ForeignKey("fiscal_documents.id"), nullable=True),
        sa.Column("method", sa.String(16), nullable=False),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("tip_amount", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("tendered", sa.Integer(), nullable=True),
        sa.Column("change", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("reference", sa.String(120), nullable=True),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("employee_name", sa.String(200), nullable=False),
        sa.Column("business_date", sa.Date(), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("voided_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("amount >= 0", name="ck_payments_amount_nonneg"),
        sa.CheckConstraint("tip_amount >= 0", name="ck_payments_tip_amount_nonneg"),
        sa.CheckConstraint("change >= 0", name="ck_payments_change_nonneg"),
    )
    op.create_index("ix_payments_organization_id", "payments", ["organization_id"])
    op.create_index("ix_payments_store_id", "payments", ["store_id"])
    op.create_index("ix_payments_shift_id", "payments", ["shift_id"])
    op.create_index("ix_payments_order_id", "payments", ["order_id"])
    op.create_index("ix_payments_sub_account_id", "payments", ["sub_account_id"])
    op.create_index("ix_payments_document_id", "payments", ["document_id"])
    op.create_index("ix_payments_shift", "payments", ["shift_id"])
    op.create_index("ix_payments_order", "payments", ["order_id"])
    op.create_index("ix_payments_shift_method", "payments", ["shift_id", "method"])

    # -- order_tips -------------------------------------------------------------
    op.create_table(
        "order_tips",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("order_id", sa.Integer(), sa.ForeignKey("orders.id"), nullable=False),
        sa.Column(
            "sub_account_id", sa.Integer(), sa.ForeignKey("order_sub_accounts.id"), nullable=True
        ),
        sa.Column("asked", sa.Boolean(), nullable=False),
        sa.Column("accepted", sa.Boolean(), nullable=False),
        sa.Column("modified", sa.Boolean(), nullable=False),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("suggested_pct", sa.Numeric(5, 2), nullable=False),
        sa.Column("suggested_amount", sa.Integer(), nullable=False),
        sa.Column("base", sa.Integer(), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("amount >= 0", name="ck_order_tips_amount_nonneg"),
    )
    op.create_index("ix_order_tips_order_id", "order_tips", ["order_id"])
    op.create_index("ix_order_tips_sub_account_id", "order_tips", ["sub_account_id"])


def downgrade() -> None:
    op.drop_table("order_tips")
    op.drop_table("payments")
    op.drop_table("document_reprints")
    op.drop_table("fiscal_documents")
    op.drop_table("fiscal_counters")
