"""Recargos de nómina con las fechas de la ley y la hora extra nocturna.

La auditoría del 2026-10-06 encontró dos errores en la nómina:

1. **La hora extra nocturna pagaba 60 %** (extra 25 % + nocturno 35 %
   sumados). El CST (art. 168) le fija su propio 75 %. Nueva columna
   `payroll_surcharge_tables.night_overtime_surcharge_bp` (default 7500).
2. **Las vigencias sembradas por `0020_payroll.py` tenían fechas
   corridas**: el dominical 90 % arrancaba el 1-ene-2026 (la ley: 1-jul-2026),
   el 80 % el 1-ene-2025 (ley: 1-jul-2025), la ventana nocturna desde las
   19:00 el 1-dic-2025 (ley: 25-dic-2025), faltaban los escalones de 47 h,
   46 h y 44 h de la Ley 2101 (15 de julio de 2023, 2024 y 2025) y el
   de 42 h quedó el 1-jul-2026 en vez del 15-jul-2026.

Corrección de los datos: las filas que sembró una migración (las que tienen
`created_by_employee_id IS NULL`: nadie las cargó ni confirmó) se
reemplazan por el calendario legal. Lo que cargó una persona no se toca, y
una fecha que ya tiene una fila de una persona no recibe la sembrada. Las
liquidaciones ya calculadas no cambian: guardan su propia foto de la tabla
(`payroll_runs.tables_used`).

Las sedes creadas después de 0020 nacieron sin ninguna tabla (la siembra
sólo corría en esa migración); también reciben el calendario. Desde acá la
siembra vive en `app/payroll/legal.py` y corre al crear una sede.

Columnas, no tablas: sigue en 118.

Revision ID: 0041
Revises: 0040
"""

from __future__ import annotations

from datetime import datetime, timezone

import sqlalchemy as sa
from alembic import op

revision: str = "0041"
down_revision = "0040"
branch_labels: str | None = None
depends_on: str | None = None


# Copia congelada de `app.payroll.legal.LEGAL_SURCHARGE_CALENDAR` a la fecha
# de esta migración (una migración no importa código vivo de la app).
# (valid_from, hora inicio nocturno, dominical bp, horas semanales)
_CALENDAR: list[tuple[str, int, int, int]] = [
    ("2020-01-01", 21, 7500, 48),
    ("2023-07-15", 21, 7500, 47),
    ("2024-07-15", 21, 7500, 46),
    ("2025-07-01", 21, 8000, 46),
    ("2025-07-15", 21, 8000, 44),
    ("2025-12-25", 19, 8000, 44),
    ("2026-07-01", 19, 9000, 44),
    ("2026-07-15", 19, 9000, 42),
    ("2027-07-01", 19, 10000, 42),
]


def upgrade() -> None:
    with op.batch_alter_table("payroll_surcharge_tables") as batch:
        batch.add_column(
            sa.Column("night_overtime_surcharge_bp", sa.Integer(), nullable=False, server_default="7500")
        )
        batch.create_check_constraint(
            "ck_payroll_surcharge_night_ot_bp_nonneg", "night_overtime_surcharge_bp >= 0"
        )

    bind = op.get_bind()
    table = sa.table(
        "payroll_surcharge_tables",
        sa.column("id"),
        sa.column("organization_id"),
        sa.column("store_id"),
        sa.column("valid_from", sa.Date()),
        sa.column("night_start_hour"),
        sa.column("night_end_hour"),
        sa.column("night_surcharge_bp"),
        sa.column("sunday_holiday_surcharge_bp"),
        sa.column("overtime_surcharge_bp"),
        sa.column("night_overtime_surcharge_bp"),
        sa.column("weekly_ordinary_hours"),
        sa.column("created_at"),
        sa.column("created_by_employee_id"),
    )
    bind.execute(table.delete().where(table.c.created_by_employee_id.is_(None)))

    now = datetime.now(timezone.utc)
    stores = bind.execute(sa.text("SELECT id, organization_id FROM stores")).fetchall()
    for store_id, organization_id in stores:
        taken = {
            str(row[0])[:10]
            for row in bind.execute(
                sa.select(table.c.valid_from).where(table.c.store_id == store_id)
            ).fetchall()
        }
        for valid_from, night_start, sunday_bp, weekly in _CALENDAR:
            if valid_from in taken:
                continue
            bind.execute(
                table.insert().values(
                    organization_id=organization_id,
                    store_id=store_id,
                    valid_from=datetime.strptime(valid_from, "%Y-%m-%d").date(),
                    night_start_hour=night_start,
                    night_end_hour=6,
                    night_surcharge_bp=3500,
                    sunday_holiday_surcharge_bp=sunday_bp,
                    overtime_surcharge_bp=2500,
                    night_overtime_surcharge_bp=7500,
                    weekly_ordinary_hours=weekly,
                    created_at=now,
                )
            )


def downgrade() -> None:
    with op.batch_alter_table("payroll_surcharge_tables") as batch:
        batch.drop_constraint("ck_payroll_surcharge_night_ot_bp_nonneg", type_="check")
        batch.drop_column("night_overtime_surcharge_bp")
