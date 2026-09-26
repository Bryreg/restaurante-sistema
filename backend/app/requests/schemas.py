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
    # Texto decimal. Sin `entry_unit`, en la unidad base del insumo ("2500"
    # g). Con `entry_unit` (el rótulo que publica `supply-suggestions` o
    # `GET /device/ingredients`), en esa unidad cómoda ("2.5" kg, "3"
    # botellas): el servidor convierte una sola vez (`inventory.units`).
    qty: str
    entry_unit: str | None = Field(default=None, max_length=50)


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
    # Lo mismo en la unidad cómoda del insumo (kg, botellas, L, unidades),
    # para mostrar: la conversión la hace el servidor, nunca la pantalla.
    entry_unit: str
    qty_requested_entry: str
    qty_approved_entry: str | None


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


class SupplyItemOut(BaseModel):
    """Un insumo que se puede pedir, con su unidad cómoda. Sin costo."""

    ingredient_id: int
    name: str
    entry_mode: Literal["weight", "bottle", "volume", "unit"]
    entry_unit: str


class SupplySuggestionOut(BaseModel):
    """Un insumo bajo mínimo o en negativo. Sin costo: es de la tablet."""

    ingredient_id: int
    name: str
    base_unit: str
    current_stock: str
    min_stock: str
    negative: bool
    # Lo que falta para volver al mínimo (`mínimo − stock`), redondeado HACIA
    # ARRIBA al paso cómodo (medio kilo, medio litro, botella o unidad
    # entera), en la unidad base. Siempre > 0 acá.
    suggested_qty: str
    # La misma sugerencia en la unidad cómoda («0.5» kg, «2» botellas): es
    # la que se muestra y la que viaja con `entry_unit` al pedir.
    entry_mode: Literal["weight", "bottle", "volume", "unit"]
    entry_unit: str
    suggested_entry_qty: str


class SupplySuggestionsOut(BaseModel):
    # `False` con `reason` cuando el inventario perpetuo está apagado: sin
    # libro de movimientos no hay stock que comparar — nunca una lista vacía
    # muda que diga «no falta nada».
    available: bool
    reason: str | None
    # Bajo mínimo en el área de quien pide (o en toda la sede si no tiene
    # área: `area_via = "none"`).
    rows: list[SupplySuggestionOut]
    # El área con la que se filtró: la asignada en Conteo por área
    # (`member`), la que se llama como su puesto (`puesto`), o ninguna.
    area_name: str | None = None
    area_via: Literal["member", "puesto", "none"] = "none"
    # Cuántos insumos de OTRAS áreas también están bajo mínimo (no se
    # listan: no son de quien pide). 0 cuando no se filtró.
    other_areas_count: int = 0
    # Lo que más se pidió en la sede en los últimos días: botones de un
    # toque para arrancar el pedido.
    frequent: list[SupplyItemOut] = Field(default_factory=list)
