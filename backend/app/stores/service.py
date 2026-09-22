"""Defaults de sede: la configuración de caja y de ventas existen apenas se
piden por primera vez (nunca un `404` porque nadie las tocó todavía), y la
fiscal vigente es la de mayor `valid_from <= fecha` (SPEC-NEGOCIO §8.1).
"""

from __future__ import annotations

import re
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import clock
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


# ---------------------------------------------------------------------------
# Referencias del salón (`zones.landmarks`)
# ---------------------------------------------------------------------------

#: Se guardan en una sola columna separadas por `|`. El separador es la barra
#: y no la coma porque una referencia real la lleva adentro: «Terraza, lado
#: norte».
LANDMARK_SEP = "|"


def landmarks_list(raw: str | None) -> list[str]:
    """La columna, partida en rótulos. Vacío es lo normal."""
    if not raw:
        return []
    return [p.strip() for p in raw.split(LANDMARK_SEP) if p.strip()]


def landmarks_raw(items: list[str]) -> str | None:
    """Los rótulos, listos para guardar. Un `|` tecleado adentro de un rótulo
    se cambia por espacio: si no, partiría el rótulo en dos al leerlo."""
    limpios = [i.strip().replace(LANDMARK_SEP, " ") for i in items if i.strip()]
    return LANDMARK_SEP.join(limpios) or None


# ---------------------------------------------------------------------------
# El orden del plano (`tables.number`)
# ---------------------------------------------------------------------------


def orden_natural(numero: str | None) -> tuple[object, ...]:
    """La clave para ordenar mesas por su número **como se leen**.

    `Table.number` es TEXTO —hay locales con «T1», «Barra», «Terraza 3»— y
    ordenarlo como texto pone la mesa 10 antes que la 2. Con nueve mesas no
    se nota; con doce, el plano arranca «1 2 3 4 10 11 12 5 …» y el mesero
    que busca la 7 la encuentra en el lugar equivocado. Apareció el día que
    la sede de demostración pasó de siete mesas a doce.

    Parte el texto en tramos de dígitos y de no-dígitos, y compara los
    tramos de dígitos como NÚMEROS. Así «T2» va antes que «T10», «Barra»
    queda con las letras, y no hace falta que el número sea sólo un entero.

    Cada tramo viaja con un `0`/`1` adelante para que Python nunca compare un
    `int` contra un `str` (`TypeError`) cuando dos mesas se llaman «3» y
    «T3»: primero manda el número, después la letra.
    """
    if not numero:
        return ((1, ""),)
    tramos: list[tuple[int, object]] = []
    for tramo in re.findall(r"\d+|\D+", numero):
        if tramo.isdigit():
            tramos.append((0, int(tramo)))
        else:
            tramos.append((1, tramo.strip().lower()))
    return tuple(tramos)
