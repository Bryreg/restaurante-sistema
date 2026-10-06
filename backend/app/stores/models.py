"""Organización → sede: la raíz de todo (SPEC-NEGOCIO §1.1).

Toda tabla de este módulo que cuelga de una sede lleva `store_id` (y, cuando
hace falta filtrar sin hacer join, `organization_id` también) con índice: toda
consulta se acota por organización y sede, y un id ajeno es `404` — nunca un
"no lo veo en la lista".
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
)
from sqlalchemy import Enum as SAEnum
from sqlalchemy import (
    ForeignKey,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UTCDateTime

PROFILE_VALUES = ("basic", "standard", "full")
PERSON_TYPE_VALUES = ("natural", "legal")
REGIME_VALUES = ("ordinary", "simple")
TAX_CODE_VALUES = ("inc_8", "iva_19", "excluded")


class Organization(Base):
    __tablename__ = "organizations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    profile: Mapped[str] = mapped_column(
        SAEnum(*PROFILE_VALUES, name="organization_profile", native_enum=False, length=16),
        nullable=False,
        default="standard",
    )
    declared_not_obliged_at: Mapped[datetime | None] = mapped_column(
        UTCDateTime(), nullable=True
    )
    declared_not_obliged_by: Mapped[str | None] = mapped_column(String(200), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)


class Store(Base):
    __tablename__ = "stores"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    nit: Mapped[str | None] = mapped_column(String(20), nullable=True)
    dv: Mapped[str | None] = mapped_column(String(2), nullable=True)
    legal_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    address: Mapped[str | None] = mapped_column(String(300), nullable=True)
    municipality_dane: Mapped[str | None] = mapped_column(String(6), nullable=True)
    opening_hours: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False, default=list)
    cutoff_hour: Mapped[int] = mapped_column(Integer, nullable=False, default=6)
    active_channels: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    store_pin_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)


class StoreFiscalConfig(Base):
    """Configuración fiscal versionada: la vigente es la de mayor `valid_from`
    que sea `<=` a la fecha de negocio consultada (SPEC-NEGOCIO §8.1)."""

    __tablename__ = "store_fiscal_configs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), nullable=False, index=True)
    valid_from: Mapped[date] = mapped_column(Date, nullable=False)
    person_type: Mapped[str] = mapped_column(
        SAEnum(*PERSON_TYPE_VALUES, name="fiscal_person_type", native_enum=False, length=16),
        nullable=False,
    )
    regime: Mapped[str] = mapped_column(
        SAEnum(*REGIME_VALUES, name="fiscal_regime", native_enum=False, length=16), nullable=False
    )
    franchise: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    inc_responsible: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    iva_responsible: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    rut_codes: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    price_includes_tax: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    default_tax: Mapped[str] = mapped_column(
        SAEnum(*TAX_CODE_VALUES, name="tax_code", native_enum=False, length=16),
        nullable=False,
        default="inc_8",
    )
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)


class StoreCashSettings(Base):
    __tablename__ = "store_cash_settings"

    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), primary_key=True)
    # LEGADO (sin uso): la base fija con que abría el cajón antes de la
    # apertura «igual al café». Ya no se lee ni se escribe; la columna queda
    # porque no se migra. Los turnos viejos congelaron la suya en
    # `Shift.opening_fixed_base`.
    opening_cash_fixed: Mapped[int] = mapped_column(Integer, nullable=False, default=200_000)
    # **Monto fijo de la base de respaldo** (2026-09-26). El nombre viene de
    # cuando era «la reserva por defecto» que se declaraba al abrir; hoy es
    # la plata aparte del cajón que el custodio verifica y de la que el
    # cajero toma prestado con autorización (`app.shifts.reserve`).
    cash_reserve_default: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # LEGADO (sin uso): cómo abría el cajón la sede cuando había dos reglas
    # (`envelopes` o `fixed_base`). Hoy hay una sola, «igual al café»
    # (`app.shifts.service.open_shift`), y esta columna ya no se lee ni se
    # escribe; queda porque no se migra. La regla con que abrió CADA turno
    # sigue en `Shift.opening_mode`.
    opening_mode: Mapped[str] = mapped_column(String(16), nullable=False, default="fixed_base", server_default="fixed_base")
    tolerance_unknown_cause: Mapped[int] = mapped_column(Integer, nullable=False, default=20_000)
    critical_difference: Mapped[int] = mapped_column(Integer, nullable=False, default=100_000)
    cash_pickup_threshold: Mapped[int] = mapped_column(Integer, nullable=False, default=500_000)
    petty_cash_limit: Mapped[int] = mapped_column(Integer, nullable=False, default=50_000)
    # Única fuente de la foto obligatoria (la función `cash.photo_required`
    # se retiró y se plegó acá: `app.stores.service.fold_legacy_photo_flag`).
    photo_required_on_close: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    photo_required_on_pickup: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    streak_alert_shifts: Mapped[int] = mapped_column(Integer, nullable=False, default=3)
    # Días que la plata de un cierre puede quedarse sin consignar antes del
    # aviso ámbar de Dinero › Plata en mano (0035).
    deposit_overdue_days: Mapped[int] = mapped_column(Integer, nullable=False, default=3, server_default="3")
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)


class StoreSalesSettings(Base):
    __tablename__ = "store_sales_settings"

    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), primary_key=True)
    tip_suggested_pct: Mapped[Any] = mapped_column(Numeric(5, 2), nullable=False, default=10)
    discount_limit_pct: Mapped[Any] = mapped_column(Numeric(5, 2), nullable=False, default=10)
    discount_daily_limit_pct: Mapped[Any] = mapped_column(Numeric(5, 2), nullable=False, default=5)
    courtesy_shift_limit: Mapped[int] = mapped_column(Integer, nullable=False, default=5)
    payment_methods: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False, default=list)
    void_reasons: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    discount_reasons: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    courtesy_reasons: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    courses: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    stations: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    course_target_minutes: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    # SPEC-NEGOCIO §8.3: factura electrónica cuando el neto supera este
    # umbral (en UVT) y el cliente está identificado (pedido 1b-2,
    # `app.fiscal.service.resolve_document_type_for_payment`). Default 5 UVT.
    invoice_threshold_uvt: Mapped[int] = mapped_column(Integer, nullable=False, default=5)
    # Los supuestos del panel del dueño (0032): las rayas de referencia de
    # «barra + raya» que no son un hecho sino una decisión del dueño. Viven
    # acá, por sede, para que el panel no tenga cifras quemadas. El umbral de
    # retiro NO está acá: es `StoreCashSettings.cash_pickup_threshold`.
    # Margen bruto meta por categoría, en por ciento entero (65 = 65 %).
    margin_target_pct: Mapped[int] = mapped_column(Integer, nullable=False, default=65, server_default="65")
    # Una mesa abierta más de esto es «mesa larga» (minutos).
    long_table_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=60, server_default="60")
    # Un tiquete de cocina con más de esto está demorado (minutos).
    late_ticket_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=20, server_default="20")
    # Cuántas comandas por hora alcanza a atender un mesero: la capacidad
    # del salón es meseros en turno × esto.
    orders_per_waiter: Mapped[int] = mapped_column(Integer, nullable=False, default=7, server_default="7")
    # Configurable desde el panel (0035). Objetivo de cocina por estación
    # (`{"bar": 5}`); `{}` o una estación ausente = el de fábrica
    # (`app.kitchen.service.DEFAULT_STATION_TARGET_MINUTES`).
    station_target_minutes: Mapped[dict[str, Any]] = mapped_column(
        JSON, nullable=False, default=dict, server_default="{}"
    )
    # Notas rápidas del POS por curso (`{"beverage": ["Sin hielo"], "_default":
    # [...]}`); un curso ausente usa las de fábrica.
    quick_notes: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict, server_default="{}")
    # Sesión de la persona y bloqueo del PIN; `NULL` = el de la variable de
    # entorno (`app.core.config`).
    employee_session_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    pin_lock_attempts: Mapped[int | None] = mapped_column(Integer, nullable=True)
    pin_lock_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Debajo de cuántas comandas un porcentaje de Informes es muestra chica.
    period_low_base_orders: Mapped[int] = mapped_column(Integer, nullable=False, default=20, server_default="20")
    daily_low_base_orders: Mapped[int] = mapped_column(Integer, nullable=False, default=5, server_default="5")
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)


class UvtValue(Base):
    """Por organización: aunque el valor real es el mismo para todo el país,
    cada organización mantiene su propia copia para no violar el aislamiento
    (un admin de una organización no debe poder cambiar lo que ve otra)."""

    __tablename__ = "uvt_values"
    __table_args__ = (UniqueConstraint("organization_id", "year", name="uq_uvt_values_org_year"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id"), nullable=False, index=True
    )
    year: Mapped[int] = mapped_column(Integer, nullable=False)
    value: Mapped[int] = mapped_column(Integer, nullable=False)


class Zone(Base):
    __tablename__ = "zones"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class Table(Base):
    __tablename__ = "tables"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    zone_id: Mapped[int] = mapped_column(ForeignKey("zones.id"), nullable=False, index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), nullable=False, index=True)
    number: Mapped[str] = mapped_column(String(20), nullable=False)
    seats: Mapped[int] = mapped_column(Integer, nullable=False, default=4)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class FeatureState(Base):
    """Override de un flag, a nivel de organización (`store_id is None`) o de
    una sede puntual. Lo que no tiene fila acá usa el default del perfil.

    Legado: puede haber filas de claves retiradas del catálogo
    (`multi_store`, `cash.photo_required`, ver
    `app.core.features.RETIRED_FEATURE_KEYS`). No se borran (sin migración);
    `enabled_map` las ignora, y la de `cash.photo_required` a nivel de sede
    sólo marca que la foto vieja ya se plegó en `StoreCashSettings`."""

    __tablename__ = "feature_states"
    __table_args__ = (
        UniqueConstraint("organization_id", "store_id", "key", name="uq_feature_states_scope"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id"), nullable=False, index=True
    )
    store_id: Mapped[int | None] = mapped_column(ForeignKey("stores.id"), nullable=True, index=True)
    key: Mapped[str] = mapped_column(String(64), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    updated_by: Mapped[str | None] = mapped_column(String(200), nullable=True)
