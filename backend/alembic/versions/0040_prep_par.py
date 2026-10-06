"""Mise en place con nivel par.

Pedido del dueño (2026-10-06): cada preparación con su nivel par —cuánto debe
haber al abrir— para que la cocina sepa cada mañana qué producir y cuántas
tandas, contra lo que hay y lo que se viene usando.

- `preparations.par_qty`: el par, en milésimas de la unidad de rendimiento.

Columnas, no tablas: sigue en 118.

Revision ID: 0040
Revises: 0039
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0040"
down_revision = "0039"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column("preparations", sa.Column("par_qty", sa.BigInteger(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("preparations") as batch:
        batch.drop_column("par_qty")
