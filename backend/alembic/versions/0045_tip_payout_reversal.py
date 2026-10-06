"""Reversa con motivo de un reparto de propinas (`tip_payouts`, c3).

La Ley 1935 de 2018 pide entregar el 100 % de la propina a los trabajadores,
y la tienda tiene que poder probarlo: cuánto se recogió, cuánto se entregó y
cuánto falta. Un reparto cargado por error no se borra ni se edita: se
**reversa** —quién, cuándo y por qué— y deja de contar como entregado (y
como gastado de la mano del dueño). Uno que entra bien es una fila nueva.

Cuatro columnas nullable: las filas existentes quedan vivas, sin respaldo
que inventar. No agrega tablas: el conteo sigue en 123.

Igual que `0034` (`shift_carry_ins`): en SQLite no se agrega la FK de
`reversed_by_employee_id` (agregarla obliga a recrear la tabla, y
`tip_payout_distributions.payout_id` apunta acá — el problema de `0011`); en
Postgres sí, por nombre, sin recrear nada.

Revision ID: 0045
Revises: 0044
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0045"
down_revision = "0044"
branch_labels: str | None = None
depends_on: str | None = None

_TABLE = "tip_payouts"
_FK = "fk_tip_payouts_reversed_by_employee"


def upgrade() -> None:
    op.add_column(_TABLE, sa.Column("reversed_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(_TABLE, sa.Column("reversed_reason", sa.Text(), nullable=True))
    op.add_column(_TABLE, sa.Column("reversed_by_employee_id", sa.Integer(), nullable=True))
    op.add_column(_TABLE, sa.Column("reversed_by_employee_name", sa.String(200), nullable=True))
    if op.get_bind().dialect.name != "sqlite":
        op.create_foreign_key(_FK, _TABLE, "employees", ["reversed_by_employee_id"], ["id"])


def downgrade() -> None:
    if op.get_bind().dialect.name == "sqlite":
        with op.batch_alter_table(_TABLE) as batch_op:
            batch_op.drop_column("reversed_by_employee_name")
            batch_op.drop_column("reversed_by_employee_id")
            batch_op.drop_column("reversed_reason")
            batch_op.drop_column("reversed_at")
    else:
        op.drop_constraint(_FK, _TABLE, type_="foreignkey")
        op.drop_column(_TABLE, "reversed_by_employee_name")
        op.drop_column(_TABLE, "reversed_by_employee_id")
        op.drop_column(_TABLE, "reversed_reason")
        op.drop_column(_TABLE, "reversed_at")
