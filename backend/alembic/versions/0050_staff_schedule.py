"""Turnos planeados del equipo (auditoría e1).

`staff_schedule_shifts`: el turno planeado de una persona en un día
operativo (entrada y salida en minutos desde la medianoche del día, reloj de
Bogotá), con una nota libre. Una fila vigente por persona y día (índice
único parcial sobre `voided_at IS NULL`); cambiar o quitar un turno anula la
fila, nunca la borra. Alimenta la comparación planeado contra real de la
asistencia (llegadas tarde, no vino) y la tarjeta «Llegadas tarde».

Una tabla nueva (`staff_schedule_shifts`).

Revision ID: 0050
Revises: 0048
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0050"
down_revision = "0048"
branch_labels: str | None = None
depends_on: str | None = None

_TABLE = "staff_schedule_shifts"


def upgrade() -> None:
    op.create_table(
        _TABLE,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False, index=True),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False, index=True),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False, index=True),
        sa.Column("employee_name", sa.String(200), nullable=False),
        sa.Column("business_date", sa.Date(), nullable=False),
        sa.Column("start_minute", sa.Integer(), nullable=False),
        sa.Column("end_minute", sa.Integer(), nullable=False),
        sa.Column("note", sa.String(300), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("created_by_employee_name", sa.String(200), nullable=True),
        sa.Column("voided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("voided_by_employee_name", sa.String(200), nullable=True),
        sa.Column("void_reason", sa.String(300), nullable=True),
        sa.CheckConstraint("start_minute >= 0 AND start_minute < 2880", name="ck_staff_schedule_start_range"),
        sa.CheckConstraint(
            "end_minute > start_minute AND end_minute <= start_minute + 1440", name="ck_staff_schedule_end_range"
        ),
    )
    op.create_index("ix_staff_schedule_store_date", _TABLE, ["store_id", "business_date"])
    op.create_index(
        "uq_staff_schedule_one_active",
        _TABLE,
        ["store_id", "employee_id", "business_date"],
        unique=True,
        postgresql_where=sa.text("voided_at IS NULL"),
        sqlite_where=sa.text("voided_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_staff_schedule_one_active", table_name=_TABLE)
    op.drop_index("ix_staff_schedule_store_date", table_name=_TABLE)
    op.drop_table(_TABLE)
