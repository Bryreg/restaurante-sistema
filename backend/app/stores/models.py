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
    opening_cash_fixed: Mapped[int] = mapped_column(Integer, nullable=False, default=200_000)
    cash_reserve_default: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    tolerance_unknown_cause: Mapped[int] = mapped_column(Integer, nullable=False, default=20_000)
    tolerance_identified_cause: Mapped[int] = mapped_column(Integer, nullable=False, default=100_000)
    critical_difference: Mapped[int] = mapped_column(Integer, nullable=False, default=100_000)
    cash_pickup_threshold: Mapped[int] = mapped_column(Integer, nullable=False, default=500_000)
    petty_cash_limit: Mapped[int] = mapped_column(Integer, nullable=False, default=50_000)
    photo_required_on_close: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    photo_required_on_pickup: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    streak_alert_shifts: Mapped[int] = mapped_column(Integer, nullable=False, default=3)
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
    una sede puntual. Lo que no tiene fila acá usa el default del perfil."""

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
