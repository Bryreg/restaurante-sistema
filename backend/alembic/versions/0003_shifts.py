"""Turno de caja: día operativo, turno, roster, movimientos, cambios, retiros,
relevos y el conteo de cierre a ciegas.

DDL escrito a mano (Postgres-first), no autogenerado a ciegas
(`features/fase-1a-cimientos/CONTRATO-INTERNO.md §4`). El índice único parcial
`uq_shifts_one_open_per_store` defiende "un solo turno abierto por sede" tanto
en Postgres (`postgresql_where`) como en SQLite (`sqlite_where`).

Revision ID: 0003
Revises: 0002
Create Date: 2026-09-14
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from app.shifts.models import (
    BusinessDayStatus,
    CashDifferenceCause,
    CashMovementCause,
    CashMovementKind,
    HandoverKind,
    ShiftStatus,
)

# revision identifiers, used by Alembic.
revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def _enum(pyenum: type, *, length: int = 32) -> sa.Enum:
    return sa.Enum(pyenum, native_enum=False, length=length, validate_strings=True)


def upgrade() -> None:
    # -- business_days --------------------------------------------------
    op.create_table(
        "business_days",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("business_date", sa.Date(), nullable=False),
        sa.Column("status", _enum(BusinessDayStatus, length=16), nullable=False, server_default=BusinessDayStatus.OPEN.value),
        sa.Column("opened_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("store_id", "business_date", name="uq_business_days_store_date"),
    )
    op.create_index("ix_business_days_organization_id", "business_days", ["organization_id"])
    op.create_index("ix_business_days_store_id", "business_days", ["store_id"])
    op.create_index("ix_business_days_store_status", "business_days", ["store_id", "status"])

    # -- shifts -----------------------------------------------------------
    op.create_table(
        "shifts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("business_day_id", sa.Integer(), sa.ForeignKey("business_days.id"), nullable=False),
        sa.Column("status", _enum(ShiftStatus, length=16), nullable=False, server_default=ShiftStatus.OPEN.value),
        sa.Column("opened_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("opened_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("opened_by_employee_name", sa.String(200), nullable=False),
        sa.Column("cash_responsible_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("cash_responsible_name", sa.String(200), nullable=False),
        sa.Column("opening_cash_total", sa.Integer(), nullable=False),
        sa.Column("opening_denominations", sa.JSON(), nullable=False),
        sa.Column("cash_reserve", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("opening_cause", _enum(CashDifferenceCause), nullable=True),
        sa.Column("opening_note", sa.Text(), nullable=True),
        sa.Column("closes_day", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("closed_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("closed_by_employee_name", sa.String(200), nullable=True),
        sa.Column("closed_without_count", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("expected_cash", sa.Integer(), nullable=True),
        sa.Column("counted_cash", sa.Integer(), nullable=True),
        sa.Column("difference", sa.Integer(), nullable=True),
        sa.Column("close_cause", _enum(CashDifferenceCause), nullable=True),
        sa.Column("close_note", sa.Text(), nullable=True),
        sa.Column("to_deposit", sa.Integer(), nullable=True),
        sa.Column("reviewed_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("reviewed_by_employee_name", sa.String(200), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reopen_reason", sa.Text(), nullable=True),
        sa.Column("reopened_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reopened_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancelled_reason", sa.Text(), nullable=True),
        sa.Column("cancelled_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("adjustments", sa.JSON(), nullable=False, server_default="[]"),
        sa.CheckConstraint("opening_cash_total >= 0", name="ck_shifts_opening_cash_total_nonneg"),
    )
    op.create_index("ix_shifts_organization_id", "shifts", ["organization_id"])
    op.create_index("ix_shifts_store_id", "shifts", ["store_id"])
    op.create_index("ix_shifts_business_day", "shifts", ["business_day_id"])
    op.create_index("ix_shifts_cash_responsible_id", "shifts", ["cash_responsible_id"])
    op.create_index("ix_shifts_store_status", "shifts", ["store_id", "status"])
    op.create_index(
        "uq_shifts_one_open_per_store",
        "shifts",
        ["store_id"],
        unique=True,
        postgresql_where=sa.text("status = 'open'"),
        sqlite_where=sa.text("status = 'open'"),
    )

    # -- shift_roster -------------------------------------------------------
    op.create_table(
        "shift_roster",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("shift_id", sa.Integer(), sa.ForeignKey("shifts.id"), nullable=False),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("employee_name", sa.String(200), nullable=False),
        sa.Column("in_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("out_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("pauses", sa.JSON(), nullable=False, server_default="[]"),
    )
    op.create_index("ix_shift_roster_organization_id", "shift_roster", ["organization_id"])
    op.create_index("ix_shift_roster_store_id", "shift_roster", ["store_id"])
    op.create_index("ix_shift_roster_shift_id", "shift_roster", ["shift_id"])
    op.create_index("ix_shift_roster_employee_id", "shift_roster", ["employee_id"])
    op.create_index("ix_shift_roster_shift_employee", "shift_roster", ["shift_id", "employee_id"])

    # -- cash_movements -------------------------------------------------
    op.create_table(
        "cash_movements",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("shift_id", sa.Integer(), sa.ForeignKey("shifts.id"), nullable=False),
        sa.Column("kind", _enum(CashMovementKind, length=16), nullable=False),
        sa.Column("cause", _enum(CashMovementCause), nullable=False),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("receipt_photo", sa.String(500), nullable=True),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("employee_name", sa.String(200), nullable=False),
        sa.Column("authorized_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("authorized_by_employee_name", sa.String(200), nullable=True),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("amount > 0", name="ck_cash_movements_amount_positive"),
    )
    op.create_index("ix_cash_movements_organization_id", "cash_movements", ["organization_id"])
    op.create_index("ix_cash_movements_store_id", "cash_movements", ["store_id"])
    op.create_index("ix_cash_movements_shift_id", "cash_movements", ["shift_id"])
    op.create_index("ix_cash_movements_shift_at", "cash_movements", ["shift_id", "at"])

    # -- cash_swaps -------------------------------------------------------
    op.create_table(
        "cash_swaps",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("shift_id", sa.Integer(), sa.ForeignKey("shifts.id"), nullable=False),
        sa.Column("out_denominations", sa.JSON(), nullable=False),
        sa.Column("in_denominations", sa.JSON(), nullable=False),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("employee_name", sa.String(200), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("amount >= 0", name="ck_cash_swaps_amount_nonneg"),
    )
    op.create_index("ix_cash_swaps_organization_id", "cash_swaps", ["organization_id"])
    op.create_index("ix_cash_swaps_store_id", "cash_swaps", ["store_id"])
    op.create_index("ix_cash_swaps_shift_id", "cash_swaps", ["shift_id"])
    op.create_index("ix_cash_swaps_shift_at", "cash_swaps", ["shift_id", "at"])

    # -- cash_pickups -----------------------------------------------------
    op.create_table(
        "cash_pickups",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("shift_id", sa.Integer(), sa.ForeignKey("shifts.id"), nullable=False),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("denominations", sa.JSON(), nullable=True),
        sa.Column("envelope_ref", sa.String(120), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("photo", sa.String(500), nullable=True),
        sa.Column("expected_at_pickup", sa.Integer(), nullable=False),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("employee_name", sa.String(200), nullable=False),
        sa.Column("authorized_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("authorized_by_employee_name", sa.String(200), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reversed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reversed_reason", sa.Text(), nullable=True),
        sa.Column("reversed_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("reversed_by_employee_name", sa.String(200), nullable=True),
        sa.CheckConstraint("amount > 0", name="ck_cash_pickups_amount_positive"),
    )
    op.create_index("ix_cash_pickups_organization_id", "cash_pickups", ["organization_id"])
    op.create_index("ix_cash_pickups_store_id", "cash_pickups", ["store_id"])
    op.create_index("ix_cash_pickups_shift_id", "cash_pickups", ["shift_id"])
    op.create_index("ix_cash_pickups_shift_at", "cash_pickups", ["shift_id", "at"])

    # -- shift_handovers --------------------------------------------------
    op.create_table(
        "shift_handovers",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("shift_id", sa.Integer(), sa.ForeignKey("shifts.id"), nullable=False),
        sa.Column("kind", _enum(HandoverKind, length=16), nullable=False),
        sa.Column("counted_cash", sa.Integer(), nullable=False),
        sa.Column("counted_cash_denominations", sa.JSON(), nullable=False),
        sa.Column("counted_card", sa.Integer(), nullable=True),
        sa.Column("counted_transfer", sa.Integer(), nullable=True),
        sa.Column("breakdown", sa.JSON(), nullable=False),
        sa.Column("from_responsible_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("from_responsible_name", sa.String(200), nullable=False),
        sa.Column("new_responsible_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("new_responsible_name", sa.String(200), nullable=True),
        sa.Column("authorized_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("authorized_by_employee_name", sa.String(200), nullable=True),
        sa.Column("photo", sa.String(500), nullable=True),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_shift_handovers_organization_id", "shift_handovers", ["organization_id"])
    op.create_index("ix_shift_handovers_store_id", "shift_handovers", ["store_id"])
    op.create_index("ix_shift_handovers_shift_id", "shift_handovers", ["shift_id"])
    op.create_index("ix_shift_handovers_shift_at", "shift_handovers", ["shift_id", "at"])

    # -- shift_close_counts -----------------------------------------------
    op.create_table(
        "shift_close_counts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("shift_id", sa.Integer(), sa.ForeignKey("shifts.id"), nullable=False),
        sa.Column("counted_cash_total", sa.Integer(), nullable=False),
        sa.Column("counted_cash_denominations", sa.JSON(), nullable=False),
        sa.Column("counted_card", sa.Integer(), nullable=True),
        sa.Column("counted_transfer", sa.Integer(), nullable=True),
        sa.Column("tips_cash_out", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("photo", sa.String(500), nullable=True),
        sa.Column("created_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("created_by_employee_name", sa.String(200), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("superseded", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.CheckConstraint("counted_cash_total >= 0", name="ck_close_counts_cash_nonneg"),
        sa.CheckConstraint("tips_cash_out >= 0", name="ck_close_counts_tips_nonneg"),
    )
    op.create_index("ix_shift_close_counts_organization_id", "shift_close_counts", ["organization_id"])
    op.create_index("ix_shift_close_counts_store_id", "shift_close_counts", ["store_id"])
    op.create_index("ix_shift_close_counts_shift", "shift_close_counts", ["shift_id"])


def downgrade() -> None:
    op.drop_table("shift_close_counts")
    op.drop_table("shift_handovers")
    op.drop_table("cash_pickups")
    op.drop_table("cash_swaps")
    op.drop_table("cash_movements")
    op.drop_table("shift_roster")
    op.drop_index("uq_shifts_one_open_per_store", table_name="shifts")
    op.drop_table("shifts")
    op.drop_table("business_days")
