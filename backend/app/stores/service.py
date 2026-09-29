"""Defaults de sede: la configuración de caja y de ventas existen apenas se
piden por primera vez (nunca un `404` porque nadie las tocó todavía), y la
fiscal vigente es la de mayor `valid_from <= fecha` (SPEC-NEGOCIO §8.1).
"""

from __future__ import annotations

from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import clock
from app.core.config import settings
from app.stores.models import StoreCashSettings, StoreFiscalConfig, StoreSalesSettings

DEFAULT_PAYMENT_METHODS: list[dict[str, object]] = [
    {"code": "cash", "label": "Efectivo", "dian_code": "10", "enabled": True, "requires_reference": False},
    {"code": "card", "label": "Datáfono", "dian_code": "48", "enabled": True, "requires_reference": False},
    {
        "code": "transfer",
        "label": "Transferencia / QR",
        "dian_code": "20",
        "enabled": True,
        "requires_reference": True,
    },
]
DEFAULT_VOID_REASONS = [
    "customer_changed_mind",
    "server_error",
    "kitchen_error",
    "long_wait",
    "walkout",
    "duplicate",
    "other",
]
DEFAULT_DISCOUNT_REASONS = ["promo", "complaint", "owner", "employee", "other"]
DEFAULT_COURTESY_REASONS = ["complaint", "promo_owner", "guest_of_owner", "other"]
DEFAULT_COURSES = ["beverage", "starter", "main", "dessert"]
DEFAULT_STATIONS = ["hot_kitchen", "cold_kitchen", "bar", "desserts", "none"]
DEFAULT_COURSE_TARGET_MINUTES: dict[str, int] = {"starter": 8, "main": 18, "dessert": 8}

#: Objetivo de cocina por estación de fábrica (antes sólo en
#: `app.kitchen.service`): rige mientras la sede no guarde el suyo en
#: Ajustes › Ventas › Estaciones (`station_target_minutes`, 0035).
DEFAULT_STATION_TARGET_MINUTES: dict[str, int] = {"bar": 5, "hot_kitchen": 15, "cold_kitchen": 10}

#: Notas rápidas del POS de fábrica, por curso (antes quemadas en
#: `frontend/src/features/orders/lib.ts`). `_default` es la lista para un
#: curso sin lista propia. La sede las cambia en Ajustes › Ventas.
QUICK_NOTES_DEFAULT_KEY = "_default"
DEFAULT_QUICK_NOTES: dict[str, list[str]] = {
    QUICK_NOTES_DEFAULT_KEY: ["Sin cebolla", "Sin sal", "Aparte", "Para llevar"],
    "beverage": ["Sin hielo", "Sin azúcar", "Al clima", "Para llevar"],
    "dessert": ["Sin azúcar", "Aparte", "Para compartir", "Para llevar"],
}


def station_targets(row: StoreSalesSettings) -> dict[str, int]:
    """Los objetivos por estación que rigen: los de fábrica pisados por los
    que la sede guardó."""
    return {**DEFAULT_STATION_TARGET_MINUTES, **{k: int(v) for k, v in (row.station_target_minutes or {}).items()}}


def quick_notes(row: StoreSalesSettings) -> dict[str, list[str]]:
    """Las notas rápidas que rigen, por curso (fábrica + las de la sede)."""
    return {**DEFAULT_QUICK_NOTES, **{k: list(v) for k, v in (row.quick_notes or {}).items()}}


def employee_session_minutes(db: Session, store_id: int | None) -> int:
    """Minutos de inactividad antes de pedir el PIN otra vez: el de la sede
    (Ajustes › Ventas › Seguridad) o, sin él, el de la variable de entorno."""
    if store_id is not None:
        row = db.get(StoreSalesSettings, store_id)
        if row is not None and row.employee_session_minutes:
            return int(row.employee_session_minutes)
    return settings.EMPLOYEE_SESSION_MINUTES


def pin_lock_policy(db: Session, store_id: int | None) -> tuple[int, int]:
    """`(intentos, minutos)` del bloqueo del PIN: los de la sede o, sin
    ellos, los de la variable de entorno."""
    attempts, minutes = settings.PIN_LOCK_ATTEMPTS, settings.PIN_LOCK_MINUTES
    if store_id is not None:
        row = db.get(StoreSalesSettings, store_id)
        if row is not None:
            attempts = int(row.pin_lock_attempts or attempts)
            minutes = int(row.pin_lock_minutes or minutes)
    return attempts, minutes


def get_cash_settings(db: Session, store_id: int) -> StoreCashSettings:
    row = db.get(StoreCashSettings, store_id)
    if row is None:
        row = StoreCashSettings(store_id=store_id, updated_at=clock.now_utc())
        db.add(row)
        db.flush()
    return row


def get_sales_settings(db: Session, store_id: int) -> StoreSalesSettings:
    row = db.get(StoreSalesSettings, store_id)
    if row is None:
        row = StoreSalesSettings(
            store_id=store_id,
            payment_methods=list(DEFAULT_PAYMENT_METHODS),
            void_reasons=list(DEFAULT_VOID_REASONS),
            discount_reasons=list(DEFAULT_DISCOUNT_REASONS),
            courtesy_reasons=list(DEFAULT_COURTESY_REASONS),
            courses=list(DEFAULT_COURSES),
            stations=list(DEFAULT_STATIONS),
            course_target_minutes=dict(DEFAULT_COURSE_TARGET_MINUTES),
            updated_at=clock.now_utc(),
        )
        db.add(row)
        db.flush()
    return row


def current_fiscal(db: Session, store_id: int, on: date | None = None) -> StoreFiscalConfig | None:
    target = on or clock.now_utc().date()
    stmt = (
        select(StoreFiscalConfig)
        .where(StoreFiscalConfig.store_id == store_id, StoreFiscalConfig.valid_from <= target)
        .order_by(StoreFiscalConfig.valid_from.desc())
        .limit(1)
    )
    return db.execute(stmt).scalars().first()
