"""Esquemas de `requests`.

Ningún esquema de este dominio lleva costos ni márgenes: las rutas de
dispositivo (`/requests/...`) los sirven a la tablet, y las de administrador
comparten las mismas formas. Las cantidades de insumo viajan como texto
decimal en la unidad base (`format_qty_base` / `parse_qty_base`), nunca como
milésimas crudas. Las denominaciones usan los esquemas del turno
(`DenominationCountIn`): una sola forma de contar plata en todo el sistema.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.shifts.schemas import DenominationCountIn, DenominationIn

StaffRequestKindLiteral = Literal["supply", "change"]
StaffRequestStatusLiteral = Literal["pending", "approved", "rejected", "bought", "received"]


# ---------------------------------------------------------------------------
# Entrada — operador
# ---------------------------------------------------------------------------


class SupplyLineIn(BaseModel):
    ingredient_id: int
    # Texto decimal en la unidad base del insumo ("2.5" kg no: "2500" g).
    qty: str


class SupplyRequestIn(BaseModel):
    lines: list[SupplyLineIn] = Field(min_length=1)
    note: str | None = None


class ChangeRequestIn(BaseModel):
    denominations: DenominationCountIn
    reason: str


class ReceivedIn(BaseModel):
    # El Cambio (`POST /shifts/{id}/cash-swaps`) con el que se registró la
    # sencilla en el cajón. Opcional: si no se ata, queda a la vista.
    cash_swap_id: int | None = None


# ---------------------------------------------------------------------------
# Entrada — administrador
# ---------------------------------------------------------------------------


class ApproveLineIn(BaseModel):
    line_id: int
    qty: str


class ApproveIn(BaseModel):
    # Insumos: ajustes por renglón; el renglón que no viene se aprueba como
    # se pidió. Un `"0"` aprueba el pedido sin ese insumo.
    lines: list[ApproveLineIn] | None = None
    # Sencilla: el desglose ajustado; sin él se aprueba el pedido.
    denominations: DenominationCountIn | None = None
    note: str | None = None


class RejectIn(BaseModel):
    reason: str


class MarkBoughtIn(BaseModel):
    note: str | None = None


# ---------------------------------------------------------------------------
# Salida
# ---------------------------------------------------------------------------


class PersonRef(BaseModel):
    id: int
    name: str


class RequestLineOut(BaseModel):
    id: int
    ingredient_id: int
    ingredient_name: str
    base_unit: str
    qty_requested: str
    qty_approved: str | None
    suggested_qty: str | None


class StaffRequestOut(BaseModel):
    id: int
    kind: StaffRequestKindLiteral
    status: StaffRequestStatusLiteral
    shift_id: int
    business_date: date
    requested_by: PersonRef
    requested_at: datetime
    note: str | None
    reason: str | None
    lines: list[RequestLineOut]
    requested_denominations: list[DenominationIn] | None
    requested_total: int | None
    approved_denominations: list[DenominationIn] | None
    approved_total: int | None
    resolved_by: PersonRef | None
    resolved_at: datetime | None
    resolution_note: str | None
    closed_by: PersonRef | None
    closed_at: datetime | None
    cash_swap_id: int | None


class SupplySuggestionOut(BaseModel):
    """Un insumo bajo mínimo o en negativo. Sin costo: es de la tablet."""

    ingredient_id: int
    name: str
    base_unit: str
    current_stock: str
    min_stock: str
    negative: bool
    # Lo que falta para volver al mínimo (`mínimo − stock`), la misma regla
    # que la reposición sugerida del administrador. Siempre > 0 acá.
    suggested_qty: str


class SupplySuggestionsOut(BaseModel):
    # `False` con `reason` cuando el inventario perpetuo está apagado: sin
    # libro de movimientos no hay stock que comparar — nunca una lista vacía
    # muda que diga «no falta nada».
    available: bool
    reason: str | None
    rows: list[SupplySuggestionOut]
