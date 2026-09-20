"""Jornada, tablas de recargos con vigencia, liquidación de nómina y
configuración del reparto de propinas (fase 3, `backend-nomina-propinas`,
T3): `payroll_surcharge_tables`, `payroll_holidays`, `payroll_wage_rates`,
`payroll_area_assignments`, `payroll_tip_distribution_settings`,
`payroll_runs`, `payroll_run_lines`.

DDL escrito a mano (Postgres-first), como `0011_purchases.py`/
`0018_expenses.py`: un índice por FK y por filtro de pantalla,
`CheckConstraint` para las mismas reglas que valida el modelo. Sin
`batch_alter_table` — son tablas nuevas, no hay columna existente que tocar.
Los `_enum(...)` de acá son `VARCHAR` planos en los dos motores
(`native_enum=False`, sin `create_constraint`): no hay ningún `CHECK` que un
`downgrade` necesite recrear.

**Backfill, en la misma migración** (`docs/CONTEXTO-AGENTES.md §12`): cada
sede que ya existe recibe, de una vez, la secuencia de vigencias de
`payroll_surcharge_tables` que reconstruye los tres cambios legales que
`features/fase-3-dinero-control/spec.md § 2` cita explícitamente — ventana
nocturna 19:00-06:00 desde dic-2025, recargo dominical/festivo 80/90/100 %
en 2025/2026/2027 (Ley 2466 de 2025), jornada ordinaria semanal 42 h desde
jul-2026 (Ley 2101 de 2021) — más una vigencia "desde siempre" con los
valores previos a esos tres cambios. **Los valores previos (ventana
21:00-06:00, recargo dominical/festivo 75 %, jornada 46 h, recargo nocturno
35 % y recargo de hora extra 25 % en todas las vigencias) son un SUPUESTO
razonable, no una cita textual del pedido** — declarado como tal en
`outputs/backend-nomina-propinas.md § gaps`: sin backfill, una sede que ya
existe no podría liquidar ningún período anterior a la primera vigencia que
un administrador cargue a mano, y `POST /admin/payroll/runs`/`GET
/admin/payroll/hours` responden `SURCHARGE_TABLE_MISSING`/`available:false`
hasta que alguien lo haga — peor que sembrar un punto de partida editable.

Revision ID: 0020
Revises: 0019
Create Date: 2026-09-20
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime, timezone

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0020"
down_revision: str | None = "0019"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def _enum(pyenum: type, *, length: int = 32) -> sa.Enum:
    return sa.Enum(pyenum, native_enum=False, length=length, validate_strings=True)


# Vigencias sembradas por sede (ver el docstring del módulo). `bp` en puntos
# básicos (1 % = 100).
_SEED_VIGENCIAS: list[dict[str, object]] = [
    {
        "valid_from": "2020-01-01",
        "night_start_hour": 21,
        "night_end_hour": 6,
        "night_surcharge_bp": 3500,
        "sunday_holiday_surcharge_bp": 7500,
        "overtime_surcharge_bp": 2500,
        "weekly_ordinary_hours": 46,
    },
    {
        "valid_from": "2025-01-01",
        "night_start_hour": 21,
        "night_end_hour": 6,
        "night_surcharge_bp": 3500,
        "sunday_holiday_surcharge_bp": 8000,
        "overtime_surcharge_bp": 2500,
        "weekly_ordinary_hours": 46,
    },
    {
        "valid_from": "2025-12-01",
        "night_start_hour": 19,
        "night_end_hour": 6,
        "night_surcharge_bp": 3500,
        "sunday_holiday_surcharge_bp": 8000,
        "overtime_surcharge_bp": 2500,
        "weekly_ordinary_hours": 46,
    },
    {
        "valid_from": "2026-01-01",
        "night_start_hour": 19,
        "night_end_hour": 6,
        "night_surcharge_bp": 3500,
        "sunday_holiday_surcharge_bp": 9000,
        "overtime_surcharge_bp": 2500,
        "weekly_ordinary_hours": 46,
    },
    {
        "valid_from": "2026-07-01",
        "night_start_hour": 19,
        "night_end_hour": 6,
        "night_surcharge_bp": 3500,
        "sunday_holiday_surcharge_bp": 9000,
        "overtime_surcharge_bp": 2500,
        "weekly_ordinary_hours": 42,
    },
    {
        "valid_from": "2027-01-01",
        "night_start_hour": 19,
        "night_end_hour": 6,
        "night_surcharge_bp": 3500,
        "sunday_holiday_surcharge_bp": 10000,
        "overtime_surcharge_bp": 2500,
        "weekly_ordinary_hours": 42,
    },
]


def upgrade() -> None:
    # -- payroll_surcharge_tables --------------------------------------
    op.create_table(
        "payroll_surcharge_tables",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("valid_from", sa.Date(), nullable=False),
        sa.Column("night_start_hour", sa.Integer(), nullable=False),
        sa.Column("night_end_hour", sa.Integer(), nullable=False),
        sa.Column("night_surcharge_bp", sa.Integer(), nullable=False),
        sa.Column("sunday_holiday_surcharge_bp", sa.Integer(), nullable=False),
        sa.Column("overtime_surcharge_bp", sa.Integer(), nullable=False),
        sa.Column("weekly_ordinary_hours", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("created_by_employee_name", sa.String(200), nullable=True),
        sa.UniqueConstraint("store_id", "valid_from", name="uq_payroll_surcharge_store_valid_from"),
        sa.CheckConstraint("night_start_hour BETWEEN 0 AND 23", name="ck_payroll_surcharge_night_start_range"),
        sa.CheckConstraint("night_end_hour BETWEEN 0 AND 23", name="ck_payroll_surcharge_night_end_range"),
        sa.CheckConstraint("night_surcharge_bp >= 0", name="ck_payroll_surcharge_night_bp_nonneg"),
        sa.CheckConstraint("sunday_holiday_surcharge_bp >= 0", name="ck_payroll_surcharge_sunday_bp_nonneg"),
        sa.CheckConstraint("overtime_surcharge_bp >= 0", name="ck_payroll_surcharge_overtime_bp_nonneg"),
        sa.CheckConstraint("weekly_ordinary_hours > 0", name="ck_payroll_surcharge_weekly_hours_positive"),
    )
    op.create_index("ix_payroll_surcharge_organization_id", "payroll_surcharge_tables", ["organization_id"])
    op.create_index("ix_payroll_surcharge_store_id", "payroll_surcharge_tables", ["store_id"])
    op.create_index(
        "ix_payroll_surcharge_store_valid_from", "payroll_surcharge_tables", ["store_id", "valid_from"]
    )

    # -- payroll_holidays -------------------------------------------------
    op.create_table(
        "payroll_holidays",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("holiday_date", sa.Date(), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("store_id", "holiday_date", name="uq_payroll_holiday_store_date"),
    )
    op.create_index("ix_payroll_holidays_organization_id", "payroll_holidays", ["organization_id"])
    op.create_index("ix_payroll_holidays_store_id", "payroll_holidays", ["store_id"])

    # -- payroll_wage_rates -------------------------------------------------
    op.create_table(
        "payroll_wage_rates",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("employee_name", sa.String(200), nullable=False),
        sa.Column("hourly_wage_pesos", sa.Integer(), nullable=False),
        sa.Column("valid_from", sa.Date(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("created_by_employee_name", sa.String(200), nullable=True),
        sa.UniqueConstraint(
            "store_id", "employee_id", "valid_from", name="uq_payroll_wage_employee_valid_from"
        ),
        sa.CheckConstraint("hourly_wage_pesos > 0", name="ck_payroll_wage_positive"),
    )
    op.create_index("ix_payroll_wage_organization_id", "payroll_wage_rates", ["organization_id"])
    op.create_index("ix_payroll_wage_store_id", "payroll_wage_rates", ["store_id"])
    op.create_index("ix_payroll_wage_employee_id", "payroll_wage_rates", ["employee_id"])
    op.create_index("ix_payroll_wage_store_employee", "payroll_wage_rates", ["store_id", "employee_id"])

    # -- payroll_area_assignments --------------------------------------------
    op.create_table(
        "payroll_area_assignments",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("employee_name", sa.String(200), nullable=False),
        sa.Column("area", sa.String(100), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.UniqueConstraint("store_id", "employee_id", name="uq_payroll_area_store_employee"),
    )
    op.create_index("ix_payroll_area_organization_id", "payroll_area_assignments", ["organization_id"])
    op.create_index("ix_payroll_area_store_id", "payroll_area_assignments", ["store_id"])
    op.create_index("ix_payroll_area_employee_id", "payroll_area_assignments", ["employee_id"])

    # -- payroll_tip_distribution_settings -----------------------------------
    op.create_table(
        "payroll_tip_distribution_settings",
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), primary_key=True),
        sa.Column("method", sa.String(16), nullable=False, server_default="by_hours"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
    )

    # -- payroll_runs ---------------------------------------------------------
    op.create_table(
        "payroll_runs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("date_from", sa.Date(), nullable=False),
        sa.Column("date_to", sa.Date(), nullable=False),
        sa.Column("tables_used", sa.JSON(), nullable=False),
        sa.Column("total_amount", sa.Integer(), nullable=True),
        sa.Column("all_available", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("computed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("computed_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("computed_by_employee_name", sa.String(200), nullable=True),
        sa.CheckConstraint("date_from <= date_to", name="ck_payroll_run_range"),
        sa.CheckConstraint("total_amount IS NULL OR total_amount >= 0", name="ck_payroll_run_total_nonneg"),
    )
    op.create_index("ix_payroll_run_organization_id", "payroll_runs", ["organization_id"])
    op.create_index("ix_payroll_run_store_id", "payroll_runs", ["store_id"])
    op.create_index("ix_payroll_run_store_range", "payroll_runs", ["store_id", "date_from", "date_to"])

    # -- payroll_run_lines ----------------------------------------------------
    op.create_table(
        "payroll_run_lines",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("run_id", sa.Integer(), sa.ForeignKey("payroll_runs.id"), nullable=False),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("employee_name", sa.String(200), nullable=False),
        sa.Column("ordinary_minutes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("night_minutes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("sunday_minutes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("holiday_minutes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("overtime_minutes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("base_pay", sa.Integer(), nullable=True),
        sa.Column("night_surcharge", sa.Integer(), nullable=True),
        sa.Column("sunday_holiday_surcharge", sa.Integer(), nullable=True),
        sa.Column("overtime_pay", sa.Integer(), nullable=True),
        sa.Column("total", sa.Integer(), nullable=True),
        sa.Column("pay_reason", sa.Text(), nullable=True),
        sa.CheckConstraint("ordinary_minutes >= 0", name="ck_payroll_line_ordinary_nonneg"),
        sa.CheckConstraint("night_minutes >= 0", name="ck_payroll_line_night_nonneg"),
        sa.CheckConstraint("sunday_minutes >= 0", name="ck_payroll_line_sunday_nonneg"),
        sa.CheckConstraint("holiday_minutes >= 0", name="ck_payroll_line_holiday_nonneg"),
        sa.CheckConstraint("overtime_minutes >= 0", name="ck_payroll_line_overtime_nonneg"),
        sa.CheckConstraint("total IS NULL OR total >= 0", name="ck_payroll_line_total_nonneg"),
    )
    op.create_index("ix_payroll_run_lines_run_id", "payroll_run_lines", ["run_id"])
    op.create_index("ix_payroll_run_lines_employee_id", "payroll_run_lines", ["employee_id"])
    op.create_index("ix_payroll_run_lines_run_employee", "payroll_run_lines", ["run_id", "employee_id"])

    # -- Backfill: vigencias de recargos para cada sede que ya existe -------
    bind = op.get_bind()
    now = datetime.now(timezone.utc).isoformat()
    stores = bind.execute(sa.text("SELECT id, organization_id FROM stores")).fetchall()
    surcharge_table = sa.table(
        "payroll_surcharge_tables",
        sa.column("organization_id"),
        sa.column("store_id"),
        sa.column("valid_from"),
        sa.column("night_start_hour"),
        sa.column("night_end_hour"),
        sa.column("night_surcharge_bp"),
        sa.column("sunday_holiday_surcharge_bp"),
        sa.column("overtime_surcharge_bp"),
        sa.column("weekly_ordinary_hours"),
        sa.column("created_at"),
    )
    for store_id, organization_id in stores:
        for seed in _SEED_VIGENCIAS:
            bind.execute(
                surcharge_table.insert().values(
                    organization_id=organization_id,
                    store_id=store_id,
                    valid_from=seed["valid_from"],
                    night_start_hour=seed["night_start_hour"],
                    night_end_hour=seed["night_end_hour"],
                    night_surcharge_bp=seed["night_surcharge_bp"],
                    sunday_holiday_surcharge_bp=seed["sunday_holiday_surcharge_bp"],
                    overtime_surcharge_bp=seed["overtime_surcharge_bp"],
                    weekly_ordinary_hours=seed["weekly_ordinary_hours"],
                    created_at=now,
                )
            )


def downgrade() -> None:
    op.drop_table("payroll_run_lines")
    op.drop_table("payroll_runs")
    op.drop_table("payroll_tip_distribution_settings")
    op.drop_table("payroll_area_assignments")
    op.drop_table("payroll_wage_rates")
    op.drop_table("payroll_holidays")
    op.drop_table("payroll_surcharge_tables")
