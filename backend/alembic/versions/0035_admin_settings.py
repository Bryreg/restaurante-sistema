"""Todo se configura desde el panel: umbrales que vivían quemados en el código.

Pedido del dueño: «todo se debe poder configurar desde el panel
administrativo». Una auditoría encontró cifras que son **decisiones del
dueño** y vivían como constantes (en el backend o, peor, repetidas en la
pantalla). Pasan a columnas de la configuración de sede que ya existe, cada
una con `server_default` igual a la constante de antes: ninguna sede cambia
de comportamiento al migrar.

- `store_sales_settings` (Ajustes › Ventas):
  - `station_target_minutes` — objetivo de cocina por estación (KDS), antes
    `app.kitchen.service.DEFAULT_STATION_TARGET_MINUTES`. `{}` = los de fábrica.
  - `quick_notes` — notas rápidas del POS por curso, antes quemadas en
    `frontend/src/features/orders/lib.ts`. `{}` = las de fábrica.
  - `employee_session_minutes`, `pin_lock_attempts`, `pin_lock_minutes` —
    sesión de la persona y bloqueo del PIN; `NULL` = el de la variable de
    entorno (`app.core.config`), que sigue siendo el default.
  - `period_low_base_orders`, `daily_low_base_orders` — debajo de cuántas
    comandas un porcentaje de Informes es «muestra chica» (20 y 5).
- `store_cash_settings` (Ajustes › Caja): `deposit_overdue_days` — días de
  plata de cierres sin consignar antes del aviso (3).
- `store_inventory_settings` (Ajustes › Inventario y compras): salto de
  precio de compra (15 %), varianza de producción (15 %), días sin conteo
  completo para «inventario no confiable» (14), ventana de lotes por vencer
  (7 días), franja de food cost (28–35 %) y los umbrales de confiabilidad de
  proveedores (99 %/95 % recibido, 5 %/10 % deriva, 5 recepciones).
- `area_count_settings` (Ajustes › Inventario › Conteo por área): artículos
  por área (15), artículos de un recuento (5) y la hora desde la que se
  sugiere «Cierre» (20 h).

Sólo columnas: el conteo de tablas no se mueve (113).

Revision ID: 0035
Revises: 0034
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0035"
down_revision = "0034"
branch_labels: str | None = None
depends_on: str | None = None

_INT_NOT_NULL: dict[str, tuple[tuple[str, str], ...]] = {
    "store_sales_settings": (
        ("period_low_base_orders", "20"),
        ("daily_low_base_orders", "5"),
    ),
    "store_cash_settings": (("deposit_overdue_days", "3"),),
    "store_inventory_settings": (
        ("price_jump_pct", "15"),
        ("prep_variance_alert_pct", "15"),
        ("stale_days", "14"),
        ("lot_expiring_window_days", "7"),
        ("food_cost_band_min_pct", "28"),
        ("food_cost_band_max_pct", "35"),
        ("supplier_received_warning_bp", "9900"),
        ("supplier_received_critical_bp", "9500"),
        ("supplier_drift_warning_bp", "500"),
        ("supplier_drift_critical_bp", "1000"),
        ("supplier_min_receptions", "5"),
    ),
    "area_count_settings": (
        ("max_items_per_area", "15"),
        ("max_recount_items", "5"),
        ("suggest_closing_from_hour", "20"),
    ),
}

_JSON = (("store_sales_settings", "station_target_minutes"), ("store_sales_settings", "quick_notes"))
_INT_NULL = (
    ("store_sales_settings", "employee_session_minutes"),
    ("store_sales_settings", "pin_lock_attempts"),
    ("store_sales_settings", "pin_lock_minutes"),
)


def upgrade() -> None:
    for table, columns in _INT_NOT_NULL.items():
        for name, default in columns:
            op.add_column(table, sa.Column(name, sa.Integer(), nullable=False, server_default=default))
    for table, name in _JSON:
        op.add_column(table, sa.Column(name, sa.JSON(), nullable=False, server_default="{}"))
    for table, name in _INT_NULL:
        op.add_column(table, sa.Column(name, sa.Integer(), nullable=True))


def downgrade() -> None:
    # Columnas sin llaves ni CHECK: `drop_column` directo (Postgres y
    # SQLite ≥ 3.35), igual que 0032.
    for table, name in reversed(_INT_NULL):
        op.drop_column(table, name)
    for table, name in reversed(_JSON):
        op.drop_column(table, name)
    for table, columns in reversed(list(_INT_NOT_NULL.items())):
        for name, _default in reversed(columns):
            op.drop_column(table, name)
