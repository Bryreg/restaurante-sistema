"""Calendario legal de recargos (Colombia) con el que nace cada sede.

Cada vigencia es una FOTO completa de `SurchargeTable` (ver su docstring).
Las fechas son las de la ley, no aproximaciones a inicio de mes:

- **Jornada ordinaria semanal** (Ley 2101 de 2021, gradual el 15 de julio):
  48 h → 47 h (15-jul-2023) → 46 h (15-jul-2024) → 44 h (15-jul-2025)
  → 42 h (15-jul-2026).
- **Recargo dominical y festivo** (Ley 2466 de 2025, art. 14): 75 % →
  80 % (1-jul-2025) → 90 % (1-jul-2026) → 100 % (1-jul-2027).
- **Trabajo nocturno** (Ley 2466 de 2025, art. 10): de 21:00-06:00 pasa a
  19:00-06:00 el 25-dic-2025 (seis meses después de promulgada).
- **Recargo nocturno** 35 % (CST art. 168).
- **Hora extra diurna** 25 % y **hora extra nocturna** 75 % (CST art. 168).
  La extra nocturna NO es la suma de extra (25 %) + nocturno (35 %): la ley
  le fija su propio 75 %. Con eso, y sumando el dominical por encima, salen
  las ocho categorías del CST (HED 25, HEN 75, RN 35, RDF, HEDDF = RDF + 25,
  HENDF = RDF + 75, RNDF = RDF + 35).

Las filas sembradas quedan con `created_by_employee_id = NULL` («nadie las
confirmó»): la liquidación lo publica (A-4) hasta que el dueño las revise.
"""

from __future__ import annotations

from datetime import date
from typing import TypedDict

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import clock
from app.payroll.models import SurchargeTable
from app.stores.models import Store


class LegalVigencia(TypedDict):
    valid_from: date
    night_start_hour: int
    night_end_hour: int
    night_surcharge_bp: int
    sunday_holiday_surcharge_bp: int
    overtime_surcharge_bp: int
    night_overtime_surcharge_bp: int
    weekly_ordinary_hours: int


def _v(valid_from: date, *, night_start: int, sunday_bp: int, weekly: int) -> LegalVigencia:
    return LegalVigencia(
        valid_from=valid_from,
        night_start_hour=night_start,
        night_end_hour=6,
        night_surcharge_bp=3500,
        sunday_holiday_surcharge_bp=sunday_bp,
        overtime_surcharge_bp=2500,
        night_overtime_surcharge_bp=7500,
        weekly_ordinary_hours=weekly,
    )


LEGAL_SURCHARGE_CALENDAR: list[LegalVigencia] = [
    _v(date(2020, 1, 1), night_start=21, sunday_bp=7500, weekly=48),
    _v(date(2023, 7, 15), night_start=21, sunday_bp=7500, weekly=47),
    _v(date(2024, 7, 15), night_start=21, sunday_bp=7500, weekly=46),
    _v(date(2025, 7, 1), night_start=21, sunday_bp=8000, weekly=46),
    _v(date(2025, 7, 15), night_start=21, sunday_bp=8000, weekly=44),
    _v(date(2025, 12, 25), night_start=19, sunday_bp=8000, weekly=44),
    _v(date(2026, 7, 1), night_start=19, sunday_bp=9000, weekly=44),
    _v(date(2026, 7, 15), night_start=19, sunday_bp=9000, weekly=42),
    _v(date(2027, 7, 1), night_start=19, sunday_bp=10000, weekly=42),
]


def seed_store(db: Session, store: Store) -> int:
    """Siembra el calendario legal en una sede. No pisa nada: una fecha que
    ya tiene tabla (sembrada o cargada por una persona) se respeta. Devuelve
    cuántas vigencias agregó."""
    existing = set(
        db.execute(select(SurchargeTable.valid_from).where(SurchargeTable.store_id == store.id)).scalars()
    )
    now = clock.now_utc()
    added = 0
    for vig in LEGAL_SURCHARGE_CALENDAR:
        if vig["valid_from"] in existing:
            continue
        db.add(SurchargeTable(organization_id=store.organization_id, store_id=store.id, created_at=now, **vig))
        added += 1
    if added:
        db.flush()
    return added
