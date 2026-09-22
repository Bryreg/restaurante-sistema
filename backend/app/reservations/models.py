"""Reservas de mesa.

Nace de la maqueta `m2b`, que dibuja un sexto estado de mesa —«reservada»,
con la hora y el nombre de quien viene— y que el producto no podía pintar
porque no existía el dominio. Una tarjeta que dice «9:00 p. m. · Familia
Rincón» sin nada detrás es una mentira con buena tipografía.

Lo que una reserva **es** acá: un apartado sobre una mesa, para una hora de
un día operativo, a nombre de alguien. Lo que **no** es: una comanda. No
tiene plata, no toca el turno y no entra en ningún cuadre. Cuando la gente
llega, la reserva se marca como sentada y la mesa se abre por el camino
normal (`POST /orders`), que es el que ya sabe cobrar.

Convenciones heredadas (`AGENTS.md`, `app/orders/models.py`):
- `app.core.db.UTCDateTime` en todo `Mapped[datetime]`.
- Enums `native_enum=False`, comparados por valor.
- `organization_id` y `store_id` indexados.
- **Nada se borra**: cancelar es `status="cancelled"` con su hora y su
  motivo, y la fila queda. Quién no llegó es justamente lo que un dueño
  quiere poder mirar a fin de mes.
"""

from __future__ import annotations

import enum
from datetime import date, datetime

import sqlalchemy as sa
from sqlalchemy import ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UTCDateTime


def _enum(pyenum: type[enum.Enum]) -> sa.Enum:
    return sa.Enum(pyenum, native_enum=False, length=32, validate_strings=True)


class ReservationStatus(str, enum.Enum):
    #: Apartada y esperando.
    BOOKED = "booked"
    #: Llegaron y se sentaron. Deja de ocupar la mesa en el plano porque la
    #: comanda pasa a hacerlo.
    SEATED = "seated"
    #: La cancelaron (o la sede la canceló). Queda con su hora y su motivo.
    CANCELLED = "cancelled"
    #: Pasó la hora y nunca llegaron. Lo marca una persona, no un reloj: el
    #: sistema no sabe si el cliente está estacionando.
    NO_SHOW = "no_show"


class Reservation(Base):
    __tablename__ = "reservations"
    __table_args__ = (
        # El plano del salón pregunta siempre lo mismo: «qué reservas tiene
        # esta sede para este día operativo». Ese es el índice.
        Index("ix_reservations_store_date", "store_id", "business_date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), nullable=False, index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), nullable=False, index=True)
    table_id: Mapped[int] = mapped_column(ForeignKey("tables.id"), nullable=False, index=True)

    #: El día operativo de la sede, con su corte — no la fecha del calendario.
    #: Una reserva de la 1 a. m. pertenece a la noche anterior, igual que la
    #: venta de esa hora.
    business_date: Mapped[date] = mapped_column(sa.Date, nullable=False)
    #: El instante exacto, en UTC. La pantalla lo escribe en hora de Bogotá.
    at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)

    party_name: Mapped[str] = mapped_column(String(120), nullable=False)
    party_size: Mapped[int] = mapped_column(Integer, nullable=False, default=2)
    phone: Mapped[str | None] = mapped_column(String(40), nullable=True)
    note: Mapped[str | None] = mapped_column(String(300), nullable=True)

    status: Mapped[ReservationStatus] = mapped_column(
        _enum(ReservationStatus), nullable=False, default=ReservationStatus.BOOKED
    )

    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    created_by_name: Mapped[str | None] = mapped_column(String(200), nullable=True)

    #: Cuándo se sentó / se canceló, y por qué. La fila NO se borra.
    seated_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    #: La comanda que abrió al sentarse, cuando la hubo: es el hilo entre la
    #: reserva y lo que esa mesa terminó consumiendo.
    seated_order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id"), nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    closed_reason: Mapped[str | None] = mapped_column(String(300), nullable=True)
    closed_by_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
