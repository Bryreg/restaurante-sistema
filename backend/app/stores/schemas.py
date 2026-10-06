"""Esquemas de organización, funciones, sede y su configuración."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


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


class PosProfileOut(BaseModel):
    key: str
    label: str
    description: str
    flags: dict[str, bool]


class PosProfileSetIn(BaseModel):
    profile: Literal["mostrador", "mesa", "mixto"]
    store_id: int | None = None


class PosProfileAppliedOut(BaseModel):
    profile: str
    changed: list[str]
    # Funciones fuera del perfil que se apagaron porque dependían de algo que
    # el perfil apagó (p. ej. `pos.seats` sin `pos.tables`).
    turned_off_dependents: list[str]


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
    # `opening_cash_fixed` y `opening_mode` ya no se configuran: hay una sola
    # manera de abrir el cajón («igual al café», con los días por consignar
    # que están en él). Un cliente viejo que los mande no cambia nada: se
    # ignoran. La base de respaldo es `cash_reserve_default`.
    cash_reserve_default: int = Field(ge=0)
    tolerance_unknown_cause: int = Field(ge=0)
    critical_difference: int = Field(ge=0)
    cash_pickup_threshold: int = Field(ge=0)
    petty_cash_limit: int = Field(ge=0)
    photo_required_on_close: bool
    photo_required_on_pickup: bool
    streak_alert_shifts: int = Field(ge=1)
    # Días de plata de cierres sin consignar antes del aviso (0035). Sin el
    # campo, la sede conserva el que tenía.
    deposit_overdue_days: int | None = Field(default=None, ge=1, le=60)


class CashSettingsOut(CashSettingsIn):
    deposit_overdue_days: int | None = 3


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
    # Los supuestos del panel (0032). Opcionales al guardar: sin ellos la
    # sede conserva los que tenía (un cliente escrito antes de estos campos
    # no los vuelve al default sin querer).
    margin_target_pct: int | None = Field(default=None, ge=0, le=100)
    long_table_minutes: int | None = Field(default=None, ge=1, le=1440)
    late_ticket_minutes: int | None = Field(default=None, ge=1, le=1440)
    orders_per_waiter: int | None = Field(default=None, ge=1, le=100)
    # Configurables desde el panel (0035). Opcionales al guardar: un campo
    # que NO viene en el cuerpo deja la sede como estaba
    # (`CONFIG_FIELDS_KEPT_WHEN_ABSENT`). En los tres de seguridad, `null`
    # explícito vuelve al valor de la variable de entorno.
    # Objetivo de cocina por estación, en minutos (KDS).
    station_target_minutes: dict[str, int] | None = None
    # Notas rápidas del POS por curso; `_default` es la lista para el resto.
    quick_notes: dict[str, list[str]] | None = None
    employee_session_minutes: int | None = Field(default=None, ge=1, le=240)
    pin_lock_attempts: int | None = Field(default=None, ge=2, le=20)
    pin_lock_minutes: int | None = Field(default=None, ge=1, le=1440)
    # Debajo de cuántas comandas un porcentaje de Informes es muestra chica.
    period_low_base_orders: int | None = Field(default=None, ge=1, le=10_000)
    daily_low_base_orders: int | None = Field(default=None, ge=1, le=1_000)

    @field_validator("station_target_minutes")
    @classmethod
    def _station_minutes_in_range(cls, value: dict[str, int] | None) -> dict[str, int] | None:
        if value is None:
            return value
        for station, minutes in value.items():
            if not 1 <= minutes <= 240:
                raise ValueError(f"el objetivo de «{station}» tiene que estar entre 1 y 240 minutos")
        return value

    @field_validator("quick_notes")
    @classmethod
    def _quick_notes_short(cls, value: dict[str, list[str]] | None) -> dict[str, list[str]] | None:
        if value is None:
            return value
        clean: dict[str, list[str]] = {}
        for course, notes in value.items():
            items = [n.strip() for n in notes if n.strip()]
            if len(items) > 8:
                raise ValueError(f"«{course}» tiene más de 8 notas rápidas: el POS muestra hasta 8")
            if any(len(n) > 40 for n in items):
                raise ValueError(f"una nota rápida de «{course}» pasa de 40 caracteres")
            clean[course] = items
        return clean


#: Los campos de `SalesSettingsIn` que se conservan cuando llegan vacíos.
PANEL_ASSUMPTION_FIELDS = ("margin_target_pct", "long_table_minutes", "late_ticket_minutes", "orders_per_waiter")

#: Los campos de 0035: se conservan cuando NO vienen en el cuerpo (un
#: `null` explícito en los de seguridad sí se guarda: vuelve al de entorno).
CONFIG_FIELDS_KEPT_WHEN_ABSENT = (
    "station_target_minutes",
    "quick_notes",
    "employee_session_minutes",
    "pin_lock_attempts",
    "pin_lock_minutes",
    "period_low_base_orders",
    "daily_low_base_orders",
)
#: De esos, los que nunca se guardan en `null` (la columna no lo admite).
CONFIG_FIELDS_NOT_NULL = ("station_target_minutes", "quick_notes", "period_low_base_orders", "daily_low_base_orders")


class SalesSettingsOut(SalesSettingsIn):
    margin_target_pct: int = 65
    long_table_minutes: int = 60
    late_ticket_minutes: int = 20
    orders_per_waiter: int = 7
    # Lo que rige, ya resuelto contra los de fábrica.
    station_target_minutes: dict[str, int] = {}
    quick_notes: dict[str, list[str]] = {}
    period_low_base_orders: int = 20
    daily_low_base_orders: int = 5
    # Los valores de la variable de entorno que rigen mientras el de la sede
    # esté en `null` (la pantalla los muestra como sugerencia).
    employee_session_minutes_default: int = 3
    pin_lock_attempts_default: int = 5
    pin_lock_minutes_default: int = 15


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
