"""Avisos al celular (Web Push, función `notifications.push`).

La función estaba en el catálogo pero nada la entregaba. Esta migración pone
lo que falta en la base:

- `push_subscriptions`: cada celular (o navegador) de una persona que recibe
  los avisos graves — endpoint del servicio de push, las dos claves del
  navegador (`p256dh`, `auth`), la clave pública VAPID con la que se
  suscribió, el user agent y cuándo. **Nunca se borra**: «Quitar», un
  404/410 del servicio de push o un cambio de clave la dan de baja con
  `revoked_at` y `revoked_reason`. Un índice único parcial deja activo un
  solo registro por endpoint (dos «Activar» a la vez no duplican avisos).
- `push_vapid_keys`: el par de claves VAPID de cada organización, generado
  una vez cuando no vienen por entorno. La privada no sale por ninguna
  respuesta.
- `notifications.pushed_at`: cuándo salió al celular una notificación (lo
  usa el anti-repetición de 30 minutos y dice qué avisos llegaron al
  teléfono).

**Respaldo de datos** (mismo criterio que `0016`): la pantalla de reglas
mostraba «Alerta» como nivel por defecto de TODO tipo sin regla, y guardarla
creaba una fila por tipo con ese nivel. Eso bajaba en silencio el turno
abandonado y la diferencia crítica de caja —que nacen críticos— a alerta, y
al celular sólo sale lo crítico. Las reglas de `shift_stale`,
`cash_difference_critical` y `void_rate_high` que quedaron en `warning`
vuelven a `critical` (el nivel con el que el dueño pidió que le lleguen);
la pantalla ya muestra el nivel propio de cada tipo. El `downgrade` hace la
cuenta inversa sobre esos tres tipos.

Tablas nuevas con sus llaves foráneas desde el `create_table` (las dos bases
lo aceptan); `notifications` sólo gana una columna sin llave. 111 → 113.

Revision ID: 0031
Revises: 0030
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0031"
down_revision = "0030"
branch_labels: str | None = None
depends_on: str | None = None

_ACTIVE_ENDPOINT = "uq_push_subscriptions_active_endpoint"
_BACKFILLED_TYPES = ("shift_stale", "cash_difference_critical", "void_rate_high")


def upgrade() -> None:
    op.create_table(
        "push_vapid_keys",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False, unique=True),
        sa.Column("public_key", sa.String(200), nullable=False),
        sa.Column("private_key", sa.String(100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "push_subscriptions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("endpoint", sa.String(1000), nullable=False),
        sa.Column("p256dh", sa.String(200), nullable=False),
        sa.Column("auth", sa.String(100), nullable=False),
        sa.Column("vapid_public_key", sa.String(200), nullable=False),
        sa.Column("user_agent", sa.String(300), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_success_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.String(200), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_reason", sa.String(32), nullable=True),
    )
    op.create_index("ix_push_subscriptions_organization_id", "push_subscriptions", ["organization_id"])
    op.create_index("ix_push_subscriptions_employee_id", "push_subscriptions", ["employee_id"])
    op.create_index(
        _ACTIVE_ENDPOINT,
        "push_subscriptions",
        ["endpoint"],
        unique=True,
        postgresql_where=sa.text("revoked_at IS NULL"),
        sqlite_where=sa.text("revoked_at IS NULL"),
    )
    op.add_column("notifications", sa.Column("pushed_at", sa.DateTime(timezone=True), nullable=True))

    rules = sa.table("notification_rules", sa.column("type", sa.String), sa.column("level", sa.String))
    op.execute(
        rules.update()
        .where(rules.c.type.in_(_BACKFILLED_TYPES), rules.c.level == "warning")
        .values(level="critical")
    )


def downgrade() -> None:
    rules = sa.table("notification_rules", sa.column("type", sa.String), sa.column("level", sa.String))
    op.execute(
        rules.update()
        .where(rules.c.type.in_(_BACKFILLED_TYPES), rules.c.level == "critical")
        .values(level="warning")
    )
    op.drop_column("notifications", "pushed_at")
    op.drop_index(_ACTIVE_ENDPOINT, table_name="push_subscriptions")
    op.drop_index("ix_push_subscriptions_employee_id", table_name="push_subscriptions")
    op.drop_index("ix_push_subscriptions_organization_id", table_name="push_subscriptions")
    op.drop_table("push_subscriptions")
    op.drop_table("push_vapid_keys")
