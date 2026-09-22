"""Reservas de mesa.

El sexto estado del plano que la maqueta `m2b` dibuja —«reservada», con la
hora y el nombre de quien viene— y que el producto no podía pintar porque no
existía el dominio. Una tarjeta que dice «9:00 p. m. · Familia Rincón» sin
nada detrás es una mentira con buena tipografía.

Una reserva **no es una comanda**: no tiene plata, no toca el turno y no entra
en ningún cuadre. Por eso ninguna columna de dinero y ninguna FK al turno.
Cuando la gente llega, la reserva pasa a `seated` y guarda el `order_id` de la
comanda que se abrió: ése es el hilo entre lo que se apartó y lo que esa mesa
terminó consumiendo.

**Nada se borra**: cancelar es `status="cancelled"` con su hora y su motivo, y
la fila queda. Quién no llegó es justamente lo que un dueño quiere poder mirar
a fin de mes, y un `DELETE` lo haría imposible.

El índice `(store_id, business_date)` es la pregunta que el salón hace todo el
tiempo: «qué reservas tiene esta sede para este día operativo».

Revision ID: 0023
Revises: 0022
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0023"
down_revision: str | None = "0022"
branch_labels: str | None = None
depends_on: str | None = None

_ESTADOS = ("booked", "seated", "cancelled", "no_show")


def upgrade() -> None:
    op.create_table(
        "reservations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id"), nullable=False),
        sa.Column("store_id", sa.Integer(), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("table_id", sa.Integer(), sa.ForeignKey("tables.id"), nullable=False),
        sa.Column("business_date", sa.Date(), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("party_name", sa.String(length=120), nullable=False),
        sa.Column("party_size", sa.Integer(), nullable=False, server_default="2"),
        sa.Column("phone", sa.String(length=40), nullable=True),
        sa.Column("note", sa.String(length=300), nullable=True),
        sa.Column(
            "status",
            sa.Enum(*_ESTADOS, native_enum=False, length=32, validate_strings=True),
            nullable=False,
            server_default="booked",
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by_name", sa.String(length=200), nullable=True),
        sa.Column("seated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("seated_order_id", sa.Integer(), sa.ForeignKey("orders.id"), nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("closed_reason", sa.String(length=300), nullable=True),
        sa.Column("closed_by_name", sa.String(length=200), nullable=True),
    )
    op.create_index("ix_reservations_organization_id", "reservations", ["organization_id"])
    op.create_index("ix_reservations_store_id", "reservations", ["store_id"])
    op.create_index("ix_reservations_table_id", "reservations", ["table_id"])
    op.create_index("ix_reservations_store_date", "reservations", ["store_id", "business_date"])


def downgrade() -> None:
    # Reversa de verdad: la tabla es nueva y no hay datos que migrar a ningún
    # lado, así que bajar de versión la borra entera. Es el único caso en que
    # un `drop_table` es correcto acá — no se está perdiendo historia de un
    # esquema anterior, porque no había esquema anterior.
    op.drop_index("ix_reservations_store_date", table_name="reservations")
    op.drop_index("ix_reservations_table_id", table_name="reservations")
    op.drop_index("ix_reservations_store_id", table_name="reservations")
    op.drop_index("ix_reservations_organization_id", table_name="reservations")
    op.drop_table("reservations")
