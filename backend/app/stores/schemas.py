"""Esquemas de organización, funciones, sede y su configuración."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class OrganizationOut(BaseModel):
    id: int
    name: str
    profile: str
    declared_not_obliged_to_invoice: dict[str, Any] | None = None


class OrganizationUpdateIn(BaseModel):
    name: str


class FeatureOut(BaseModel):
    key: str
    description: str
    enabled: bool
    source: Literal["org", "store_override", "profile_default"]
    requires: list[str]
    available_from_phase: str


class FeatureSetIn(BaseModel):
    enabled: bool
    store_id: int | None = None


class ProfileSetIn(BaseModel):
    profile: Literal["basic", "standard", "full"]


class OpeningHourIn(BaseModel):
    weekday: int = Field(ge=0, le=6)
    open: str
    close: str


class StoreCreateIn(BaseModel):
    name: str
    nit: str | None = None
    dv: str | None = None
    legal_name: str | None = None
    address: str | None = None
    municipality_dane: str | None = None
    opening_hours: list[OpeningHourIn] = []
    cutoff_hour: int = 6
    active_channels: list[str] = []
    store_pin: str = Field(min_length=4, max_length=8, pattern=r"^\d+$")


class StoreUpdateIn(BaseModel):
    name: str | None = None
    nit: str | None = None
    dv: str | None = None
    legal_name: str | None = None
    address: str | None = None
    municipality_dane: str | None = None
    opening_hours: list[OpeningHourIn] | None = None
    cutoff_hour: int | None = None
    active_channels: list[str] | None = None


class StoreOut(BaseModel):
    id: int
    name: str
    nit: str | None
    dv: str | None
    legal_name: str | None
    address: str | None
    municipality_dane: str | None
    opening_hours: list[dict[str, Any]]
    cutoff_hour: int
    active_channels: list[str]
    active: bool


class RotatePinIn(BaseModel):
    new_pin: str = Field(min_length=4, max_length=8, pattern=r"^\d+$")


class FiscalIn(BaseModel):
    # Optional a nivel de esquema para poder devolver el código de negocio
    # `FISCAL_VALID_FROM_REQUIRED` en vez de un `VALIDATION_ERROR` genérico.
    valid_from: date | None = None
    person_type: Literal["natural", "legal"]
    regime: Literal["ordinary", "simple"]
    franchise: bool = False
    inc_responsible: bool = True
    iva_responsible: bool = False
    rut_codes: list[str] = []
    price_includes_tax: bool = True
    default_tax: Literal["inc_8", "iva_19", "excluded"] = "inc_8"


class FiscalOut(FiscalIn):
    id: int
    valid_from: date  # siempre presente en lo que ya quedó guardado


class CashSettingsIn(BaseModel):
    opening_cash_fixed: int = Field(ge=0)
    cash_reserve_default: int = Field(ge=0)
    tolerance_unknown_cause: int = Field(ge=0)
    tolerance_identified_cause: int = Field(ge=0)
    critical_difference: int = Field(ge=0)
    cash_pickup_threshold: int = Field(ge=0)
    petty_cash_limit: int = Field(ge=0)
    photo_required_on_close: bool
    photo_required_on_pickup: bool
    streak_alert_shifts: int = Field(ge=1)


class CashSettingsOut(CashSettingsIn):
    pass


class PaymentMethodIn(BaseModel):
    code: str
    label: str
    dian_code: str
    enabled: bool = True
    requires_reference: bool = False


class SalesSettingsIn(BaseModel):
    # El tope de 10% NO se valida acá con `le=10`: tiene que devolver el código
    # de negocio `TIP_PCT_OVER_LIMIT` (no un `VALIDATION_ERROR` genérico).
    tip_suggested_pct: float = Field(ge=0)
    discount_limit_pct: float = Field(ge=0, le=100)
    discount_daily_limit_pct: float = Field(ge=0, le=100)
    courtesy_shift_limit: int = Field(ge=0)
    payment_methods: list[PaymentMethodIn]
    void_reasons: list[str]
    discount_reasons: list[str]
    courtesy_reasons: list[str]
    courses: list[str]
    stations: list[str]
    course_target_minutes: dict[str, int]
    # SPEC-NEGOCIO §8.3: factura electrónica automática cuando el neto de la
    # venta supera `invoice_threshold_uvt` × UVT del año y el cliente está
    # identificado (pedido 1b-2). Lleva default porque es un campo NUEVO sobre
    # una entrada que ya existía: sin él, cualquier cuerpo escrito contra el
    # contrato de 1b-1 muere en la validación de Pydantic ANTES de llegar a la
    # regla de negocio, y devuelve `VALIDATION_ERROR` en vez del código que
    # nombra la acción correctiva (AGENTS.md). El valor coincide con el de la
    # columna (`StoreSalesSettings.invoice_threshold_uvt`).
    invoice_threshold_uvt: int = Field(default=5, ge=1)


class SalesSettingsOut(SalesSettingsIn):
    pass


class UvtEntry(BaseModel):
    year: int
    value: int


class ZoneCreateIn(BaseModel):
    name: str
    sort_order: int = 0


class ZoneUpdateIn(BaseModel):
    name: str | None = None
    sort_order: int | None = None
    active: bool | None = None


class ZoneOut(BaseModel):
    id: int
    store_id: int
    name: str
    sort_order: int
    active: bool


class TableCreateIn(BaseModel):
    zone_id: int
    number: str
    seats: int = 4


class TableUpdateIn(BaseModel):
    zone_id: int | None = None
    number: str | None = None
    seats: int | None = None
    active: bool | None = None


class TableOut(BaseModel):
    id: int
    zone_id: int
    store_id: int
    number: str
    seats: int
    active: bool


class DeviceTableOut(BaseModel):
    id: int
    zone_id: int
    zone_name: str
    number: str
    seats: int
    status: Literal["free", "open", "to_pay"]
    open_order_id: int | None = None
    open_since: datetime | None = None
    total: int | None = None
    covers: int | None = None
