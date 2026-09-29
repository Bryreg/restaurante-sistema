"""Contratos de `labels`. Ninguna salida lleva costos: son rutas del POS."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

LabelKindLiteral = Literal["received", "opened", "produced"]
LabelStatusLiteral = Literal["active", "used_up", "discarded"]
UseBySourceLiteral = Literal["supplier", "opened_shelf_life", "prep_shelf_life", "manual"]
#: Cómo está la etiqueta hoy, calculado en el servidor (la pantalla no cuenta días).
LabelStateLiteral = Literal["expired", "today", "tomorrow", "ok", "no_date"]
#: Los tipos de merma que tiene sentido al botar algo etiquetado.
LabelWasteTypeLiteral = Literal["expired", "overproduction", "kitchen_error", "breakage", "unidentified"]
LabelFilterLiteral = Literal["active", "closed", "all"]


class LabelCreateIn(BaseModel):
    kind: LabelKindLiteral
    # `received`: el lote de la recepción, o el renglón del borrador que se
    # registró en la tablet (`reception_draft_line_id`), uno de los dos.
    # `opened`: opcional (sin él, el próximo a vencer del insumo).
    stock_batch_id: int | None = None
    reception_draft_line_id: int | None = None
    # `opened`: el insumo (o se deduce de `stock_batch_id`).
    ingredient_id: int | None = None
    # `produced`: el lote producido.
    prep_batch_id: int | None = None
    copies: int = Field(default=1, ge=1, le=30)
    qty_text: str | None = Field(default=None, max_length=40)
    # Una fecha más corta que la calculada, o la fecha cuando no hay regla.
    # Nunca más larga: lo que dice el proveedor o la ficha es el techo.
    use_by: date | None = None
    note: str | None = Field(default=None, max_length=200)


class LabelOut(BaseModel):
    id: int
    code: str
    kind: LabelKindLiteral
    ingredient_id: int | None
    preparation_id: int | None
    stock_batch_id: int | None
    prep_batch_id: int | None
    reception_draft_line_id: int | None
    item_name: str
    lot_code: str | None
    qty_text: str | None
    note: str | None
    made_at: datetime
    business_date: date
    use_by: date | None
    use_by_source: UseBySourceLiteral | None
    employee_name: str
    status: LabelStatusLiteral
    closed_at: datetime | None
    closed_by_employee_name: str | None
    waste_id: int | None
    print_count: int
    # Calculados contra la fecha operativa de hoy de la sede.
    days_left: int | None
    state: LabelStateLiteral
    # La unidad en que se pesa lo que se bota: la cómoda del insumo
    # («kg», «botella») o la base de la preparación (g, ml, und).
    waste_unit: str


class LabelFinishIn(BaseModel):
    outcome: Literal["used_up", "discarded"]
    # Sólo al botar, con `inventory.waste` encendida: cuánto se botó, en
    # `waste_unit`, y el PIN del responsable (la merma siempre pide PIN).
    qty: str | None = Field(default=None, max_length=30)
    waste_type: LabelWasteTypeLiteral = "expired"
    employee_pin: str | None = Field(default=None, max_length=20)
    note: str | None = Field(default=None, max_length=500)


class OpenableBatchOut(BaseModel):
    stock_batch_id: int
    lot_code: str | None
    expires_at: date | None


class OpenableIngredientOut(BaseModel):
    ingredient_id: int
    name: str
    category: str | None
    perishable: bool
    opened_shelf_life_days: int | None
    # El lote que se está usando (el próximo a vencer con saldo), si hay lotes.
    next_batch: OpenableBatchOut | None
    # Lo que diría la etiqueta si se imprime ya, sin fecha manual.
    use_by_preview: date | None
    use_by_source_preview: UseBySourceLiteral | None


class ReceivedSourceOut(BaseModel):
    # Uno de los dos: el lote (recepción completa) o el renglón del borrador
    # que la tablet registró y el administrador todavía no completó (o que
    # ya completó: el renglón sigue siendo lo que la cocina etiquetó).
    stock_batch_id: int | None
    reception_draft_line_id: int | None
    # El borrador espera al administrador.
    pending: bool
    ingredient_id: int
    name: str
    lot_code: str | None
    expires_at: date | None
    qty_received: str
    unit: str
    received_at: datetime
    labels_printed: int


class ProducedSourceOut(BaseModel):
    prep_batch_id: int
    preparation_id: int
    name: str
    qty_real: str
    unit: str
    expiry_date: date | None
    produced_at: datetime
    produced_by: str
    labels_printed: int


class LabelSourcesOut(BaseModel):
    business_date: date
    openable: list[OpenableIngredientOut]
    received: list[ReceivedSourceOut]
    produced: list[ProducedSourceOut]


class LabelBoardOut(BaseModel):
    business_date: date
    labels: list[LabelOut]
    expired: int
    today: int
    tomorrow: int


class LabelSettingsIn(BaseModel):
    width_mm: int = Field(ge=25, le=120)
    height_mm: int = Field(ge=15, le=120)


class LabelSettingsOut(BaseModel):
    store_id: int
    width_mm: int
    height_mm: int
