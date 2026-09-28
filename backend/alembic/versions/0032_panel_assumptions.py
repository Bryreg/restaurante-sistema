"""Los supuestos del panel del dueño en Ajustes › Ventas.

El rediseño del panel («barra + raya», `docs/diseno/handoff-pos-y-panel`)
dibuja cada dato contra una raya de referencia. Algunas rayas son hechos
(la semana anterior, el mínimo de un insumo, el umbral de retiro, que ya
existe como `store_cash_settings.cash_pickup_threshold`); otras son
**decisiones del dueño** y no pueden vivir quemadas en el código:

- `margin_target_pct` — margen bruto meta por categoría (65 %).
- `long_table_minutes` — desde cuándo una mesa abierta es «mesa larga» (60).
- `late_ticket_minutes` — desde cuándo un tiquete de cocina está demorado (20).
- `orders_per_waiter` — comandas por hora que alcanza un mesero (7).

Cuatro columnas en `store_sales_settings`, con `server_default` para que las
sedes existentes queden con el supuesto por defecto sin respaldo aparte. No
agrega tablas: el conteo sigue en 113.

Revision ID: 0032
Revises: 0031
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0032"
down_revision = "0031"
branch_labels: str | None = None
depends_on: str | None = None

_COLUMNS = (
    ("margin_target_pct", "65"),
    ("long_table_minutes", "60"),
    ("late_ticket_minutes", "20"),
    ("orders_per_waiter", "7"),
)


def upgrade() -> None:
    for name, default in _COLUMNS:
        op.add_column(
            "store_sales_settings",
            sa.Column(name, sa.Integer(), nullable=False, server_default=default),
        )


def downgrade() -> None:
    # `drop_column` de una columna sin llaves ni CHECK: directo en Postgres y
    # en SQLite ≥ 3.35 (no hace falta recrear la tabla).
    for name, _default in reversed(_COLUMNS):
        op.drop_column("store_sales_settings", name)
