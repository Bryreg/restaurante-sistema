"""Aviso leído no es aviso resuelto.

Abrir la campana marcaba los avisos leídos y, como «Requiere tu atención» de
Hoy filtraba por `read_at`, una comanda atascada desaparecía del riel con
sólo mirarla. Ahora son dos estados:

- `read_at` (ya existía): alguien lo vio; deja de contar como nuevo en la
  campana.
- `notifications.resolved_at`, `resolved_by_employee_id`, `resolved_by_name`
  (nuevas): el hecho se atendió —a mano con «Resolver», o solo, cuando la
  condición que lo disparó se apagó—; recién ahí sale del riel.

Los avisos ya leídos antes de esta migración se dan por resueltos a la hora
en que se leyeron (`resolved_by_name` «Migración»): era lo que el riel ya
hacía con ellos, y sin eso volverían todos de golpe a «Requiere tu atención».

Columnas, no tablas: el conteo no se mueve.

**Nota de integración**: `0041` se escribe en paralelo en otra rama; ésta
cuelga de `0040`. Al integrar, `down_revision` pasa a `"0041"`.

Revision ID: 0042
Revises: 0041
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0042"
down_revision = "0041"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    # Columnas sueltas, sin recrear la tabla (mismo criterio que `0037`).
    op.add_column("notifications", sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("notifications", sa.Column("resolved_by_employee_id", sa.Integer(), nullable=True))
    op.add_column("notifications", sa.Column("resolved_by_name", sa.String(200), nullable=True))
    op.execute(
        "UPDATE notifications SET resolved_at = read_at, resolved_by_name = 'Migración' "
        "WHERE read_at IS NOT NULL"
    )


def downgrade() -> None:
    with op.batch_alter_table("notifications") as batch:
        batch.drop_column("resolved_by_name")
        batch.drop_column("resolved_by_employee_id")
        batch.drop_column("resolved_at")
