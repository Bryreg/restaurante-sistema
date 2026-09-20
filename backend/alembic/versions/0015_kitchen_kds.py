"""KDS completo (pedido 2c, `backend-kds`): `kitchen_bump_events`,
`kitchen_print_jobs`.

DDL escrito a mano (Postgres-first), mismo estilo que `0008` … `0014`. Las
dos tablas son NUEVAS (`create_table` no tiene la limitación de
`batch_alter_table` en SQLite que dejaron escrita `0011`/`0012`), así que
las dos llevan **todas** sus FK reales, incluidas hacia `orders`/
`order_rounds`/`order_items` (creadas en `0004_orders.py`, mucho antes en la
cadena) y hacia `employees` (`0001_core.py`).

CONTRATO C5 (`app/core/models_registry.py`): `"kitchen"` lo agrega
`backend-dinero-canales` en su propio commit, junto con `"channels"` — este
archivo no toca ese registro ni `app/main.py`; sólo declara el DDL de las
tablas que `app/kitchen/models.py` ya define.

Revision ID: 0015
Revises: 0014
Create Date: 2026-09-19
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from app.kitchen.models import KitchenBumpAction

# revision identifiers, used by Alembic.
revision: str = "0015"
# `0013` (`backend-canales-comanda`) y `0014` (`backend-dinero-canales`) son
# migraciones hermanas de este mismo pedido 2c, escritas por otros agentes.
# Esta es la ÚNICA migración de este territorio (`backend-kds`): no se
# renumera ni se toca ninguna de las dos.
down_revision: str | None = "0014"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def _enum(pyenum: type, *, length: int = 16) -> sa.Enum:
    return sa.Enum(pyenum, native_enum=False, length=length, validate_strings=True)


def upgrade() -> None:
    # -- kitchen_bump_events -----------------------------------------------
    op.create_table(
        "kitchen_bump_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("order_id", sa.Integer(), sa.ForeignKey("orders.id"), nullable=False),
        sa.Column("item_id", sa.Integer(), sa.ForeignKey("order_items.id"), nullable=False),
        sa.Column("action", _enum(KitchenBumpAction, length=16), nullable=False),
        sa.Column("from_status", sa.String(16), nullable=False),
        sa.Column("to_status", sa.String(16), nullable=False),
        sa.Column("employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("employee_name", sa.String(200), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_kitchen_bump_events_organization_id", "kitchen_bump_events", ["organization_id"])
    op.create_index("ix_kitchen_bump_events_store_id", "kitchen_bump_events", ["store_id"])
    op.create_index("ix_kitchen_bump_events_order_id", "kitchen_bump_events", ["order_id"])
    op.create_index("ix_kitchen_bump_events_item_id", "kitchen_bump_events", ["item_id"])
    op.create_index("ix_kitchen_bump_events_item_at", "kitchen_bump_events", ["item_id", "at"])
    op.create_index("ix_kitchen_bump_events_store_at", "kitchen_bump_events", ["store_id", "at"])

    # -- kitchen_print_jobs --------------------------------------------------
    op.create_table(
        "kitchen_print_jobs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("order_id", sa.Integer(), sa.ForeignKey("orders.id"), nullable=False),
        sa.Column("round_id", sa.Integer(), sa.ForeignKey("order_rounds.id"), nullable=False),
        sa.Column("station", sa.String(50), nullable=False),
        sa.Column("item_count", sa.Integer(), nullable=False),
        sa.Column("printed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("printed_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("printed_by_employee_name", sa.String(200), nullable=False),
    )
    op.create_index("ix_kitchen_print_jobs_organization_id", "kitchen_print_jobs", ["organization_id"])
    op.create_index("ix_kitchen_print_jobs_store_id", "kitchen_print_jobs", ["store_id"])
    op.create_index("ix_kitchen_print_jobs_order_id", "kitchen_print_jobs", ["order_id"])
    op.create_index("ix_kitchen_print_jobs_round_id", "kitchen_print_jobs", ["round_id"])
    op.create_index("ix_kitchen_print_jobs_round_station", "kitchen_print_jobs", ["round_id", "station"])
    op.create_index("ix_kitchen_print_jobs_store_printed", "kitchen_print_jobs", ["store_id", "printed_at"])


def downgrade() -> None:
    op.drop_table("kitchen_print_jobs")
    op.drop_table("kitchen_bump_events")
