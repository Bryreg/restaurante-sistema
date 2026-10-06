"""Seguridad de la cuenta de administrador (auditoría e5).

- `employees.totp_secret`, `totp_pending_secret`, `totp_enabled_at`:
  verificación en dos pasos con app de autenticación.
- `auth_login_attempts`: cada intento de ingreso, para el límite de
  intentos (5 fallidos por correo, 30 por IP, 15 minutos).
- `auth_recovery_codes`: códigos de recuperación de un solo uso (con hash).

Dos tablas nuevas: 121 → 123.

Revision ID: 0044
Revises: 0043
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0044"
down_revision = "0043"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column("employees", sa.Column("totp_secret", sa.String(64), nullable=True))
    op.add_column("employees", sa.Column("totp_pending_secret", sa.String(64), nullable=True))
    op.add_column("employees", sa.Column("totp_enabled_at", sa.DateTime(timezone=True), nullable=True))
    op.create_table(
        "auth_login_attempts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("email", sa.String(255), nullable=False, index=True),
        sa.Column("ip", sa.String(64), nullable=True, index=True),
        sa.Column("success", sa.Boolean(), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False, index=True),
    )
    op.create_table(
        "auth_recovery_codes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False, index=True),
        sa.Column("code_hash", sa.String(255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("auth_recovery_codes")
    op.drop_table("auth_login_attempts")
    op.drop_column("employees", "totp_enabled_at")
    op.drop_column("employees", "totp_pending_secret")
    op.drop_column("employees", "totp_secret")
