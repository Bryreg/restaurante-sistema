"""Contratos de reservas. Nada de plata: una reserva no tiene total."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

ReservationStatusLiteral = Literal["booked", "seated", "cancelled", "no_show"]


class ReservationIn(BaseModel):
    table_id: int
    at: datetime
    party_name: str = Field(min_length=1, max_length=120)
    party_size: int = Field(default=2, ge=1, le=60)
    phone: str | None = Field(default=None, max_length=40)
    note: str | None = Field(default=None, max_length=300)


class ReservationCloseIn(BaseModel):
    """Cancelar o marcar que no llegaron. El motivo es obligatorio en la
    cancelación: «se canceló» sin decir por qué no le sirve a nadie a fin de
    mes, que es cuando alguien mira esta lista."""

    status: Literal["cancelled", "no_show"]
    reason: str | None = Field(default=None, max_length=300)


class ReservationTableRefOut(BaseModel):
    id: int
    number: str
    seats: int


class ReservationOut(BaseModel):
    id: int
    table: ReservationTableRefOut
    business_date: date
    at: datetime
    party_name: str
    party_size: int
    phone: str | None = None
    note: str | None = None
    status: ReservationStatusLiteral
    created_at: datetime
    created_by_name: str | None = None
    seated_at: datetime | None = None
    seated_order_id: int | None = None
    closed_at: datetime | None = None
    closed_reason: str | None = None
    closed_by_name: str | None = None


class TableReservationOut(BaseModel):
    """Lo poco que el plano del salón necesita saber de una reserva: cuándo y
    a nombre de quién. Va adentro de `TableStatusOut`."""

    id: int
    at: datetime
    party_name: str
    party_size: int
