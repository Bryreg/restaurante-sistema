"""Esquemas de `inventory`. Ningún esquema de este módulo expone `cost`,
`cost_micros`, `margin` ni `food_cost` en una respuesta de **dispositivo**
(`DeviceIngredientOut`, `POST /waste`'s `WasteOut`): el operador no recibe
costos ni márgenes (regla dura, probada por el test del OpenAPI de
`tests/audit/test_security_invariants.py`, territorio ajeno, que tiene que
seguir pasando con este dominio montado).
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

BaseUnitLiteral = Literal["g", "ml", "unit"]
CostSourceLiteral = Literal["official", "weighted_average", "last_purchase", "estimated", "none"]
MovementCauseLiteral = Literal[
    "sale",
    "production_in",
    "production_out",
    "waste",
    "note_return",
    "manual_adjustment",
    "purchase",
    "count_adjustment",
    "reception_reversal",
    "transfer_in",
    "transfer_out",
]
WasteTypeLiteral = Literal[
    "expired",
    "overproduction",
    "kitchen_error",
    "breakage",
    "customer_return",
    "tasting",
    "courtesy_no_dish",
    "unidentified",
]


# ---------------------------------------------------------------------------
# Insumos (admin).
# ---------------------------------------------------------------------------


class IngredientIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    category: str | None = None
    base_unit: BaseUnitLiteral
    purchase_unit: str = Field(min_length=1, max_length=50)
    purchase_factor: int = Field(gt=0)
    yield_pct: int = Field(default=100, ge=1, le=100)
    # Decimales como texto (nunca `float` de JSON): `app.core.quantity`.
    official_cost: str | None = None
    estimated_cost: str | None = None
    min_stock: str  # obligatorio; `> 0` lo exige el service (`400 MIN_STOCK_REQUIRED`)
    lead_time_days: int | None = Field(default=None, ge=0)
    perishable: bool = False
    key_item: bool = False
    consumption_untracked: bool = False
    substitute_ingredient_id: int | None = None
    supplier_id: int | None = None
    active: bool = True


class IngredientUpdateIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    category: str | None = None
    base_unit: BaseUnitLiteral | None = None
    purchase_unit: str | None = Field(default=None, min_length=1, max_length=50)
    purchase_factor: int | None = Field(default=None, gt=0)
    yield_pct: int | None = Field(default=None, ge=1, le=100)
    official_cost: str | None = None
    clear_official_cost: bool = False
    estimated_cost: str | None = None
    clear_estimated_cost: bool = False
    min_stock: str | None = None
    lead_time_days: int | None = Field(default=None, ge=0)
    perishable: bool | None = None
    key_item: bool | None = None
    consumption_untracked: bool | None = None
    substitute_ingredient_id: int | None = None
    clear_substitute: bool = False
    supplier_id: int | None = None
    active: bool | None = None


class IngredientOut(BaseModel):
    id: int
    name: str
    category: str | None
    base_unit: BaseUnitLiteral
    purchase_unit: str
    purchase_factor: int
    yield_pct: int
    official_cost: str | None
    estimated_cost: str | None
    cost: str | None  # resuelto (`resolve_ingredient_cost`), en pesos por unidad base
    cost_source: CostSourceLiteral
    min_stock: str
    lead_time_days: int | None
    perishable: bool
    key_item: bool
    consumption_untracked: bool
    substitute_ingredient_id: int | None
    supplier_id: int | None
    active: bool


# ---------------------------------------------------------------------------
# Movimientos.
# ---------------------------------------------------------------------------


class StockMovementOut(BaseModel):
    id: int
    ingredient_id: int | None
    preparation_id: int | None
    qty_base: str
    cause: MovementCauseLiteral
    cost: str | None
    cost_source: CostSourceLiteral
    employee_id: int
    employee_name: str
    at: datetime
    business_date: str
    ref_type: str | None
    ref_id: int | None
    note: str | None


# ---------------------------------------------------------------------------
# Stock teórico.
# ---------------------------------------------------------------------------


class StockRowOut(BaseModel):
    ingredient_id: int
    name: str
    base_unit: BaseUnitLiteral
    qty_base: str
    min_stock: str
    below_min: bool
    negative: bool
    negative_since: datetime | None
    cost: str | None
    cost_source: CostSourceLiteral
    key_item: bool


# ---------------------------------------------------------------------------
# Mermas.
# ---------------------------------------------------------------------------


class WasteIn(BaseModel):
    ingredient_id: int | None = None
    preparation_id: int | None = None
    qty: str
    type: WasteTypeLiteral
    note: str | None = None
    employee_pin: str = Field(min_length=1, max_length=20)
    photo: str | None = None


class WasteOut(BaseModel):
    """Salida de `POST /waste` (ruta de dispositivo): sin `cost` ni
    `cost_source` a propósito — el operador no recibe costos. El admin lee
    el costo en `WasteAdminOut` (`GET /admin/waste`)."""

    id: int
    ingredient_id: int | None
    preparation_id: int | None
    qty: str
    type: WasteTypeLiteral
    employee_id: int
    employee_name: str
    at: datetime


class WasteAdminOut(WasteOut):
    cost: str | None
    cost_source: CostSourceLiteral
    note: str | None
    photo: str | None


class WasteKpiOut(BaseModel):
    """Mermas ÷ compras semanal (SPEC-NEGOCIO §5.5). **`ratio` es el único
    número no entero de toda la fase 2 — 2b lo cierra** (`outputs-2a/
    ENTREGA.md § 5`, O-6): en puntos básicos (× 10.000: `2.5 %` = `250`),
    nunca `float`. `null` con `label` legible cuando no hay compras en el
    período (mermas sin denominador no es `0`, es "sin datos"); deja de ser
    `null` en cuanto hay al menos una compra (`cause=PURCHASE` en el libro)
    en el rango."""

    ratio: int | None
    label: str


class WasteListOut(BaseModel):
    items: list[WasteAdminOut]
    weekly_kpi: WasteKpiOut


# ---------------------------------------------------------------------------
# Ajustes manuales.
# ---------------------------------------------------------------------------


class AdjustmentIn(BaseModel):
    ingredient_id: int
    qty_delta: str  # decimal, con signo (positivo = entra, negativo = sale)
    reason: str = Field(min_length=1, max_length=500)
    authorizer_pin: str = Field(min_length=1, max_length=20)


class AdjustmentOut(BaseModel):
    """`id` es el del `StockMovement` resultante (`cause=manual_adjustment`);
    `employee_id`/`employee_name` son quien autorizó (`authorizer_pin`
    verificado contra el personal admin de la organización), la misma
    persona que queda como atribución del movimiento."""

    id: int
    ingredient_id: int
    qty_delta: str
    reason: str
    employee_id: int
    employee_name: str
    at: datetime


# ---------------------------------------------------------------------------
# Dispositivo: sin ningún campo de costo.
# ---------------------------------------------------------------------------


class DeviceIngredientOut(BaseModel):
    id: int
    name: str
    base_unit: BaseUnitLiteral


# ---------------------------------------------------------------------------
# Lotes y vencimientos (pedido 2b, SPEC-NEGOCIO §5.7).
# ---------------------------------------------------------------------------

LotStatusLiteral = Literal["active", "expiring", "expired", "depleted"]


class LotOut(BaseModel):
    id: int
    ingredient_id: int
    ingredient_name: str
    lot_code: str | None
    qty_received: str
    qty_remaining: str
    unit_cost: str
    cost_source: CostSourceLiteral
    expires_at: str | None  # fecha ISO (`date`), o `null` == nunca vence
    received_at: datetime
    status: LotStatusLiteral
    source_type: str
    source_id: int


# ---------------------------------------------------------------------------
# Conteos a ciegas (pedido 2b, SPEC-NEGOCIO §5.4).
# ---------------------------------------------------------------------------

CountScopeLiteral = Literal["key_items", "full"]
CountStatusLiteral = Literal["open", "applied"]


class CountOpenIn(BaseModel):
    scope: CountScopeLiteral


class CountLineRefIn(BaseModel):
    """Una línea capturada. `was_counted` la escribe la persona que cuenta,
    renglón por renglón — **no existe un atajo que la ponga en `True` para
    todos los renglones a la vez** (SPEC-NEGOCIO §5.4)."""

    ingredient_id: int
    qty_counted: str  # texto decimal (`parse_qty_base`); un número JSON crudo se rechaza
    was_counted: bool = True


class CountLinesIn(BaseModel):
    lines: list[CountLineRefIn] = Field(min_length=1)


class CountLineOut(BaseModel):
    """**A CIEGAS por diseño**: ni un campo de stock teórico, ni una
    diferencia, ni un "sugerido". `previous_qty_counted` es la ÚNICA
    referencia en pantalla (SPEC-NEGOCIO §5.4: "la referencia en pantalla es
    el conteo anterior") — el valor que una persona escribió en el conteo
    anterior, nunca un cálculo del libro."""

    ingredient_id: int
    ingredient_name: str
    base_unit: BaseUnitLiteral
    qty_counted: str | None
    was_counted: bool
    previous_qty_counted: str | None


class CountLinesSaveOut(BaseModel):
    """Salida de `PUT /admin/counts/{id}/lines`: dice explícitamente que el
    guardado es PARCIAL (nunca implica "todo coincide")."""

    lines: list[CountLineOut]
    lines_counted: int
    lines_total: int
    partial: bool


class CountOut(BaseModel):
    id: int
    scope: CountScopeLiteral
    status: CountStatusLiteral
    opened_at: datetime
    business_date: str
    opened_by_employee_id: int
    opened_by_employee_name: str
    applied_at: datetime | None
    applied_by_employee_id: int | None
    applied_by_employee_name: str | None
    lines_total: int
    lines_counted: int


class CountDetailOut(CountOut):
    lines: list[CountLineOut]


class CountApplyIn(BaseModel):
    authorizer_pin: str = Field(min_length=1, max_length=20)


class CountApplyLineOut(BaseModel):
    ingredient_id: int
    ingredient_name: str
    qty_counted: str
    stock_before: str
    adjustment: str
    stock_after: str


class CountApplyOut(BaseModel):
    id: int
    applied_at: datetime
    applied_by_employee_id: int
    applied_by_employee_name: str
    lines: list[CountApplyLineOut]


# ---------------------------------------------------------------------------
# Varianza, food cost real y salud del control (pedido 2b, SPEC-NEGOCIO §5.4).
# ---------------------------------------------------------------------------

VarianceLevelLiteral = Literal["green", "yellow", "red"]


class VarianceRowOut(BaseModel):
    ingredient_id: int
    ingredient_name: str
    base_unit: BaseUnitLiteral
    opening_qty: str
    inflow_qty: str
    closing_qty: str
    real_usage_qty: str
    theoretical_usage_qty: str
    variance_qty: str  # real - teórico; positivo = se usó más de lo esperado
    # TOTAL de plata (no costo por unidad base): pesos enteros, igual
    # convención que cualquier total de venta ya cerrado (`app.core.money`;
    # NUNCA `format_cost_micros`, que es para costo POR UNIDAD, no un total).
    # Nombrado `variance_value`, no `variance_cost`: el barrido heredado
    # `tests/audit/test_cost_invariants.py::
    # test_no_cost_field_of_inventory_or_recipes_is_typed_as_an_integer`
    # exige que TODO campo `cost`/`*_cost` de `inventory`/`recipes` sea texto
    # decimal (por unidad base) — correcto para el resto del dominio, pero
    # este campo es a propósito un TOTAL ya cerrado, no una tarifa por
    # unidad; cambiarle el nombre evita forzar ese barrido a mentir sobre lo
    # que audita en vez de acotarlo sin necesidad.
    variance_value: int | None
    cost_source: CostSourceLiteral
    variance_pct_bp: int | None  # |variance| / teórico, en puntos básicos (× 10.000); null si teórico == 0
    level: VarianceLevelLiteral


class VarianceOut(BaseModel):
    count_id: int
    opening_count_id: int | None
    window_from: datetime | None
    window_to: datetime
    available: bool
    reason: str | None
    rows: list[VarianceRowOut]
    yellow_threshold_bp: int
    red_threshold_bp: int


class FoodCostOut(BaseModel):
    """(inventario inicial + compras − final) ÷ ventas netas, **sólo entre
    dos conteos completos consecutivos**. `pct_bp` es `null` (con `reason`)
    sin esos dos conteos — **jamás `0`**."""

    available: bool
    reason: str | None
    opening_count_id: int | None
    closing_count_id: int | None
    window_from: str | None
    window_to: str | None
    # TOTALES de plata: pesos enteros (`app.core.money`), no costo por
    # unidad base -- `format_cost_micros` no aplica acá.
    opening_value: int | None
    purchases_value: int | None
    closing_value: int | None
    net_sales: int | None
    pct_bp: int | None


class ControlHealthOut(BaseModel):
    days_since_full_count: int | None
    last_full_count_at: datetime | None
    inventory_unreliable: bool
    reception_invoice_ratio_bp: int | None
    reception_invoice_ratio_reason: str | None
    batch_preps_produced_ratio_bp: int | None
    batch_preps_produced_reason: str | None
    waste_entries_this_week: int


# ---------------------------------------------------------------------------
# Umbrales de varianza (configuración de sede; vive en `inventory` por
# decisión de arquitectura — no toca `app.stores`).
# ---------------------------------------------------------------------------


class InventorySettingsIn(BaseModel):
    variance_yellow_threshold_bp: int = Field(gt=0)
    variance_red_threshold_bp: int = Field(gt=0)


class InventorySettingsOut(BaseModel):
    store_id: int
    variance_yellow_threshold_bp: int
    variance_red_threshold_bp: int


# ---------------------------------------------------------------------------
# NOTA (ronda 2, H-2): los esquemas de la lectura agregada de consumo por
# comanda (§5.3) y el endpoint `GET /admin/orders/{order_id}/consumption`
# que los servía vivieron acá durante la ronda 1 de 2b y se SACARON por
# decisión del Maestro: la implementación de `app.orders` (que ya despachaba
# esa misma ruta en runtime) lee el costo CONGELADO de cada fila del libro
# -- snapshot, regla dura -- y suma `SALE + NOTE_RETURN` (consumo neto
# real), mientras la de acá revaloraba con `resolve_ingredient_cost` de HOY
# y sólo miraba `SALE`. Sacar la de acá no cambió ni una respuesta servida
# (la de `orders` es la que el ruteo real usaba); sólo alineó el contrato
# publicado con lo servido. Ver `outputs-2b/backend-inventario-espejo.md §
# Ronda 2`.
# ---------------------------------------------------------------------------
