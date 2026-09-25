"""La rutina del turno en el POS: recibir mercancía, solicitudes y novedades;
merma con consumo interno y traslado.

- `reception_drafts` / `reception_draft_lines`: lo que el cajero recibió sin
  precios, hasta que el administrador lo completa (`app.purchases`).
- `staff_requests` / `staff_request_lines`: pedidos de insumos y de sencilla
  (`app.requests`).
- `novelties`: novedades del turno (`app.novelties`).
- `wastes`: quién consumió (consumo interno), a qué sede se trasladó y cuándo
  y cómo la recibió la sede destino. Todas nulables: las mermas que ya existen
  no cambian.

`wastes` recibe columnas sueltas sin `batch_alter_table` y sus llaves
foráneas se crean sólo en Postgres (producción), igual que `0024`: SQLite no
agrega una restricción a una tabla existente sin recrearla.

Revision ID: 0025
Revises: 0024
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0025"
down_revision: str | None = "0024"
branch_labels: str | None = None
depends_on: str | None = None

_WASTE_FKS = [
    ("fk_wastes_consumer_employee_id", "employees", "consumer_employee_id"),
    ("fk_wastes_destination_store_id", "stores", "destination_store_id"),
    ("fk_wastes_received_ingredient_id", "ingredients", "received_ingredient_id"),
    ("fk_wastes_received_movement_id", "stock_movements", "received_movement_id"),
    ("fk_wastes_received_by_employee_id", "employees", "received_by_employee_id"),
]


def upgrade() -> None:
    op.create_table('reception_drafts',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('organization_id', sa.Integer(), nullable=False),
    sa.Column('store_id', sa.Integer(), nullable=False),
    sa.Column('supplier_id', sa.Integer(), nullable=False),
    sa.Column('invoice_number', sa.String(length=80), nullable=True),
    sa.Column('no_invoice', sa.Boolean(), nullable=False),
    sa.Column('photo', sa.String(length=500), nullable=False),
    sa.Column('status', sa.Enum('PENDING', 'COMPLETED', 'REJECTED', name='receptiondraftstatus', native_enum=False, length=16), nullable=False),
    sa.Column('cash_paid_amount', sa.Integer(), nullable=True),
    sa.Column('cash_movement_id', sa.Integer(), nullable=True),
    sa.Column('created_by_employee_id', sa.Integer(), nullable=False),
    sa.Column('created_by_employee_name', sa.String(length=200), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('business_date', sa.Date(), nullable=False),
    sa.Column('reception_id', sa.Integer(), nullable=True),
    sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('completed_by_employee_id', sa.Integer(), nullable=True),
    sa.Column('completed_by_employee_name', sa.String(length=200), nullable=True),
    sa.Column('rejected_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('rejected_reason', sa.Text(), nullable=True),
    sa.Column('rejected_by_employee_id', sa.Integer(), nullable=True),
    sa.Column('rejected_by_employee_name', sa.String(length=200), nullable=True),
    sa.CheckConstraint('cash_paid_amount IS NULL OR cash_paid_amount > 0', name='ck_reception_drafts_cash_paid_positive'),
    sa.ForeignKeyConstraint(['cash_movement_id'], ['cash_movements.id'], ),
    sa.ForeignKeyConstraint(['completed_by_employee_id'], ['employees.id'], ),
    sa.ForeignKeyConstraint(['created_by_employee_id'], ['employees.id'], ),
    sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'], ),
    sa.ForeignKeyConstraint(['reception_id'], ['receptions.id'], ),
    sa.ForeignKeyConstraint(['rejected_by_employee_id'], ['employees.id'], ),
    sa.ForeignKeyConstraint(['store_id'], ['stores.id'], ),
    sa.ForeignKeyConstraint(['supplier_id'], ['suppliers.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('reception_id')
    )
    op.create_index('ix_reception_drafts_organization_id', 'reception_drafts', ['organization_id'])
    op.create_index('ix_reception_drafts_store_date', 'reception_drafts', ['store_id', 'business_date'])
    op.create_index('ix_reception_drafts_store_id', 'reception_drafts', ['store_id'])
    op.create_index('ix_reception_drafts_store_status', 'reception_drafts', ['store_id', 'status'])
    op.create_index('ix_reception_drafts_supplier_id', 'reception_drafts', ['supplier_id'])

    op.create_table('reception_draft_lines',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('draft_id', sa.Integer(), nullable=False),
    sa.Column('ingredient_id', sa.Integer(), nullable=False),
    sa.Column('qty_purchase_milli', sa.Integer(), nullable=False),
    sa.Column('purchase_unit', sa.String(length=50), nullable=False),
    sa.Column('purchase_factor', sa.Integer(), nullable=False),
    sa.Column('qty_base', sa.Integer(), nullable=False),
    sa.Column('lot_code', sa.String(length=80), nullable=True),
    sa.Column('expires_at', sa.Date(), nullable=True),
    sa.CheckConstraint('purchase_factor > 0', name='ck_reception_draft_lines_factor_positive'),
    sa.CheckConstraint('qty_base > 0', name='ck_reception_draft_lines_qty_base_positive'),
    sa.CheckConstraint('qty_purchase_milli > 0', name='ck_reception_draft_lines_qty_positive'),
    sa.ForeignKeyConstraint(['draft_id'], ['reception_drafts.id'], ),
    sa.ForeignKeyConstraint(['ingredient_id'], ['ingredients.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_reception_draft_lines_draft_id', 'reception_draft_lines', ['draft_id'])
    op.create_index('ix_reception_draft_lines_ingredient_id', 'reception_draft_lines', ['ingredient_id'])

    op.create_table('staff_requests',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('organization_id', sa.Integer(), nullable=False),
    sa.Column('store_id', sa.Integer(), nullable=False),
    sa.Column('shift_id', sa.Integer(), nullable=False),
    sa.Column('business_date', sa.Date(), nullable=False),
    sa.Column('kind', sa.String(length=16), nullable=False),
    sa.Column('status', sa.Enum('PENDING', 'APPROVED', 'REJECTED', 'BOUGHT', 'RECEIVED', name='staffrequeststatus', native_enum=False, length=16), nullable=False),
    sa.Column('note', sa.Text(), nullable=True),
    sa.Column('reason', sa.Text(), nullable=True),
    sa.Column('requested_denominations', sa.JSON(), nullable=True),
    sa.Column('requested_total', sa.Integer(), nullable=True),
    sa.Column('approved_denominations', sa.JSON(), nullable=True),
    sa.Column('approved_total', sa.Integer(), nullable=True),
    sa.Column('cash_swap_id', sa.Integer(), nullable=True),
    sa.Column('requested_by_employee_id', sa.Integer(), nullable=False),
    sa.Column('requested_by_employee_name', sa.String(length=200), nullable=False),
    sa.Column('requested_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('resolved_by_employee_id', sa.Integer(), nullable=True),
    sa.Column('resolved_by_employee_name', sa.String(length=200), nullable=True),
    sa.Column('resolved_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('resolution_note', sa.Text(), nullable=True),
    sa.Column('closed_by_employee_id', sa.Integer(), nullable=True),
    sa.Column('closed_by_employee_name', sa.String(length=200), nullable=True),
    sa.Column('closed_at', sa.DateTime(timezone=True), nullable=True),
    sa.CheckConstraint("kind IN ('supply', 'change')", name='ck_staff_requests_kind'),
    sa.CheckConstraint('approved_total IS NULL OR approved_total > 0', name='ck_staff_requests_approved_total_positive'),
    sa.CheckConstraint('requested_total IS NULL OR requested_total > 0', name='ck_staff_requests_requested_total_positive'),
    sa.ForeignKeyConstraint(['cash_swap_id'], ['cash_swaps.id'], ),
    sa.ForeignKeyConstraint(['closed_by_employee_id'], ['employees.id'], ),
    sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'], ),
    sa.ForeignKeyConstraint(['requested_by_employee_id'], ['employees.id'], ),
    sa.ForeignKeyConstraint(['resolved_by_employee_id'], ['employees.id'], ),
    sa.ForeignKeyConstraint(['shift_id'], ['shifts.id'], ),
    sa.ForeignKeyConstraint(['store_id'], ['stores.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_staff_requests_organization_id', 'staff_requests', ['organization_id'])
    op.create_index('ix_staff_requests_shift_id', 'staff_requests', ['shift_id'])
    op.create_index('ix_staff_requests_store_id', 'staff_requests', ['store_id'])
    op.create_index('ix_staff_requests_store_status', 'staff_requests', ['store_id', 'status'])

    op.create_table('staff_request_lines',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('request_id', sa.Integer(), nullable=False),
    sa.Column('ingredient_id', sa.Integer(), nullable=False),
    sa.Column('ingredient_name', sa.String(length=200), nullable=False),
    sa.Column('base_unit', sa.String(length=8), nullable=False),
    sa.Column('qty_requested', sa.Integer(), nullable=False),
    sa.Column('qty_approved', sa.Integer(), nullable=True),
    sa.Column('suggested_qty', sa.Integer(), nullable=True),
    sa.CheckConstraint('qty_approved IS NULL OR qty_approved >= 0', name='ck_staff_request_lines_qty_approved_non_negative'),
    sa.CheckConstraint('qty_requested > 0', name='ck_staff_request_lines_qty_requested_positive'),
    sa.ForeignKeyConstraint(['ingredient_id'], ['ingredients.id'], ),
    sa.ForeignKeyConstraint(['request_id'], ['staff_requests.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_staff_request_lines_ingredient_id', 'staff_request_lines', ['ingredient_id'])
    op.create_index('ix_staff_request_lines_request_id', 'staff_request_lines', ['request_id'])

    op.create_table('novelties',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('organization_id', sa.Integer(), nullable=False),
    sa.Column('store_id', sa.Integer(), nullable=False),
    sa.Column('shift_id', sa.Integer(), nullable=True),
    sa.Column('business_date', sa.Date(), nullable=False),
    sa.Column('title', sa.String(length=200), nullable=False),
    sa.Column('detail', sa.Text(), nullable=True),
    sa.Column('category', sa.Enum('INCIDENT', 'EQUIPMENT', 'STAFF', 'CUSTOMER', 'SECURITY', 'OTHER', name='noveltycategory', native_enum=False, length=16), nullable=False),
    sa.Column('level', sa.Enum('INFO', 'IMPORTANT', 'URGENT', name='noveltylevel', native_enum=False, length=16), nullable=False),
    sa.Column('requires_follow_up', sa.Boolean(), nullable=False),
    sa.Column('photo_url', sa.String(length=500), nullable=True),
    sa.Column('employee_id', sa.Integer(), nullable=False),
    sa.Column('employee_name', sa.String(length=200), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('resolved_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('resolved_by_employee_id', sa.Integer(), nullable=True),
    sa.Column('resolved_by_employee_name', sa.String(length=200), nullable=True),
    sa.Column('resolution_note', sa.Text(), nullable=True),
    sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], ),
    sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'], ),
    sa.ForeignKeyConstraint(['resolved_by_employee_id'], ['employees.id'], ),
    sa.ForeignKeyConstraint(['shift_id'], ['shifts.id'], ),
    sa.ForeignKeyConstraint(['store_id'], ['stores.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_novelties_organization_id', 'novelties', ['organization_id'])
    op.create_index('ix_novelties_shift_id', 'novelties', ['shift_id'])
    op.create_index('ix_novelties_store_date', 'novelties', ['store_id', 'business_date'])
    op.create_index('ix_novelties_store_id', 'novelties', ['store_id'])
    op.create_index('ix_novelties_store_open', 'novelties', ['store_id', 'requires_follow_up', 'resolved_at'])

    op.add_column("wastes", sa.Column("consumer_employee_id", sa.Integer(), nullable=True))
    op.add_column("wastes", sa.Column("consumer_name", sa.String(length=200), nullable=True))
    op.add_column("wastes", sa.Column("destination_store_id", sa.Integer(), nullable=True))
    op.add_column("wastes", sa.Column("received_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("wastes", sa.Column("received_business_date", sa.Date(), nullable=True))
    op.add_column("wastes", sa.Column("received_ingredient_id", sa.Integer(), nullable=True))
    op.add_column("wastes", sa.Column("received_movement_id", sa.Integer(), nullable=True))
    op.add_column("wastes", sa.Column("received_by_employee_id", sa.Integer(), nullable=True))
    op.add_column("wastes", sa.Column("received_by_employee_name", sa.String(length=200), nullable=True))
    op.create_index("ix_wastes_destination_received", "wastes", ["destination_store_id", "received_at"])
    if op.get_bind().dialect.name != "sqlite":
        for name, table, column in _WASTE_FKS:
            op.create_foreign_key(name, "wastes", table, [column], ["id"])


def downgrade() -> None:
    if op.get_bind().dialect.name != "sqlite":
        for name, _table, _column in _WASTE_FKS:
            op.drop_constraint(name, "wastes", type_="foreignkey")
    op.drop_index("ix_wastes_destination_received", table_name="wastes")
    for column in (
        "received_by_employee_name",
        "received_by_employee_id",
        "received_movement_id",
        "received_ingredient_id",
        "received_business_date",
        "received_at",
        "destination_store_id",
        "consumer_name",
        "consumer_employee_id",
    ):
        op.drop_column("wastes", column)
    op.drop_table('novelties')
    op.drop_table('staff_request_lines')
    op.drop_table('staff_requests')
    op.drop_table('reception_draft_lines')
    op.drop_table('reception_drafts')
