"""Consumo teórico al enviar (pedido 2a, `backend-consumo`):
`order_items.cost_source` (nuevo, viaja siempre junto a `unit_cost`, que ya
existía desde `0004_orders.py` y quedaba siempre `NULL`); `waste_stubs.
ingredient_id` pasa de `Integer` pelado a **FK real** hacia `ingredients.id`.

Ronda 2 (B-2, ampliando esta misma migración — `tests/audit/
test_migration_invariants.py:391` fija `head == "0010"`, no se crea una
`0011`): `order_items.unit_cost_micros` (`BigInteger`, nullable), el mismo
costo que `unit_cost` pero SIN redondear a pesos. `unit_cost` (pesos,
`micros_to_pesos` half-up) se queda exactamente como estaba, para los
invariantes verdes que ya lo fijan; `unit_cost_micros` es aditiva, para que
un reporte que suma muchas líneas (`app.reports.service
._document_cost_stats`) acumule en micros y convierta a pesos una sola vez,
en vez de sumar redondeos de a uno (el "cero mudo congelado": un plato de
$0,30 de costo teórico congela `unit_cost=0`, y 100 de esos ítems sumaban
$0 en vez de $30).

DDL escrito a mano (Postgres-first), como `0007_fiscal_ranges_notes.py`/
`0008_inventory.py`/`0009_recipes.py`: `batch_alter_table` en las dos tablas
(SQLite no soporta `ALTER TABLE ... ADD CONSTRAINT` directo; `render_as_batch`
en `alembic/env.py` ya lo cubre para el resto de la cadena).

Por qué la FK de `waste_stubs.ingredient_id` entra bien de una acá y no como
`Integer` sin FK: a diferencia de `StockMovement.preparation_id` (`app.
inventory.models`, dominio ajeno) o de `fiscal_range_id` antes de 1b-2,
`waste_stubs` es tabla de **este** territorio (`app.orders`) y esta migración
(`0010`) corre después de `0008_inventory.py` — `ingredients` ya existe en la
base y en `MODEL_MODULES` (este mismo pedido agrega `"inventory"` a
`app.core.models_registry.MODEL_MODULES` antes de que corra ninguna
migración) para cuando esta migración corre, así que no hay razón para
posponer la FK real.

Revision ID: 0010
Revises: 0009
Create Date: 2026-09-15
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    # -- order_items: cost_source (viaja con unit_cost) ---------------------
    with op.batch_alter_table("order_items") as batch_op:
        batch_op.add_column(sa.Column("cost_source", sa.String(20), nullable=True))
        # Ronda 2 (B-2): el mismo costo, sin redondear a pesos.
        batch_op.add_column(sa.Column("unit_cost_micros", sa.BigInteger(), nullable=True))

    # -- waste_stubs: ingredient_id pasa a FK real ---------------------------
    with op.batch_alter_table("waste_stubs") as batch_op:
        batch_op.create_index("ix_waste_stubs_ingredient_id", ["ingredient_id"])
        batch_op.create_foreign_key(
            "fk_waste_stubs_ingredient", "ingredients", ["ingredient_id"], ["id"]
        )


def downgrade() -> None:
    with op.batch_alter_table("waste_stubs") as batch_op:
        batch_op.drop_constraint("fk_waste_stubs_ingredient", type_="foreignkey")
        batch_op.drop_index("ix_waste_stubs_ingredient_id")

    with op.batch_alter_table("order_items") as batch_op:
        batch_op.drop_column("unit_cost_micros")
        batch_op.drop_column("cost_source")
