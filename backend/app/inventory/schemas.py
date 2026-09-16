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
    "void_after_send",
    "waste",
    "note_return",
    "manual_adjustment",
    "purchase",
    "count_adjustment",
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
    """Mermas ÷ compras semanal (SPEC-NEGOCIO §5.5). `null` con
    `label="sin datos"` hasta 2b, que trae las compras — nunca `0`."""

    ratio: float | None
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
