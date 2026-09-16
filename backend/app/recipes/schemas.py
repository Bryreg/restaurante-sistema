"""Esquemas de fichas técnicas, preparaciones y `recipe_effect`.

Regla dura (`AGENTS.md`, checklist del pedido): **ningún** esquema de este
módulo que sirva una ruta de dispositivo (`GET /preparations`,
`POST /preparations/{id}/produce`) tiene un campo cuyo nombre contenga
`cost`, `margin`, `unit_cost` ni `food_cost` — por eso hay un `...DeviceOut`
separado de cada `...AdminOut` en vez de un único esquema con campos
opcionales que alguien podría llenar para el dispositivo por accidente.

Cantidades en el borde: el cliente manda decimales como **string** (`qty`);
`app.recipes.units` los convierte con `Decimal` y el servicio guarda `int`
(nunca `float`, nunca `Decimal` persistido). Las respuestas devuelven la
cantidad como `str` decimal (reconstruida desde el entero guardado) y el
costo TAMBIÉN como `str` decimal en pesos con precisión completa
(`app.core.quantity.format_cost_micros`), exactamente como ya lo hace
`app.inventory.service.ingredient_out` (`cost: str | None`) — nunca micros
crudos hacia afuera, y nunca redondeado a pesos enteros: `micros_to_pesos`
queda reservado para plata de venta (el snapshot `order_items.unit_cost`,
totales de reportes), no para un costo por unidad base ni para un costo
publicado por este dominio, porque redondear a pesos ANTES de exponerlo
convierte cualquier costo por debajo de $1 en un `"0"` que no distingue
"sin costo" de "cuesta centavos".
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field, model_validator

PrepModeLiteral = Literal["batch", "exploded"]
RecipeEffectLiteral = Literal["add", "remove", "replace"]
UnitLiteral = Literal["g", "kg", "ml", "l", "unit"]


# ---------------------------------------------------------------------------
# Líneas compartidas (insumo XOR preparación)
# ---------------------------------------------------------------------------


class ComponentLineIn(BaseModel):
    ingredient_id: int | None = None
    preparation_id: int | None = None
    qty: str = Field(min_length=1)
    unit: str = Field(min_length=1)

    @model_validator(mode="after")
    def _exactly_one_component(self) -> "ComponentLineIn":
        if (self.ingredient_id is None) == (self.preparation_id is None):
            raise ValueError(
                "cada línea necesita exactamente un ingredient_id o un preparation_id, no los dos ni ninguno"
            )
        return self


class ComponentLineOut(BaseModel):
    ingredient_id: int | None
    ingredient_name: str | None
    preparation_id: int | None
    preparation_name: str | None
    qty: str
    unit: str


# ---------------------------------------------------------------------------
# Preparaciones — admin
# ---------------------------------------------------------------------------


class PreparationIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    mode: PrepModeLiteral = "exploded"
    standard_yield_qty: str = Field(min_length=1)
    standard_yield_unit: Literal["g", "ml", "unit"]
    process_loss_pct: int = Field(default=0, ge=0, le=100)
    shelf_life_days: int | None = Field(default=None, ge=0)
    lines: list[ComponentLineIn] = Field(default_factory=list)


class PreparationUpdateIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    standard_yield_qty: str | None = None
    standard_yield_unit: Literal["g", "ml", "unit"] | None = None
    process_loss_pct: int | None = Field(default=None, ge=0, le=100)
    shelf_life_days: int | None = Field(default=None, ge=0)
    lines: list[ComponentLineIn] | None = None
    active: bool | None = None


class PreparationModeIn(BaseModel):
    mode: PrepModeLiteral
    authorizer_pin: str | None = None


class PreparationAdminOut(BaseModel):
    id: int
    name: str
    mode: PrepModeLiteral
    standard_yield_qty: str
    standard_yield_unit: str
    process_loss_pct: int
    shelf_life_days: int | None
    active: bool
    current_stock: str | None  # sólo tiene sentido en modo batch; null en exploded
    unit_cost: str | None  # texto decimal en pesos, precisión completa (format_cost_micros)
    cost_source: str
    lines: list[ComponentLineOut]


# ---------------------------------------------------------------------------
# Preparaciones — dispositivo (POS/cocina, producción rápida). SIN costo.
# ---------------------------------------------------------------------------


class PreparationDeviceOut(BaseModel):
    id: int
    name: str
    mode: PrepModeLiteral
    prefilled_qty: str  # = standard_yield_qty, precargada en la pantalla de producción
    standard_yield_unit: str
    shelf_life_days: int | None


class ProduceIn(BaseModel):
    qty_expected: str = Field(min_length=1)
    qty_real: str = Field(min_length=1)
    employee_pin: str = Field(min_length=4, max_length=4)
    note: str | None = None


class ProduceOut(BaseModel):
    id: int
    preparation_id: int
    qty_expected: str
    qty_real: str
    unit: str
    variance_pct: str
    variance_alert: bool
    expiry_date: date | None
    produced_at: datetime


class PrepBatchAdminOut(BaseModel):
    id: int
    preparation_id: int
    qty_expected: str
    qty_real: str
    unit: str
    variance_pct: str
    variance_alert: bool
    total_cost: str | None  # texto decimal en pesos, precisión completa (format_cost_micros)
    unit_cost: str | None  # ídem
    cost_source: str
    expiry_date: date | None
    produced_by_employee_id: int
    produced_by_employee_name: str
    produced_at: datetime
    note: str | None
    closed_at: datetime | None
    closed_reason: str | None


# ---------------------------------------------------------------------------
# Fichas técnicas de los platos
# ---------------------------------------------------------------------------


class ProductRecipeIn(BaseModel):
    version: int = Field(ge=0)  # versión que el cliente cree vigente (bloqueo optimista)
    lines: list[ComponentLineIn] = Field(min_length=1)


class ProductRecipeOut(BaseModel):
    product_id: int
    version: int
    theoretical_cost: str | None  # texto decimal en pesos, precisión completa (format_cost_micros)
    cost_source: str
    food_cost_pct: Decimal | None
    net_price: int
    lines: list[ComponentLineOut]


# ---------------------------------------------------------------------------
# `recipe_effect` de las opciones de modificador
# ---------------------------------------------------------------------------


class RecipeEffectLineIn(ComponentLineIn):
    replaces_ingredient_id: int | None = None
    replaces_preparation_id: int | None = None

    @model_validator(mode="after")
    def _replaces_at_most_one(self) -> "RecipeEffectLineIn":
        if self.replaces_ingredient_id is not None and self.replaces_preparation_id is not None:
            raise ValueError("replaces_ingredient_id y replaces_preparation_id son excluyentes")
        return self


class RecipeEffectIn(BaseModel):
    effect: RecipeEffectLiteral
    lines: list[RecipeEffectLineIn] = Field(min_length=1)

    @model_validator(mode="after")
    def _replace_needs_target(self) -> "RecipeEffectIn":
        for line in self.lines:
            has_target = line.replaces_ingredient_id is not None or line.replaces_preparation_id is not None
            if self.effect == "replace" and not has_target:
                raise ValueError(
                    'con effect="replace" cada línea necesita replaces_ingredient_id o '
                    "replaces_preparation_id: qué componente de la ficha base reemplaza"
                )
            if self.effect != "replace" and has_target:
                raise ValueError('replaces_ingredient_id/replaces_preparation_id sólo aplican con effect="replace"')
        return self


class RecipeEffectLineOut(ComponentLineOut):
    replaces_ingredient_id: int | None
    replaces_preparation_id: int | None


class RecipeEffectOut(BaseModel):
    modifier_option_id: int
    effect: RecipeEffectLiteral
    lines: list[RecipeEffectLineOut]


# ---------------------------------------------------------------------------
# Validaciones y cobertura
# ---------------------------------------------------------------------------


class CoverageItemOut(BaseModel):
    product_id: int
    product_name: str | None
    items_sold: int
    qty_sold: int


class SuspiciousLineOut(BaseModel):
    product_id: int
    product_name: str | None
    ingredient_id: int
    ingredient_name: str | None
    qty: str
    unit: str
    reason: str
