"""Precio por canal, domicilio propio, plataforma y «marchar» (pedido 2c,
`backend-canales-comanda`): `products.is_delivery_fee`, doce columnas nuevas
en `orders` (domicilio, plataforma, cancelación de plataforma) y la tabla
nueva `order_course_fires`.

DDL escrito a mano (Postgres-first), como `0008` … `0012`: `batch_alter_table`
para las dos tablas existentes (sin `recreate=`, la lección cara de
`0011_purchases.py` contra Postgres real — batch normal hace `ALTER TABLE`
directo en Postgres y sólo recrea en SQLite, que es donde hace falta), un
índice por FK y por filtro de pantalla, `CheckConstraint` para lo que ya
valida el modelo.

**Por qué NO se ensancha `orders.status`** (`VARCHAR(16)` desde
`0004_orders.py`): el estado nuevo (`OrderStatus.PLATFORM_CANCELLED`,
`app/orders/models.py`) usa `.value = "compensated"` (11 caracteres, entra
sin tocar la columna) en vez de `"platform_cancelled"` (19, no entraba) — un
`ALTER COLUMN` sobre una columna que ya existe es exactamente el tipo de
cambio que `0011` dejó escrito como lección: se evita del todo si el valor
cabe.

`orders.platform_id` es `Integer` **sin FK dura** a `delivery_platforms`
(tabla de `app.channels`, CONTRATO C2): mismo patrón que
`OrderSubAccount.document_id` con `app.fiscal` en `0004_orders.py`. Los
`employee_id` (`courier_employee_id`,
`platform_cancelled_by_employee_id`) sí son FK real a `employees` — la
regla propia del proyecto de atribución con FK real + nombre congelado
(`docs/ESTADO.md`).

`order_course_fires` es tabla NUEVA de este territorio (`app.orders`):
`UNIQUE(order_id, course)` es la defensa de base de "marchar es idempotente,
no mueve el primer `fired_at`" (`app.orders.service.fire_course` ya lo
garantiza en la aplicación; esto es la red de seguridad).

Revision ID: 0013
Revises: 0012
Create Date: 2026-09-19
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    # -- products: el cargo de domicilio como producto real (§4.3) ----------
    with op.batch_alter_table("products") as batch_op:
        batch_op.add_column(
            sa.Column("is_delivery_fee", sa.Boolean(), nullable=False, server_default=sa.false())
        )

    # -- orders: domicilio, plataforma y su cancelación ----------------------
    with op.batch_alter_table("orders") as batch_op:
        batch_op.add_column(sa.Column("delivery_address", sa.String(300), nullable=True))
        batch_op.add_column(sa.Column("delivery_phone", sa.String(30), nullable=True))
        batch_op.add_column(sa.Column("courier_employee_id", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("courier_employee_name", sa.String(200), nullable=True))
        batch_op.add_column(sa.Column("platform_id", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("platform_name", sa.String(200), nullable=True))
        batch_op.add_column(sa.Column("platform_commission_bp", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("platform_external_id", sa.String(100), nullable=True))
        batch_op.add_column(sa.Column("platform_cancelled_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(sa.Column("platform_cancel_reason", sa.Text(), nullable=True))
        batch_op.add_column(sa.Column("platform_cancelled_by_employee_id", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("platform_cancelled_by_employee_name", sa.String(200), nullable=True))
        batch_op.create_index("ix_orders_courier_employee_id", ["courier_employee_id"])
        batch_op.create_index("ix_orders_platform_id", ["platform_id"])
        batch_op.create_index(
            "ix_orders_platform_cancelled_by_employee_id", ["platform_cancelled_by_employee_id"]
        )
        batch_op.create_foreign_key(
            "fk_orders_courier_employee", "employees", ["courier_employee_id"], ["id"]
        )
        batch_op.create_foreign_key(
            "fk_orders_platform_cancelled_by_employee", "employees", ["platform_cancelled_by_employee_id"], ["id"]
        )

    # -- order_course_fires: el sello de «marchar» ---------------------------
    op.create_table(
        "order_course_fires",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("order_id", sa.Integer(), sa.ForeignKey("orders.id"), nullable=False),
        sa.Column("course", sa.String(50), nullable=False),
        sa.Column("fired_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("fired_by_employee_id", sa.Integer(), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("fired_by_employee_name", sa.String(200), nullable=False),
        sa.UniqueConstraint("order_id", "course", name="uq_order_course_fires_order_course"),
    )
    op.create_index("ix_order_course_fires_organization_id", "order_course_fires", ["organization_id"])
    op.create_index("ix_order_course_fires_store_id", "order_course_fires", ["store_id"])
    op.create_index("ix_order_course_fires_order_id", "order_course_fires", ["order_id"])


def downgrade() -> None:
    op.drop_table("order_course_fires")

    with op.batch_alter_table("orders") as batch_op:
        batch_op.drop_constraint("fk_orders_platform_cancelled_by_employee", type_="foreignkey")
        batch_op.drop_constraint("fk_orders_courier_employee", type_="foreignkey")
        batch_op.drop_index("ix_orders_platform_cancelled_by_employee_id")
        batch_op.drop_index("ix_orders_platform_id")
        batch_op.drop_index("ix_orders_courier_employee_id")
        batch_op.drop_column("platform_cancelled_by_employee_name")
        batch_op.drop_column("platform_cancelled_by_employee_id")
        batch_op.drop_column("platform_cancel_reason")
        batch_op.drop_column("platform_cancelled_at")
        batch_op.drop_column("platform_external_id")
        batch_op.drop_column("platform_commission_bp")
        batch_op.drop_column("platform_name")
        batch_op.drop_column("platform_id")
        batch_op.drop_column("courier_employee_name")
        batch_op.drop_column("courier_employee_id")
        batch_op.drop_column("delivery_phone")
        batch_op.drop_column("delivery_address")

    with op.batch_alter_table("products") as batch_op:
        batch_op.drop_column("is_delivery_fee")
