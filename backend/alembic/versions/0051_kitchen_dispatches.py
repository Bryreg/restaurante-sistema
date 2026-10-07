"""«Despachar» desde el KDS sin tocar el plato.

`kitchen_dispatches`: una fila por plato que cocina despachó (el tiquete
sale de la pantalla de cocina). El ítem sigue `ready` hasta que el salón lo
marca `served`, así el aviso de «listo para llevar» de Mesas no se pierde.
Append-only, con quién y cuándo.

Una tabla nueva (`kitchen_dispatches`).

Revision ID: 0051
Revises: 0050
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0051"
down_revision = "0050"
branch_labels: str | None = None
depends_on: str | None = None

_TABLE = "kitchen_dispatches"


def upgrade() -> None:
    op.create_table(
        _TABLE,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False, index=True),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False, index=True),
        sa.Column("order_id", sa.Integer(), sa.ForeignKey("orders.id"), nullable=False, index=True),
        sa.Column("item_id", sa.Integer(), sa.ForeignKey("order_items.id"), nullable=False, index=True),
        sa.Column("dispatched_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("dispatched_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("dispatched_by_employee_name", sa.String(200), nullable=False),
    )
    op.create_index("ix_kitchen_dispatches_item_at", _TABLE, ["item_id", "dispatched_at"])


def downgrade() -> None:
    op.drop_index("ix_kitchen_dispatches_item_at", table_name=_TABLE)
    op.drop_table(_TABLE)
