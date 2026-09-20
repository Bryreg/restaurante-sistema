"""Esquemas de la carta plana. `schedule` viaja como `dict[str, Any]` (no como
un modelo Pydantic con alias) porque su clave `"from"` es palabra reservada de
Python; `service.validate_schedule` es quien lo valida de verdad.

Ningún esquema de este módulo tiene un campo `cost`, `margin` ni `unit_cost`
(checklist del pedido 1a) — ni lo va a tener hasta que `catalog.recipes`
(fase 2) lo agregue explícitamente.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

TaxCode = Literal["inc_8", "iva_19", "excluded"]


# ---------------------------------------------------------------------------
# Categorías
# ---------------------------------------------------------------------------


class CategoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=150)
    sort_order: int = 0
    default_course: str | None = None
    default_station: str | None = None


class CategoryUpdateIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=150)
    sort_order: int | None = None
    default_course: str | None = None
    default_station: str | None = None
    active: bool | None = None


class CategoryOut(BaseModel):
    id: int
    name: str
    sort_order: int
    default_course: str | None
    default_station: str | None
    active: bool


# ---------------------------------------------------------------------------
# Productos
# ---------------------------------------------------------------------------


class ProductPricesIn(BaseModel):
    dine_in: int = Field(ge=0)
    takeout: int | None = Field(default=None, ge=0)
    delivery: int | None = Field(default=None, ge=0)
    platform: int | None = Field(default=None, ge=0)


class ProductPricesRawOut(BaseModel):
    """Lo que hay guardado, sin resolver el canal opcional (lo usa el admin
    para saber qué tiene precio propio y qué va a caer al de mesa)."""

    dine_in: int
    takeout: int | None
    delivery: int | None
    platform: int | None


class ProductPricesResolvedOut(BaseModel):
    """Lo que ve quien vende: todo canal resuelto, nunca `null` (SPEC-NEGOCIO
    §4.3: "para llevar, domicilio y plataforma opcionales, caen al de mesa")."""

    dine_in: int
    takeout: int
    delivery: int
    platform: int


class ProductIn(BaseModel):
    category_id: int
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None
    station: str | None = None
    default_course: str | None = None
    prices: ProductPricesIn
    tax_code: TaxCode | None = None
    daily_count: int | None = Field(default=None, ge=0)
    # Pedido 2c: marca este producto como EL cargo de domicilio de la sede
    # (§4.3). A lo sumo uno activo por sede — `create_product` corta con
    # `409 DELIVERY_FEE_ALREADY_CONFIGURED` si ya hay otro.
    is_delivery_fee: bool = False


class ProductUpdateIn(BaseModel):
    category_id: int | None = None
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    station: str | None = None
    default_course: str | None = None
    prices: ProductPricesIn | None = None
    tax_code: TaxCode | None = None
    active: bool | None = None
    is_delivery_fee: bool | None = None


class ModifierOptionIn(BaseModel):
    # `id` presente = actualiza la opción existente; ausente = opción nueva.
    id: int | None = None
    name: str = Field(min_length=1, max_length=150)
    price_delta: int = 0


class ModifierOptionOut(BaseModel):
    id: int
    name: str
    price_delta: int
    available: bool


class ModifierGroupIn(BaseModel):
    name: str = Field(min_length=1, max_length=150)
    required: bool = False
    min: int = Field(default=0, ge=0)
    max: int = Field(default=1, ge=0)
    sort_order: int = 0
    options: list[ModifierOptionIn] = []


class ModifierGroupUpdateIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=150)
    required: bool | None = None
    min: int | None = Field(default=None, ge=0)
    max: int | None = Field(default=None, ge=0)
    sort_order: int | None = None
    # Si viene, reemplaza el conjunto completo de opciones del grupo (las que
    # no aparecen se dan de baja lógica: quedan `available=False`).
    options: list[ModifierOptionIn] | None = None


class ModifierGroupOut(BaseModel):
    id: int
    product_id: int
    name: str
    required: bool
    min: int
    max: int
    sort_order: int
    options: list[ModifierOptionOut]


class ProductAdminOut(BaseModel):
    id: int
    category_id: int
    name: str
    description: str | None
    station: str | None
    default_course: str | None
    prices: ProductPricesRawOut
    tax_code: TaxCode
    active: bool
    available: bool
    daily_count: int | None
    daily_remaining: int | None
    is_delivery_fee: bool
    modifier_groups: list[ModifierGroupOut] = []


class CatalogProductOut(BaseModel):
    id: int
    category_id: int
    name: str
    description: str | None
    station: str | None
    default_course: str | None
    prices: ProductPricesResolvedOut
    tax_code: TaxCode
    available: bool
    daily_count: int | None = None
    daily_remaining: int | None = None
    modifier_groups: list[ModifierGroupOut] = []


class ProductAvailabilityIn(BaseModel):
    available: bool
    daily_count: int | None = Field(default=None, ge=0)


class OptionAvailabilityIn(BaseModel):
    available: bool


# ---------------------------------------------------------------------------
# Combos y menú del día
# ---------------------------------------------------------------------------


class ComboOptionIn(BaseModel):
    id: int | None = None
    product_id: int


class ComboOptionOut(BaseModel):
    id: int
    name: str  # nombre del producto enlazado (la opción no tiene nombre propio)
    product_id: int
    available_today: bool


class ComboGroupIn(BaseModel):
    # `id` presente = actualiza el grupo existente (y hace upsert de sus
    # opciones); ausente = grupo nuevo. Es la misma convención que
    # `ModifierOptionIn`/`ComboOptionIn`.
    id: int | None = None
    name: str = Field(min_length=1, max_length=150)
    sort_order: int = 0
    options: list[ComboOptionIn] = []


class ComboGroupOut(BaseModel):
    id: int
    name: str
    sort_order: int
    options: list[ComboOptionOut]


class ComboIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    price: int = Field(ge=0)
    active: bool = True
    schedule: dict[str, Any]
    groups: list[ComboGroupIn] = []


class ComboUpdateIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    price: int | None = Field(default=None, ge=0)
    active: bool | None = None
    schedule: dict[str, Any] | None = None
    # Si viene, reemplaza todos los grupos (y sus opciones) del combo.
    groups: list[ComboGroupIn] | None = None


class ComboOptionAdminOut(ComboOptionOut):
    # Sólo la vista de admin expone `active_today`: es lo que pinta el
    # checklist de "armar el menú de hoy"; `GET /catalog` ya filtra por él,
    # así que no hace falta repetirlo ahí (el contrato no lo lista).
    active_today: bool


class ComboGroupAdminOut(BaseModel):
    id: int
    name: str
    sort_order: int
    options: list[ComboOptionAdminOut]


class ComboAdminOut(BaseModel):
    id: int
    name: str
    price: int
    active: bool
    active_now: bool
    schedule: dict[str, Any]
    groups: list[ComboGroupAdminOut]


class CatalogComboOut(BaseModel):
    id: int
    name: str
    price: int
    active_now: bool
    schedule: dict[str, Any]
    groups: list[ComboGroupOut]


class ComboTodayIn(BaseModel):
    active_option_ids: list[int] = []


# ---------------------------------------------------------------------------
# GET /catalog
# ---------------------------------------------------------------------------


class CatalogOut(BaseModel):
    categories: list[CategoryOut]
    products: list[CatalogProductOut]
    combos: list[CatalogComboOut]
