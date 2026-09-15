"""Rangos de numeración DIAN y notas: `fiscal_ranges` nueva; `fiscal_documents`
gana `fiscal_range_id` como FK real (era `Integer` pelado desde 1b-1),
`customer_id` (Integer **sin** FK dura — ver decisión abajo), `customer_email`,
`customer_address`, `customer_municipality_dane`, `reverses_document_id`
(FK auto-referencial, para notas) y `reason`; `store_sales_settings` gana
`invoice_threshold_uvt`.

DDL escrito a mano (Postgres-first), como `0004_orders.py`/`0005_payments_fiscal.py`
/`0006_customers_refunds_tips.py`: índice por cada FK y por cada filtro de
pantalla. `fiscal_documents` se altera con `batch_alter_table` (SQLite no
soporta `ALTER TABLE ... ADD CONSTRAINT` directo; `render_as_batch` en
`alembic/env.py` ya lo cubre para el resto de la cadena).

**Decisión declarada** (`backend-fiscal`, ver
`features/fase-1b-venta/outputs-1b-2/backend-fiscal.md`): `customer_id`
NO se vuelve FK real todavía, aunque `customers` ya existe como tabla desde
`0006` (que se sequenció antes que esta migración a propósito, según su
propio docstring). Se verificó empíricamente que
`Base.metadata.create_all()` (lo que usa `tests/conftest.py::db`, la fixture
compartida de TODO el árbol) lanza `NoReferencedTableError` si el modelo de
la tabla referenciada no se importó antes — y `app.core.models_registry.
MODEL_MODULES`/`app.main.DOMAINS` todavía no incluyen `"customers"`/
`"refunds"` (archivo fuera de mi territorio). Agregar la FK ahora habría
roto `create_all()` para cualquier proceso de test que importe
`app.fiscal.models` sin haber importado antes `app.customers.models` — la
mayoría de los dominios del repo. Cuando `MODEL_MODULES`/`DOMAINS` se
actualicen (hace falta de todos modos para que `app.customers`/`app.refunds`
tengan router montado y sus propios tests corran), una migración de una
línea agrega la FK real, igual que este pedido hizo con `fiscal_range_id`.

Revision ID: 0007
Revises: 0006
Create Date: 2026-09-15
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from app.fiscal.models import FiscalDocumentType

# revision identifiers, used by Alembic.
revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def _enum(pyenum: type, *, length: int = 32) -> sa.Enum:
    return sa.Enum(pyenum, native_enum=False, length=length, validate_strings=True)


def upgrade() -> None:
    # -- fiscal_ranges ----------------------------------------------------
    op.create_table(
        "fiscal_ranges",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("document_type", _enum(FiscalDocumentType, length=24), nullable=False),
        sa.Column("prefix", sa.String(10), nullable=False),
        sa.Column("from_number", sa.Integer(), nullable=False),
        sa.Column("to_number", sa.Integer(), nullable=False),
        sa.Column("next_number", sa.Integer(), nullable=False),
        sa.Column("resolution_number", sa.String(50), nullable=False),
        sa.Column("resolution_date", sa.Date(), nullable=False),
        sa.Column("valid_from", sa.Date(), nullable=False),
        sa.Column("valid_until", sa.Date(), nullable=False),
        sa.Column("technical_key", sa.String(100), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("from_number >= 1", name="ck_fiscal_ranges_from_positive"),
        sa.CheckConstraint("to_number >= from_number", name="ck_fiscal_ranges_to_gte_from"),
        sa.CheckConstraint("next_number >= from_number", name="ck_fiscal_ranges_next_gte_from"),
        sa.CheckConstraint("next_number <= to_number + 1", name="ck_fiscal_ranges_next_lte_to_plus_one"),
        sa.CheckConstraint("valid_until >= valid_from", name="ck_fiscal_ranges_valid_until_gte_from"),
    )
    op.create_index("ix_fiscal_ranges_organization_id", "fiscal_ranges", ["organization_id"])
    op.create_index("ix_fiscal_ranges_store_id", "fiscal_ranges", ["store_id"])
    op.create_index("ix_fiscal_ranges_store_type", "fiscal_ranges", ["store_id", "document_type"])

    # -- fiscal_documents: columnas nuevas + FK real de fiscal_range_id ----
    with op.batch_alter_table("fiscal_documents") as batch_op:
        batch_op.add_column(sa.Column("customer_id", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("customer_email", sa.String(255), nullable=True))
        batch_op.add_column(sa.Column("customer_address", sa.String(300), nullable=True))
        batch_op.add_column(sa.Column("customer_municipality_dane", sa.String(6), nullable=True))
        batch_op.add_column(sa.Column("reverses_document_id", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("reason", sa.String(300), nullable=True))
        batch_op.create_index("ix_fiscal_documents_customer_id", ["customer_id"])
        batch_op.create_index("ix_fiscal_documents_reverses_document_id", ["reverses_document_id"])
        batch_op.create_index("ix_fiscal_documents_dian_status", ["dian_status"])
        batch_op.create_foreign_key(
            "fk_fiscal_documents_range", "fiscal_ranges", ["fiscal_range_id"], ["id"]
        )
        batch_op.create_foreign_key(
            "fk_fiscal_documents_reverses", "fiscal_documents", ["reverses_document_id"], ["id"]
        )

    # -- store_sales_settings: invoice_threshold_uvt -----------------------
    with op.batch_alter_table("store_sales_settings") as batch_op:
        batch_op.add_column(
            sa.Column("invoice_threshold_uvt", sa.Integer(), nullable=False, server_default="5")
        )


def downgrade() -> None:
    with op.batch_alter_table("store_sales_settings") as batch_op:
        batch_op.drop_column("invoice_threshold_uvt")

    with op.batch_alter_table("fiscal_documents") as batch_op:
        batch_op.drop_constraint("fk_fiscal_documents_reverses", type_="foreignkey")
        batch_op.drop_constraint("fk_fiscal_documents_range", type_="foreignkey")
        batch_op.drop_index("ix_fiscal_documents_dian_status")
        batch_op.drop_index("ix_fiscal_documents_reverses_document_id")
        batch_op.drop_index("ix_fiscal_documents_customer_id")
        batch_op.drop_column("reason")
        batch_op.drop_column("reverses_document_id")
        batch_op.drop_column("customer_municipality_dane")
        batch_op.drop_column("customer_address")
        batch_op.drop_column("customer_email")
        batch_op.drop_column("customer_id")

    op.drop_index("ix_fiscal_ranges_store_type", table_name="fiscal_ranges")
    op.drop_index("ix_fiscal_ranges_store_id", table_name="fiscal_ranges")
    op.drop_index("ix_fiscal_ranges_organization_id", table_name="fiscal_ranges")
    op.drop_table("fiscal_ranges")
