"""Mise en place con nivel par (0040).

Cada mañana la cocina necesita una lista: qué preparación producir, cuánto y
en cuántas tandas. Sale de tres números por preparación en modo lote:

- **lo que hay** según el libro (`current_stock`, el mismo que se cuenta);
- **el par**: cuánto debe haber al abrir, que lo fija el dueño o el chef;
- **lo que se viene usando**: el promedio diario de salidas de los últimos
  14 días operativos cerrados (sin los ajustes por conteo, que no son uso).

Producir = par − lo que hay (nunca negativo), redondeado hacia arriba a
tandas enteras de la receta estándar. Sin par no se pide producir nada: se
sugiere uno —un día de uso más 20 % de colchón— para que el chef lo fije.

Toda la cuenta vive acá; la pantalla sólo la muestra.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Literal

from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core import tz
from app.recipes import units
from app.recipes.models import Preparation, PrepMode
from app.stores.models import Store

WINDOW_DAYS = 14
SUGGESTED_CUSHION_PCT = 20


class MiseRowOut(BaseModel):
    preparation_id: int
    name: str
    unit: str
    stock: str
    par: str | None
    # Promedio diario de uso en la ventana; `None` = no se usó (nunca «0» mudo).
    avg_daily_use: str | None
    # Días que alcanza lo que hay al ritmo de uso; `None` sin uso o sin stock.
    days_of_cover: str | None
    to_produce: str | None
    batches: int | None
    batch_yield: str
    suggested_par: str | None
    shelf_life_days: int | None
    status: Literal["producir", "al_dia", "sin_par"]


class MiseOut(BaseModel):
    business_date: date
    window_from: date
    window_to: date
    to_produce_count: int
    rows: list[MiseRowOut]


def _q(qty_base: int, unit: str) -> str:
    return format(units.base_qty_to_decimal(qty_base, unit).normalize(), "f")


def mise_en_place(db: Session, *, store: Store) -> MiseOut:
    from app.inventory import hooks as inventory_hooks
    from app.inventory.models import MovementCause, StockMovement

    today = tz.today_business_date(store.cutoff_hour)
    window_from = today - timedelta(days=WINDOW_DAYS)
    window_to = today - timedelta(days=1)

    preps = list(
        db.execute(
            select(Preparation)
            .where(Preparation.store_id == store.id, Preparation.active.is_(True), Preparation.mode == PrepMode.BATCH)
            .order_by(Preparation.name)
        ).scalars()
    )
    used: dict[int, int] = {}
    if preps:
        for pid, total in db.execute(
            select(StockMovement.preparation_id, func.coalesce(func.sum(StockMovement.qty_base), 0))
            .where(
                StockMovement.store_id == store.id,
                StockMovement.preparation_id.in_([p.id for p in preps]),
                StockMovement.qty_base < 0,
                StockMovement.cause != MovementCause.COUNT_ADJUSTMENT,
                StockMovement.business_date >= window_from,
                StockMovement.business_date <= window_to,
            )
            .group_by(StockMovement.preparation_id)
        ).all():
            used[int(pid)] = -int(total)

    rows: list[MiseRowOut] = []
    for prep in preps:
        unit = prep.standard_yield_unit
        stock = inventory_hooks.current_stock(db, store_id=store.id, preparation_id=prep.id)
        total_used = used.get(prep.id, 0)
        avg = (total_used + WINDOW_DAYS // 2) // WINDOW_DAYS if total_used > 0 else None
        cover = None
        if avg and stock > 0:
            tenths = (stock * 10 + avg // 2) // avg
            cover = f"{tenths // 10}.{tenths % 10}"
        suggested = None
        if avg:
            suggested = (avg * (100 + SUGGESTED_CUSHION_PCT) + 99) // 100
        to_produce = batches = None
        if prep.par_qty is not None:
            missing = max(0, prep.par_qty - stock)
            to_produce = missing
            batches = -(-missing // prep.standard_yield_qty) if missing > 0 else 0
        status: Literal["producir", "al_dia", "sin_par"] = (
            "sin_par" if prep.par_qty is None else "producir" if (to_produce or 0) > 0 else "al_dia"
        )
        rows.append(
            MiseRowOut(
                preparation_id=prep.id,
                name=prep.name,
                unit=unit,
                stock=_q(stock, unit),
                par=_q(prep.par_qty, unit) if prep.par_qty is not None else None,
                avg_daily_use=_q(avg, unit) if avg else None,
                days_of_cover=cover,
                to_produce=_q(to_produce, unit) if to_produce is not None else None,
                batches=batches,
                batch_yield=_q(prep.standard_yield_qty, unit),
                suggested_par=_q(suggested, unit) if suggested else None,
                shelf_life_days=prep.shelf_life_days,
                status=status,
            )
        )
    order = {"producir": 0, "sin_par": 1, "al_dia": 2}
    rows.sort(key=lambda r: (order[r.status], r.name))
    return MiseOut(
        business_date=today,
        window_from=window_from,
        window_to=window_to,
        to_produce_count=sum(1 for r in rows if r.status == "producir"),
        rows=rows,
    )
