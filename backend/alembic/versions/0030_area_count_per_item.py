"""Conteo por área artículo por artículo, obligatorio al abrir, y conteo
completo mensual.

El dueño decidió (decisión 5) que el conteo de apertura de la lista corta de
cada área es OBLIGATORIO, que se guarda artículo por artículo (quien termina
primero ayuda al otro área, y cada artículo dice quién lo contó y a qué hora)
y que una vez al mes la lista pasa a ser TODO lo del área por categoría.

- `area_count_lines` pasa a ser una ENTRADA: gana `counted_at`,
  `employee_id` y `employee_name` (quién contó ESE artículo y cuándo). Se
  rellenan desde su conteo para las filas que ya existen, así que la
  matemática de siempre da lo mismo sobre lo viejo. Se quita la restricción
  «un renglón por artículo y conteo» (`uq_area_count_lines_count_ingredient`):
  recontar un artículo agrega otra entrada, manda la última y la anterior
  queda en el historial (nada se borra). Queda un índice común en su lugar.
- `area_counts` gana `scope` (`short` / `full`: con qué lista se contó) y
  `session_key` (`área:momento:fecha`), único: es lo que hace que dos tablets
  que guardan el primer artículo a la vez caigan en la MISMA sesión y no en
  dos. Los conteos viejos lo llevan en `NULL` (no chocan entre sí).
- `count_areas.full_count_categories`: las categorías de insumo que cuenta
  el área el día del conteo completo (JSON, `NULL` = ninguna).
- `area_count_settings.monthly_full_count_day`: el día del mes (1–28) del
  conteo completo; `NULL` = apagado. El rango lo valida el esquema antes de
  escribir.

Ninguna tabla nueva: el conteo de tablas no se mueve. En SQLite sacar la
restricción exige recrear `area_count_lines` (`batch_alter_table`); la llave
foránea de `employee_id` se crea sólo en Postgres, igual que `0024`/`0025`/
`0027`.

Revision ID: 0030
Revises: 0027
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0030"
down_revision = "0028"
branch_labels: str | None = None
depends_on: str | None = None

_LINE_EMPLOYEE_FK = "fk_area_count_lines_employee_id"
_LINE_UNIQUE = "uq_area_count_lines_count_ingredient"
_LINE_INDEX = "ix_area_count_lines_count_ingredient"
_SESSION_INDEX = "uq_area_counts_session_key"


def upgrade() -> None:
    sqlite = op.get_bind().dialect.name == "sqlite"

    op.add_column("count_areas", sa.Column("full_count_categories", sa.JSON(), nullable=True))
    op.add_column("area_count_settings", sa.Column("monthly_full_count_day", sa.Integer(), nullable=True))
    op.add_column("area_counts", sa.Column("scope", sa.String(length=8), nullable=True))
    op.add_column("area_counts", sa.Column("session_key", sa.String(length=80), nullable=True))
    op.create_index(_SESSION_INDEX, "area_counts", ["session_key"], unique=True)

    op.add_column("area_count_lines", sa.Column("counted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("area_count_lines", sa.Column("employee_id", sa.Integer(), nullable=True))
    op.add_column("area_count_lines", sa.Column("employee_name", sa.String(length=200), nullable=True))
    op.execute(
        "UPDATE area_count_lines SET "
        "counted_at = (SELECT c.counted_at FROM area_counts c WHERE c.id = area_count_lines.count_id), "
        "employee_id = (SELECT c.employee_id FROM area_counts c WHERE c.id = area_count_lines.count_id), "
        "employee_name = (SELECT c.employee_name FROM area_counts c WHERE c.id = area_count_lines.count_id)"
    )
    op.execute("UPDATE area_counts SET scope = 'short' WHERE scope IS NULL AND moment != 'SPOT'")

    if sqlite:
        with op.batch_alter_table("area_count_lines", recreate="always") as batch:
            batch.drop_constraint(_LINE_UNIQUE, type_="unique")
    else:
        op.drop_constraint(_LINE_UNIQUE, "area_count_lines", type_="unique")
        op.create_foreign_key(_LINE_EMPLOYEE_FK, "area_count_lines", "employees", ["employee_id"], ["id"])
    op.create_index(_LINE_INDEX, "area_count_lines", ["count_id", "ingredient_id"])


def downgrade() -> None:
    sqlite = op.get_bind().dialect.name == "sqlite"
    op.drop_index(_LINE_INDEX, table_name="area_count_lines")
    if sqlite:
        with op.batch_alter_table("area_count_lines", recreate="always") as batch:
            batch.drop_column("employee_name")
            batch.drop_column("employee_id")
            batch.drop_column("counted_at")
    else:
        op.drop_constraint(_LINE_EMPLOYEE_FK, "area_count_lines", type_="foreignkey")
        op.drop_column("area_count_lines", "employee_name")
        op.drop_column("area_count_lines", "employee_id")
        op.drop_column("area_count_lines", "counted_at")
    # La restricción vieja no se repone: con recuentos por artículo puede haber
    # más de una entrada por artículo y conteo, y bajar no borra historia.
    op.drop_index(_SESSION_INDEX, table_name="area_counts")
    op.drop_column("area_counts", "session_key")
    op.drop_column("area_counts", "scope")
    op.drop_column("area_count_settings", "monthly_full_count_day")
    op.drop_column("count_areas", "full_count_categories")
