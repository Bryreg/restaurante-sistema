"""Reversa con motivo de «qué días estaban en el cajón» (`shift_carry_ins`).

Decisión del dueño (2026-09-29, «Ajustar apertura» como el café): el
administrador puede rehacer de qué días era la plata que había en el cajón
al abrir un turno. Nada se borra: un día que sale de la selección queda
**reversado** (`reversed_at`, `reversed_reason`, quién) y deja de contar; uno
que entra es una fila nueva. Por eso la unicidad «un día una sola vez por
turno» pasa a ser sobre las filas VIVAS: se reemplaza la restricción única
`uq_shift_carry_ins_shift_source` por el índice único parcial
`uq_shift_carry_ins_live_shift_source` (`WHERE reversed_at IS NULL`).

Cuatro columnas nullable (las filas existentes quedan vivas, sin respaldo) y
el cambio de unicidad. Además, `shifts.opening_expected` (nullable): lo que
debería haber en el cajón al abrir con la apertura «igual al café». Los
turnos anteriores quedan en `NULL` y su cuenta no cambia. No agrega tablas:
el conteo sigue en 113.

SQLite no sabe soltar una restricción sin recrear la tabla: ahí se usa
`batch_alter_table` (nadie apunta a `shift_carry_ins`, así que recrearla no
arrastra llaves ajenas — el problema de `0011`/`0021`). En Postgres se suelta
la restricción por nombre, sin recrear nada.

Revision ID: 0034
Revises: 0033
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0034"
down_revision = "0033"
branch_labels: str | None = None
depends_on: str | None = None

_TABLE = "shift_carry_ins"
_OLD_UNIQUE = "uq_shift_carry_ins_shift_source"
_NEW_INDEX = "uq_shift_carry_ins_live_shift_source"


def upgrade() -> None:
    op.add_column("shifts", sa.Column("opening_expected", sa.Integer(), nullable=True))
    op.add_column(_TABLE, sa.Column("reversed_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(_TABLE, sa.Column("reversed_reason", sa.Text(), nullable=True))
    op.add_column(_TABLE, sa.Column("reversed_by_employee_id", sa.Integer(), nullable=True))
    op.add_column(_TABLE, sa.Column("reversed_by_employee_name", sa.String(200), nullable=True))

    if op.get_bind().dialect.name == "sqlite":
        with op.batch_alter_table(_TABLE) as batch_op:
            batch_op.drop_constraint(_OLD_UNIQUE, type_="unique")
    else:
        op.drop_constraint(_OLD_UNIQUE, _TABLE, type_="unique")
        op.create_foreign_key(
            "fk_shift_carry_ins_reversed_by_employee",
            _TABLE,
            "employees",
            ["reversed_by_employee_id"],
            ["id"],
        )

    op.create_index(
        _NEW_INDEX,
        _TABLE,
        ["shift_id", "source_shift_id"],
        unique=True,
        postgresql_where=sa.text("reversed_at IS NULL"),
        sqlite_where=sa.text("reversed_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index(_NEW_INDEX, table_name=_TABLE)
    # Sin recrear `shifts` (la apuntan medio esquema): `DROP COLUMN` directo,
    # como `0029` con `opening_mode`/`opening_fixed_base`.
    op.drop_column("shifts", "opening_expected")
    if op.get_bind().dialect.name == "sqlite":
        with op.batch_alter_table(_TABLE) as batch_op:
            batch_op.drop_column("reversed_by_employee_name")
            batch_op.drop_column("reversed_by_employee_id")
            batch_op.drop_column("reversed_reason")
            batch_op.drop_column("reversed_at")
            batch_op.create_unique_constraint(_OLD_UNIQUE, ["shift_id", "source_shift_id"])
    else:
        op.drop_constraint("fk_shift_carry_ins_reversed_by_employee", _TABLE, type_="foreignkey")
        op.drop_column(_TABLE, "reversed_by_employee_name")
        op.drop_column(_TABLE, "reversed_by_employee_id")
        op.drop_column(_TABLE, "reversed_reason")
        op.drop_column(_TABLE, "reversed_at")
        # Un downgrade con días reversados deja filas repetidas por
        # (turno, día); la restricción vieja no puede volver sobre ellas. Se
        # conserva la más reciente viva de cada par por fuera de la
        # restricción: el downgrade no borra historia, así que si hay
        # repetidos falla acá, a la vista, en vez de perder filas.
        op.create_unique_constraint(_OLD_UNIQUE, _TABLE, ["shift_id", "source_shift_id"])
