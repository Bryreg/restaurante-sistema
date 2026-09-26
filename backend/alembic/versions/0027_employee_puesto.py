"""Inicio por rol: el puesto de cada persona y la última que usó la tablet.

- `employees.puesto` dice dónde trabaja la persona en el POS —`caja`,
  `salon`, `cocina` o `bar`— y decide a qué pantalla llega al identificarse y
  qué destinos ve en la barra. Es nulable a propósito: `NULL` es «ve todo», el
  comportamiento de siempre, así que ningún empleado existente cambia. Los
  supervisores y administradores lo ignoran. Va por NOMBRE en un `VARCHAR`
  plano (`native_enum=False`, sin CHECK que recrear), igual que
  `employees.role`.
- `device_sessions.last_employee_id`: la última persona que se identificó en
  esa tablet, para ofrecerla primero en «¿Quién opera?». A diferencia de
  `employee_id`, no se borra al soltar la persona ni al vencer su sesión. Vive
  en el servidor porque en el navegador sólo puede guardarse el tema.

Columnas sueltas sin `batch_alter_table`; la llave foránea de
`last_employee_id` se crea sólo en Postgres (producción), igual que
`0024`/`0025`: SQLite no agrega una restricción a una tabla existente sin
recrearla.

Revision ID: 0027
Revises: 0026
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0027"
down_revision: str | None = "0026"
branch_labels: str | None = None
depends_on: str | None = None

_LAST_EMPLOYEE_FK = "fk_device_sessions_last_employee_id"


def upgrade() -> None:
    op.add_column("employees", sa.Column("puesto", sa.String(length=16), nullable=True))
    op.add_column("device_sessions", sa.Column("last_employee_id", sa.Integer(), nullable=True))
    if op.get_bind().dialect.name != "sqlite":
        op.create_foreign_key(_LAST_EMPLOYEE_FK, "device_sessions", "employees", ["last_employee_id"], ["id"])


def downgrade() -> None:
    if op.get_bind().dialect.name != "sqlite":
        op.drop_constraint(_LAST_EMPLOYEE_FK, "device_sessions", type_="foreignkey")
    op.drop_column("device_sessions", "last_employee_id")
    op.drop_column("employees", "puesto")
