"""Asistencia del día, separada del turno de caja.

- `attendance_entries`: entrada y salida de cada persona por sede y DÍA
  OPERATIVO, con o sin turno de caja abierto. El primer PIN del día marca la
  entrada; «Marcar salida» es un toque; una salida olvidada queda abierta y
  el administrador la ve «a revisar». El turno de caja lee de acá su roster
  (quién estaba cuando se abrió) y nómina suma las horas de acá unidas a las
  del roster, sin contar dos veces el mismo minuto.

Tabla nueva: ninguna tabla existente recibe columnas ni llaves foráneas, así
que no hace falta el camino «sólo en Postgres» de `0024`/`0025`/`0027`. Los
datos anteriores (`shift_roster`) no se tocan: nómina los sigue leyendo tal
cual, y las liquidaciones ya calculadas son un snapshot que no se recalcula.

Revision ID: 0028
Revises: 0027
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0028"
down_revision: str | None = "0027"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.create_table(
        "attendance_entries",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("organization_id", sa.Integer(), nullable=False),
        sa.Column("store_id", sa.Integer(), nullable=False),
        sa.Column("employee_id", sa.Integer(), nullable=False),
        sa.Column("employee_name", sa.String(length=200), nullable=False),
        sa.Column("business_date", sa.Date(), nullable=False),
        sa.Column("puesto", sa.String(length=16), nullable=True),
        sa.Column("in_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("in_source", sa.String(length=16), nullable=False),
        sa.Column("out_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("out_source", sa.String(length=16), nullable=True),
        sa.Column("out_by_employee_id", sa.Integer(), nullable=True),
        sa.Column("out_by_employee_name", sa.String(length=200), nullable=True),
        sa.Column("out_reason", sa.String(length=300), nullable=True),
        sa.Column("pauses", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["employee_id"], ["employees.id"]),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"]),
        sa.ForeignKeyConstraint(["out_by_employee_id"], ["employees.id"]),
        sa.ForeignKeyConstraint(["store_id"], ["stores.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_attendance_entries_organization_id", "attendance_entries", ["organization_id"])
    op.create_index("ix_attendance_entries_store_id", "attendance_entries", ["store_id"])
    op.create_index("ix_attendance_entries_employee_id", "attendance_entries", ["employee_id"])
    op.create_index("ix_attendance_entries_store_date", "attendance_entries", ["store_id", "business_date"])
    op.create_index(
        "uq_attendance_entries_one_open",
        "attendance_entries",
        ["store_id", "employee_id", "business_date"],
        unique=True,
        postgresql_where=sa.text("out_at IS NULL"),
        sqlite_where=sa.text("out_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_attendance_entries_one_open", table_name="attendance_entries")
    op.drop_index("ix_attendance_entries_store_date", table_name="attendance_entries")
    op.drop_index("ix_attendance_entries_employee_id", table_name="attendance_entries")
    op.drop_index("ix_attendance_entries_store_id", table_name="attendance_entries")
    op.drop_index("ix_attendance_entries_organization_id", table_name="attendance_entries")
    op.drop_table("attendance_entries")
