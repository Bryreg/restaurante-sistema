"""Conteo corto por área (`inventory.shift_counts`): cada área cuenta lo suyo
al abrir y al cerrar, y el administrador puede pedir un recuento sorpresa.

- `count_areas`: las áreas de conteo de una sede (Bar, Cocina).
- `count_area_members`: de qué área es cada persona (una por persona y sede).
- `count_area_items`: los artículos clave de cada área (un insumo se cuenta en
  un solo área por sede).
- `area_recount_requests`: «recontá estos 1–5 artículos», pedido a un área.
- `area_counts` / `area_count_lines`: los conteos cortos (apertura, cierre o
  recuento) con quién contó, a qué hora, y lo que tecleó por artículo.
- `area_count_settings`: el umbral de aviso por sede (porcentaje y monto).

Todas son tablas nuevas: ninguna tabla existente recibe columnas ni llaves
foráneas, así que no hace falta el camino «sólo en Postgres» de `0024`/`0025`.
Los enums van por NOMBRE en un `VARCHAR` plano (`native_enum=False`, sin CHECK
que recrear), igual que el resto de la cadena.

Revision ID: 0026
Revises: 0025
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0026"
down_revision: str | None = "0025"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.create_table('count_areas',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('organization_id', sa.Integer(), nullable=False),
    sa.Column('store_id', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(length=80), nullable=False),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'], ),
    sa.ForeignKeyConstraint(['store_id'], ['stores.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('store_id', 'name', name='uq_count_areas_store_name')
    )
    op.create_index('ix_count_areas_organization_id', 'count_areas', ['organization_id'])
    op.create_index('ix_count_areas_store_id', 'count_areas', ['store_id'])

    op.create_table('count_area_members',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('organization_id', sa.Integer(), nullable=False),
    sa.Column('store_id', sa.Integer(), nullable=False),
    sa.Column('area_id', sa.Integer(), nullable=False),
    sa.Column('employee_id', sa.Integer(), nullable=False),
    sa.Column('employee_name', sa.String(length=200), nullable=False),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['area_id'], ['count_areas.id'], ),
    sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], ),
    sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'], ),
    sa.ForeignKeyConstraint(['store_id'], ['stores.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('store_id', 'employee_id', name='uq_count_area_members_store_employee')
    )
    op.create_index('ix_count_area_members_area_id', 'count_area_members', ['area_id'])
    op.create_index('ix_count_area_members_employee_id', 'count_area_members', ['employee_id'])
    op.create_index('ix_count_area_members_organization_id', 'count_area_members', ['organization_id'])
    op.create_index('ix_count_area_members_store_id', 'count_area_members', ['store_id'])

    op.create_table('count_area_items',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('organization_id', sa.Integer(), nullable=False),
    sa.Column('store_id', sa.Integer(), nullable=False),
    sa.Column('area_id', sa.Integer(), nullable=False),
    sa.Column('ingredient_id', sa.Integer(), nullable=False),
    sa.Column('position', sa.Integer(), nullable=False),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['area_id'], ['count_areas.id'], ),
    sa.ForeignKeyConstraint(['ingredient_id'], ['ingredients.id'], ),
    sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'], ),
    sa.ForeignKeyConstraint(['store_id'], ['stores.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('store_id', 'ingredient_id', name='uq_count_area_items_store_ingredient')
    )
    op.create_index('ix_count_area_items_area_id', 'count_area_items', ['area_id'])
    op.create_index('ix_count_area_items_ingredient_id', 'count_area_items', ['ingredient_id'])
    op.create_index('ix_count_area_items_organization_id', 'count_area_items', ['organization_id'])
    op.create_index('ix_count_area_items_store_id', 'count_area_items', ['store_id'])

    op.create_table('area_recount_requests',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('organization_id', sa.Integer(), nullable=False),
    sa.Column('store_id', sa.Integer(), nullable=False),
    sa.Column('area_id', sa.Integer(), nullable=False),
    sa.Column('ingredient_ids', sa.JSON(), nullable=False),
    sa.Column('note', sa.String(length=300), nullable=True),
    sa.Column('status', sa.Enum('PENDING', 'ANSWERED', name='arearecountstatus', native_enum=False, length=16), nullable=False),
    sa.Column('requested_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('business_date', sa.Date(), nullable=False),
    sa.Column('requested_by_employee_id', sa.Integer(), nullable=False),
    sa.Column('requested_by_employee_name', sa.String(length=200), nullable=False),
    sa.Column('answered_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['area_id'], ['count_areas.id'], ),
    sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'], ),
    sa.ForeignKeyConstraint(['requested_by_employee_id'], ['employees.id'], ),
    sa.ForeignKeyConstraint(['store_id'], ['stores.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_area_recount_requests_area_id', 'area_recount_requests', ['area_id'])
    op.create_index('ix_area_recount_requests_organization_id', 'area_recount_requests', ['organization_id'])
    op.create_index('ix_area_recount_requests_store_id', 'area_recount_requests', ['store_id'])
    op.create_index('ix_area_recount_requests_store_status', 'area_recount_requests', ['store_id', 'status'])

    op.create_table('area_counts',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('organization_id', sa.Integer(), nullable=False),
    sa.Column('store_id', sa.Integer(), nullable=False),
    sa.Column('area_id', sa.Integer(), nullable=False),
    sa.Column('area_name', sa.String(length=80), nullable=False),
    sa.Column('moment', sa.Enum('OPENING', 'CLOSING', 'SPOT', name='areacountmoment', native_enum=False, length=16), nullable=False),
    sa.Column('recount_request_id', sa.Integer(), nullable=True),
    sa.Column('counted_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('business_date', sa.Date(), nullable=False),
    sa.Column('employee_id', sa.Integer(), nullable=False),
    sa.Column('employee_name', sa.String(length=200), nullable=False),
    sa.CheckConstraint("(moment = 'SPOT' AND recount_request_id IS NOT NULL) OR (moment != 'SPOT' AND recount_request_id IS NULL)", name='ck_area_counts_spot_has_request'),
    sa.ForeignKeyConstraint(['area_id'], ['count_areas.id'], ),
    sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], ),
    sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'], ),
    sa.ForeignKeyConstraint(['recount_request_id'], ['area_recount_requests.id'], ),
    sa.ForeignKeyConstraint(['store_id'], ['stores.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('recount_request_id')
    )
    op.create_index('ix_area_counts_area_counted', 'area_counts', ['area_id', 'counted_at'])
    op.create_index('ix_area_counts_area_id', 'area_counts', ['area_id'])
    op.create_index('ix_area_counts_organization_id', 'area_counts', ['organization_id'])
    op.create_index('ix_area_counts_store_date', 'area_counts', ['store_id', 'business_date'])
    op.create_index('ix_area_counts_store_id', 'area_counts', ['store_id'])

    op.create_table('area_count_lines',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('count_id', sa.Integer(), nullable=False),
    sa.Column('ingredient_id', sa.Integer(), nullable=False),
    sa.Column('qty_base', sa.Integer(), nullable=False),
    sa.Column('entered_qty', sa.String(length=20), nullable=False),
    sa.Column('entered_unit', sa.String(length=50), nullable=False),
    sa.CheckConstraint('qty_base >= 0', name='ck_area_count_lines_qty_nonneg'),
    sa.ForeignKeyConstraint(['count_id'], ['area_counts.id'], ),
    sa.ForeignKeyConstraint(['ingredient_id'], ['ingredients.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('count_id', 'ingredient_id', name='uq_area_count_lines_count_ingredient')
    )
    op.create_index('ix_area_count_lines_count_id', 'area_count_lines', ['count_id'])
    op.create_index('ix_area_count_lines_ingredient_id', 'area_count_lines', ['ingredient_id'])

    op.create_table('area_count_settings',
    sa.Column('store_id', sa.Integer(), nullable=False),
    sa.Column('threshold_pct_bp', sa.Integer(), nullable=True),
    sa.Column('threshold_amount', sa.Integer(), nullable=True),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.CheckConstraint('threshold_amount IS NULL OR threshold_amount > 0', name='ck_area_count_settings_amount_positive'),
    sa.CheckConstraint('threshold_pct_bp IS NULL OR threshold_pct_bp > 0', name='ck_area_count_settings_pct_positive'),
    sa.ForeignKeyConstraint(['store_id'], ['stores.id'], ),
    sa.PrimaryKeyConstraint('store_id')
    )


def downgrade() -> None:
    op.drop_table('area_count_settings')
    op.drop_table('area_count_lines')
    op.drop_table('area_counts')
    op.drop_table('area_recount_requests')
    op.drop_table('count_area_items')
    op.drop_table('count_area_members')
    op.drop_table('count_areas')
