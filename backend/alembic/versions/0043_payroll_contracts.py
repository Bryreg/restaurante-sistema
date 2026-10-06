"""Contrato, novedades de nómina y parámetros legales (auditoría e2/e3).

- `payroll_contracts`: contrato de cada persona (tipo, sueldo fijo o por
  hora, inicio/fin, clase de riesgo ARL). Una fila por versión.
- `payroll_absences`: incapacidades, licencias, vacaciones, permisos y
  suspensiones; se anulan con motivo, nunca se borran.
- `payroll_legal_params`: salario mínimo, auxilio de transporte y tasas de
  aportes y prestaciones que la organización carga o confirma (los valores
  del decreto viven en `app/payroll/legal_costs.py`).
- `payroll_run_lines`: novedades, auxilio de transporte, recobros, aportes,
  provisión de prestaciones y costo del empleador por persona.
- `payroll_runs.employer_total_amount`.

Tres tablas nuevas: 118 → 121.

Revision ID: 0043
Revises: 0042
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0043"
down_revision = "0042"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.create_table(
        "payroll_legal_params",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False, index=True),
        sa.Column("valid_from", sa.Date(), nullable=False),
        sa.Column("smmlv_pesos", sa.Integer(), nullable=False),
        sa.Column("transport_allowance_pesos", sa.Integer(), nullable=False),
        sa.Column("health_employer_ppm", sa.Integer(), nullable=False),
        sa.Column("pension_employer_ppm", sa.Integer(), nullable=False),
        sa.Column("family_fund_ppm", sa.Integer(), nullable=False),
        sa.Column("icbf_ppm", sa.Integer(), nullable=False),
        sa.Column("sena_ppm", sa.Integer(), nullable=False),
        sa.Column("severance_ppm", sa.Integer(), nullable=False),
        sa.Column("severance_interest_ppm", sa.Integer(), nullable=False),
        sa.Column("service_bonus_ppm", sa.Integer(), nullable=False),
        sa.Column("vacation_ppm", sa.Integer(), nullable=False),
        sa.Column("exonerated_114_1", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("created_by_employee_name", sa.String(200), nullable=True),
        sa.UniqueConstraint("organization_id", "valid_from", name="uq_payroll_legal_params_org_valid_from"),
    )
    op.create_table(
        "payroll_contracts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False, index=True),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False, index=True),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False, index=True),
        sa.Column("employee_name", sa.String(200), nullable=False),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("salary_type", sa.String(32), nullable=False),
        sa.Column("monthly_salary_pesos", sa.Integer(), nullable=True),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("end_date", sa.Date(), nullable=True),
        sa.Column("arl_risk_class", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("created_by_employee_name", sa.String(200), nullable=True),
        sa.CheckConstraint("arl_risk_class BETWEEN 1 AND 5", name="ck_payroll_contract_arl_class"),
        sa.CheckConstraint(
            "monthly_salary_pesos IS NULL OR monthly_salary_pesos > 0", name="ck_payroll_contract_salary_pos"
        ),
        sa.CheckConstraint("end_date IS NULL OR end_date >= start_date", name="ck_payroll_contract_range"),
    )
    op.create_index("ix_payroll_contracts_employee_start", "payroll_contracts", ["employee_id", "start_date"])
    op.create_table(
        "payroll_absences",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False, index=True),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False, index=True),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False, index=True),
        sa.Column("employee_name", sa.String(200), nullable=False),
        sa.Column("kind", sa.String(24), nullable=False),
        sa.Column("date_from", sa.Date(), nullable=False),
        sa.Column("date_to", sa.Date(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("created_by_employee_name", sa.String(200), nullable=True),
        sa.Column("voided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("voided_by_employee_name", sa.String(200), nullable=True),
        sa.Column("void_reason", sa.Text(), nullable=True),
        sa.CheckConstraint("date_from <= date_to", name="ck_payroll_absence_range"),
    )
    op.create_index("ix_payroll_absences_employee_from", "payroll_absences", ["employee_id", "date_from"])
    for col in (
        "absence_days", "absence_pay", "transport_allowance", "recoverable",
        "employer_contributions", "benefits_provision", "employer_total",
    ):
        op.add_column("payroll_run_lines", sa.Column(col, sa.Integer(), nullable=True))
    op.add_column("payroll_runs", sa.Column("employer_total_amount", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("payroll_runs", "employer_total_amount")
    for col in (
        "employer_total", "benefits_provision", "employer_contributions", "recoverable",
        "transport_allowance", "absence_pay", "absence_days",
    ):
        op.drop_column("payroll_run_lines", col)
    op.drop_index("ix_payroll_absences_employee_from", table_name="payroll_absences")
    op.drop_table("payroll_absences")
    op.drop_index("ix_payroll_contracts_employee_start", table_name="payroll_contracts")
    op.drop_table("payroll_contracts")
    op.drop_table("payroll_legal_params")
