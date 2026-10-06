"""Obligaciones recurrentes, abonos y agenda de vencimientos (c5).

- `obligation_templates`: la plantilla de una obligación que se repite
  (mensual, bimestral o cada N meses). «Armar el mes» genera sus copias a
  pedido; nada se crea solo.
- `obligation_payments`: varios abonos por obligación, cada uno con de dónde
  salió la plata. Las obligaciones ya pagadas antes de esta migración ganan
  UN abono por su monto entero, con la fuente, el egreso del cajón y la
  persona que ya tenían: el estado derivado de los abonos dice lo mismo que
  decía la columna.
- `store_obligation_settings`: el día del mes en que se agenda el INC del
  bimestre (por sede; `NULL` = el de fábrica).
- `obligations` gana de dónde nació: `template_id` + `period_month` (único:
  la llave de idempotencia de «armar el mes»), `payroll_run_id` (único entre
  las vivas) y `tax_year` + `tax_bimester` (único por sede entre las vivas).

Tres tablas nuevas: 123 → 126.

**Encadenada provisoriamente detrás de `0044`**: `0045` y `0046` se escriben
en paralelo y no existen en este árbol. Al integrar, `down_revision` pasa a
`"0046"`.

Revision ID: 0047
Revises: 0045
"""

from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import sqlalchemy as sa
from alembic import op

revision: str = "0047"
down_revision = "0045"
branch_labels: str | None = None
depends_on: str | None = None

_BOGOTA = ZoneInfo("America/Bogota")


