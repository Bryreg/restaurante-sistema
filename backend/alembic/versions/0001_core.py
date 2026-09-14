"""Cimientos: organización, sedes, identidad, auditoría y notificaciones.

Revision ID: 0001
Revises:
Create Date: 2026-09-14

DDL escrito a mano (Postgres-first), no autogenerado. Índices en toda FK y en
toda columna que un router filtra. Enums como `sa.Enum(..., native_enum=False)`
(VARCHAR portable, valor plano en Python — nada de comparar por identidad).
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # -- organizations ------------------------------------------------------
    op.create_table(
        "organizations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column(
            "profile",
            sa.Enum("basic", "standard", "full", name="organization_profile", native_enum=False, length=16),
            nullable=False,
            server_default="standard",
        ),
        sa.Column("declared_not_obliged_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("declared_not_obliged_by", sa.String(length=200), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )

    # -- stores --------------------------------------------------------------
    op.create_table(
        "stores",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False
        ),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("nit", sa.String(length=20), nullable=True),
        sa.Column("dv", sa.String(length=2), nullable=True),
        sa.Column("legal_name", sa.String(length=200), nullable=True),
        sa.Column("address", sa.String(length=300), nullable=True),
        sa.Column("municipality_dane", sa.String(length=6), nullable=True),
        sa.Column("opening_hours", sa.JSON(), nullable=False),
        sa.Column("cutoff_hour", sa.Integer(), nullable=False, server_default="6"),
        sa.Column("active_channels", sa.JSON(), nullable=False),
        sa.Column("store_pin_hash", sa.String(length=255), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_stores_organization_id", "stores", ["organization_id"])

    # -- store_fiscal_configs -------------------------------------------------
    op.create_table(
        "store_fiscal_configs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("valid_from", sa.Date(), nullable=False),
        sa.Column(
            "person_type",
            sa.Enum("natural", "legal", name="fiscal_person_type", native_enum=False, length=16),
            nullable=False,
        ),
        sa.Column(
            "regime",
            sa.Enum("ordinary", "simple", name="fiscal_regime", native_enum=False, length=16),
            nullable=False,
        ),
        sa.Column("franchise", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("inc_responsible", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("iva_responsible", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("rut_codes", sa.JSON(), nullable=False),
        sa.Column("price_includes_tax", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column(
            "default_tax",
            sa.Enum("inc_8", "iva_19", "excluded", name="tax_code", native_enum=False, length=16),
            nullable=False,
            server_default="inc_8",
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_store_fiscal_configs_store_id", "store_fiscal_configs", ["store_id"])
    op.create_index(
        "ix_store_fiscal_configs_store_valid_from", "store_fiscal_configs", ["store_id", "valid_from"]
    )

    # -- store_cash_settings ---------------------------------------------------
    op.create_table(
        "store_cash_settings",
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), primary_key=True),
        sa.Column("opening_cash_fixed", sa.Integer(), nullable=False, server_default="200000"),
        sa.Column("cash_reserve_default", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("tolerance_unknown_cause", sa.Integer(), nullable=False, server_default="20000"),
        sa.Column("tolerance_identified_cause", sa.Integer(), nullable=False, server_default="100000"),
        sa.Column("critical_difference", sa.Integer(), nullable=False, server_default="100000"),
        sa.Column("cash_pickup_threshold", sa.Integer(), nullable=False, server_default="500000"),
        sa.Column("petty_cash_limit", sa.Integer(), nullable=False, server_default="50000"),
        sa.Column("photo_required_on_close", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("photo_required_on_pickup", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("streak_alert_shifts", sa.Integer(), nullable=False, server_default="3"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )

    # -- store_sales_settings --------------------------------------------------
    op.create_table(
        "store_sales_settings",
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), primary_key=True),
        sa.Column("tip_suggested_pct", sa.Numeric(5, 2), nullable=False, server_default="10"),
        sa.Column("discount_limit_pct", sa.Numeric(5, 2), nullable=False, server_default="10"),
        sa.Column("discount_daily_limit_pct", sa.Numeric(5, 2), nullable=False, server_default="5"),
        sa.Column("courtesy_shift_limit", sa.Integer(), nullable=False, server_default="5"),
        sa.Column("payment_methods", sa.JSON(), nullable=False),
        sa.Column("void_reasons", sa.JSON(), nullable=False),
        sa.Column("discount_reasons", sa.JSON(), nullable=False),
        sa.Column("courtesy_reasons", sa.JSON(), nullable=False),
        sa.Column("courses", sa.JSON(), nullable=False),
        sa.Column("stations", sa.JSON(), nullable=False),
        sa.Column("course_target_minutes", sa.JSON(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )

    # -- uvt_values -----------------------------------------------------------
    op.create_table(
        "uvt_values",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False
        ),
        sa.Column("year", sa.Integer(), nullable=False),
        sa.Column("value", sa.Integer(), nullable=False),
        sa.UniqueConstraint("organization_id", "year", name="uq_uvt_values_org_year"),
    )
    op.create_index("ix_uvt_values_organization_id", "uvt_values", ["organization_id"])

    # -- zones / tables ---------------------------------------------------------
    op.create_table(
        "zones",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.create_index("ix_zones_store_id", "zones", ["store_id"])

    op.create_table(
        "tables",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("zone_id", sa.Integer(), sa.ForeignKey("zones.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("number", sa.String(length=20), nullable=False),
        sa.Column("seats", sa.Integer(), nullable=False, server_default="4"),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.create_index("ix_tables_zone_id", "tables", ["zone_id"])
    op.create_index("ix_tables_store_id", "tables", ["store_id"])

    # -- feature_states ---------------------------------------------------------
    op.create_table(
        "feature_states",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False
        ),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=True),
        sa.Column("key", sa.String(length=64), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_by", sa.String(length=200), nullable=True),
        sa.UniqueConstraint("organization_id", "store_id", "key", name="uq_feature_states_scope"),
    )
    op.create_index("ix_feature_states_organization_id", "feature_states", ["organization_id"])
    op.create_index("ix_feature_states_store_id", "feature_states", ["store_id"])

    # -- employees ---------------------------------------------------------------
    op.create_table(
        "employees",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False
        ),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=True),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column(
            "role",
            sa.Enum("operator", "supervisor", "admin", name="employee_role", native_enum=False, length=16),
            nullable=False,
        ),
        sa.Column("pin_hash", sa.String(length=255), nullable=False),
        sa.Column("email", sa.String(length=255), nullable=True),
        sa.Column("password_hash", sa.String(length=255), nullable=True),
        sa.Column("can_charge", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("discount_limit_pct", sa.Numeric(5, 2), nullable=True),
        sa.Column("document", sa.String(length=30), nullable=True),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("failed_pin_attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("pin_locked_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("email", name="uq_employees_email"),
    )
    op.create_index("ix_employees_organization_id", "employees", ["organization_id"])
    op.create_index("ix_employees_store_id", "employees", ["store_id"])

    # -- device_sessions -----------------------------------------------------------
    op.create_table(
        "device_sessions",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False
        ),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("device_name", sa.String(length=100), nullable=True),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("employee_bound_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("employee_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_device_sessions_organization_id", "device_sessions", ["organization_id"])
    op.create_index("ix_device_sessions_store_id", "device_sessions", ["store_id"])
    op.create_index("ix_device_sessions_employee_id", "device_sessions", ["employee_id"])

    # -- authorizations -----------------------------------------------------------
    op.create_table(
        "authorizations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False
        ),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("authorizer_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("authorizer_name", sa.String(length=200), nullable=False),
        sa.Column("action", sa.String(length=64), nullable=False),
        sa.Column(
            "requested_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True
        ),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reference_type", sa.String(length=64), nullable=True),
        sa.Column("reference_id", sa.String(length=64), nullable=True),
    )
    op.create_index("ix_authorizations_organization_id", "authorizations", ["organization_id"])
    op.create_index("ix_authorizations_store_id", "authorizations", ["store_id"])
    op.create_index("ix_authorizations_authorizer_id", "authorizations", ["authorizer_id"])
    op.create_index("ix_authorizations_at", "authorizations", ["at"])

    # -- audit_logs -----------------------------------------------------------------
    op.create_table(
        "audit_logs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False
        ),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=True),
        sa.Column("entity", sa.String(length=64), nullable=False),
        sa.Column("entity_id", sa.String(length=64), nullable=False),
        sa.Column("action", sa.String(length=64), nullable=False),
        sa.Column("before", sa.JSON(), nullable=True),
        sa.Column("after", sa.JSON(), nullable=True),
        sa.Column("reason", sa.String(length=500), nullable=True),
        sa.Column("actor_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=True),
        sa.Column("actor_employee_name", sa.String(length=200), nullable=True),
        sa.Column("actor_kind", sa.String(length=16), nullable=True),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_audit_logs_organization_id", "audit_logs", ["organization_id"])
    op.create_index("ix_audit_logs_store_id", "audit_logs", ["store_id"])
    op.create_index("ix_audit_logs_entity", "audit_logs", ["entity"])
    op.create_index("ix_audit_logs_at", "audit_logs", ["at"])

    # -- notifications / notification_rules -----------------------------------------
    op.create_table(
        "notifications",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False
        ),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("type", sa.String(length=64), nullable=False),
        sa.Column(
            "level",
            sa.Enum("info", "warning", "critical", name="notification_level", native_enum=False, length=16),
            nullable=False,
        ),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("body", sa.String(length=1000), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=True),
        sa.Column("dedupe_key", sa.String(length=200), nullable=True),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_notifications_organization_id", "notifications", ["organization_id"])
    op.create_index("ix_notifications_store_id", "notifications", ["store_id"])
    op.create_index("ix_notifications_type", "notifications", ["type"])
    op.create_index("ix_notifications_dedupe_key", "notifications", ["dedupe_key"])
    op.create_index("ix_notifications_created_at", "notifications", ["created_at"])

    op.create_table(
        "notification_rules",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False
        ),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("type", sa.String(length=64), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("threshold", sa.Integer(), nullable=True),
        sa.Column(
            "level",
            sa.Enum(
                "info", "warning", "critical", name="notification_level_rule", native_enum=False, length=16
            ),
            nullable=False,
            server_default="warning",
        ),
        sa.UniqueConstraint("store_id", "type", name="uq_notification_rules_store_type"),
    )
    op.create_index("ix_notification_rules_organization_id", "notification_rules", ["organization_id"])
    op.create_index("ix_notification_rules_store_id", "notification_rules", ["store_id"])

    # -- idempotency_keys -------------------------------------------------------------
    op.create_table(
        "idempotency_keys",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False
        ),
        sa.Column("scope", sa.String(length=64), nullable=False),
        sa.Column("key", sa.String(length=128), nullable=False),
        sa.Column("request_hash", sa.String(length=64), nullable=False),
        sa.Column("response_status", sa.Integer(), nullable=True),
        sa.Column("response_body", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("organization_id", "scope", "key", name="uq_idempotency_keys_scope_key"),
    )
    op.create_index("ix_idempotency_keys_organization_id", "idempotency_keys", ["organization_id"])


def downgrade() -> None:
    op.drop_table("idempotency_keys")
    op.drop_table("notification_rules")
    op.drop_table("notifications")
    op.drop_table("audit_logs")
    op.drop_table("authorizations")
    op.drop_table("device_sessions")
    op.drop_table("employees")
    op.drop_table("feature_states")
    op.drop_table("tables")
    op.drop_table("zones")
    op.drop_table("uvt_values")
    op.drop_table("store_sales_settings")
    op.drop_table("store_cash_settings")
    op.drop_table("store_fiscal_configs")
    op.drop_table("stores")
    op.drop_table("organizations")
