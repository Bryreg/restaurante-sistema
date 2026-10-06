"""Anular un conteo con reversa.

Pedido del dueño (2026-10-06): dos conteos completos de la demo, aplicados en
el mismo instante, ensuciaban las fichas y la línea de tiempo. Borrarlos
cambiaría el stock de 57 insumos y rompería la regla de que el libro no se
borra. Anular un conteo escribe, por cada ajuste que hizo, el movimiento
contrario, y lo marca `voided` con quién, cuándo y por qué.

- `stock_counts.voided_at`, `voided_by_employee_id`, `voided_by_employee_name`,
  `void_reason`. El estado `voided` entra en la columna `status` (texto).

Revision ID: 0037
Revises: 0036
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0037"
down_revision = "0036"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    # Columnas sueltas y sin recrear la tabla, como `0034`: nadie más cambia
    # en `stock_counts` y en SQLite un `batch_alter_table` la reconstruiría.
    op.add_column("stock_counts", sa.Column("voided_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("stock_counts", sa.Column("voided_by_employee_id", sa.Integer(), nullable=True))
    op.add_column("stock_counts", sa.Column("voided_by_employee_name", sa.String(200), nullable=True))
    op.add_column("stock_counts", sa.Column("void_reason", sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("stock_counts") as batch:
        batch.drop_column("void_reason")
        batch.drop_column("voided_by_employee_name")
        batch.drop_column("voided_by_employee_id")
        batch.drop_column("voided_at")