def upgrade() -> None:
    op.create_table(
        "obligation_templates",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False, index=True),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False, index=True),
        sa.Column("category", sa.String(32), nullable=False),
        sa.Column("description", sa.String(300), nullable=False),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("interval_months", sa.Integer(), nullable=False),
        sa.Column("due_day", sa.Integer(), nullable=False),
        sa.Column("start_month", sa.Date(), nullable=False),
        sa.Column("created_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("created_by_employee_name", sa.String(200), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deactivated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deactivated_reason", sa.Text(), nullable=True),
        sa.Column("deactivated_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("deactivated_by_employee_name", sa.String(200), nullable=True),
        sa.CheckConstraint("amount > 0", name="ck_obligation_templates_amount_positive"),
        sa.CheckConstraint("interval_months >= 1 AND interval_months <= 12", name="ck_obligation_templates_interval"),
        sa.CheckConstraint("due_day >= 1 AND due_day <= 31", name="ck_obligation_templates_due_day"),
    )

    op.add_column("obligations", sa.Column("template_id", sa.Integer(), nullable=True))
    op.add_column("obligations", sa.Column("period_month", sa.Date(), nullable=True))
    op.add_column("obligations", sa.Column("payroll_run_id", sa.Integer(), nullable=True))
    op.add_column("obligations", sa.Column("tax_year", sa.Integer(), nullable=True))
    op.add_column("obligations", sa.Column("tax_bimester", sa.Integer(), nullable=True))
    if op.get_bind().dialect.name != "sqlite":
        op.create_foreign_key(
            "fk_obligations_template", "obligations", "obligation_templates", ["template_id"], ["id"]
        )
        op.create_foreign_key("fk_obligations_payroll_run", "obligations", "payroll_runs", ["payroll_run_id"], ["id"])
        op.create_check_constraint(
            "ck_obligations_tax_bimester",
            "obligations",
            "tax_bimester IS NULL OR (tax_bimester >= 1 AND tax_bimester <= 6)",
        )
    op.create_index(
        "uq_obligations_template_period", "obligations", ["template_id", "period_month"], unique=True
    )
    op.create_index(
        "uq_obligations_live_tax_bimester",
        "obligations",
        ["store_id", "tax_year", "tax_bimester"],
        unique=True,
        postgresql_where=sa.text("cancelled_at IS NULL AND tax_year IS NOT NULL"),
        sqlite_where=sa.text("cancelled_at IS NULL AND tax_year IS NOT NULL"),
    )
    op.create_index(
        "uq_obligations_live_payroll_run",
        "obligations",
        ["payroll_run_id"],
        unique=True,
        postgresql_where=sa.text("cancelled_at IS NULL AND payroll_run_id IS NOT NULL"),
        sqlite_where=sa.text("cancelled_at IS NULL AND payroll_run_id IS NOT NULL"),
    )

    payments = op.create_table(
        "obligation_payments",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False, index=True),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False, index=True),
        sa.Column("obligation_id", sa.Integer(), sa.ForeignKey("obligations.id"), nullable=False, index=True),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("paid_on", sa.Date(), nullable=False),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("cash_movement_id", sa.Integer(), sa.ForeignKey("cash_movements.id"), nullable=True),
        sa.Column("note", sa.String(300), nullable=True),
        sa.Column("created_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("created_by_employee_name", sa.String(200), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("voided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("voided_reason", sa.Text(), nullable=True),
        sa.Column("voided_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("voided_by_employee_name", sa.String(200), nullable=True),
        sa.CheckConstraint("amount > 0", name="ck_obligation_payments_amount_positive"),
    )
    op.create_index(
        "uq_obligation_payments_live_cash_movement",
        "obligation_payments",
        ["cash_movement_id"],
        unique=True,
        postgresql_where=sa.text("voided_at IS NULL AND cash_movement_id IS NOT NULL"),
        sqlite_where=sa.text("voided_at IS NULL AND cash_movement_id IS NOT NULL"),
    )

    op.create_table(
        "store_obligation_settings",
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), primary_key=True),
        sa.Column("consumption_tax_due_day", sa.Integer(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("updated_by_employee_name", sa.String(200), nullable=True),
        sa.CheckConstraint(
            "consumption_tax_due_day IS NULL OR (consumption_tax_due_day >= 1 AND consumption_tax_due_day <= 28)",
            name="ck_store_obligation_settings_due_day",
        ),
    )

    _backfill_payments_of_paid_obligations(payments)


def _as_utc(value: object) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, str):
        value = datetime.fromisoformat(value)
    assert isinstance(value, datetime)
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _backfill_payments_of_paid_obligations(payments: sa.Table) -> None:
    """Una obligación pagada antes de los abonos queda con UN abono por su
    monto entero: la misma fuente, el mismo egreso del cajón, la misma
    persona y la fecha (de Bogotá) en que se saldó. Sin esto su estado
    derivado volvería a «pendiente»."""
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            "SELECT id, organization_id, store_id, amount, settled_at, settled_source, cash_movement_id, "
            "settled_by_employee_id, settled_by_employee_name, created_by_employee_id, created_by_employee_name, "
            "created_at FROM obligations WHERE status = 'paid'"
        )
    ).mappings().all()
    if not rows:
        return
    values = []
    for row in rows:
        settled_at = _as_utc(row["settled_at"]) or _as_utc(row["created_at"])
        assert settled_at is not None
        values.append(
            {
                "organization_id": row["organization_id"],
                "store_id": row["store_id"],
                "obligation_id": row["id"],
                "amount": row["amount"],
                "paid_on": settled_at.astimezone(_BOGOTA).date(),
                "source": row["settled_source"] or "other",
                "cash_movement_id": row["cash_movement_id"],
                "note": None,
                "created_by_employee_id": row["settled_by_employee_id"] or row["created_by_employee_id"],
                "created_by_employee_name": row["settled_by_employee_name"] or row["created_by_employee_name"],
                "created_at": settled_at,
            }
        )
    op.bulk_insert(payments, values)


def downgrade() -> None:
    op.drop_table("store_obligation_settings")
    op.drop_index("uq_obligation_payments_live_cash_movement", table_name="obligation_payments")
    op.drop_table("obligation_payments")
    op.drop_index("uq_obligations_live_payroll_run", table_name="obligations")
    op.drop_index("uq_obligations_live_tax_bimester", table_name="obligations")
    op.drop_index("uq_obligations_template_period", table_name="obligations")
    # Lo que era `partial` vuelve a `pending`: antes de los abonos no existía.
    op.execute("UPDATE obligations SET status = 'pending' WHERE status = 'partial'")
    if op.get_bind().dialect.name == "sqlite":
        with op.batch_alter_table("obligations") as batch_op:
            for column in ("tax_bimester", "tax_year", "payroll_run_id", "period_month", "template_id"):
                batch_op.drop_column(column)
    else:
        op.drop_constraint("ck_obligations_tax_bimester", "obligations", type_="check")
        op.drop_constraint("fk_obligations_payroll_run", "obligations", type_="foreignkey")
        op.drop_constraint("fk_obligations_template", "obligations", type_="foreignkey")
        for column in ("tax_bimester", "tax_year", "payroll_run_id", "period_month", "template_id"):
            op.drop_column("obligations", column)
    op.drop_table("obligation_templates")
