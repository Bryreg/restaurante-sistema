"""Las preparaciones dentro de un conteo (0038).

Una preparación en **modo lote** tiene stock propio en el libro (lo que se
produjo menos lo que se usó), así que se cuenta igual que un insumo: a ciegas,
renglón por renglón, y al aplicar se ajusta contra lo que el libro tenía en el
instante del conteo. En modo explotado no hay stock que contar: la venta
descuenta directo los insumos.

Vive aparte de `service.py` porque lee `app.recipes`, que es opcional en el
árbol (`find_spec_safe`) y se prende con `catalog.preps`; sin recetas, un
conteo es exactamente el de antes.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import features
from app.core.modules import find_spec_safe
from app.core.quantity import format_qty_base
from app.inventory.models import CostSource, StockCount, StockCountPrepLine, StockCountScope
from app.inventory.schemas import CountLineOut
from app.stores.models import Store


def enabled(db: Session, store: Store) -> bool:
    return find_spec_safe("app.recipes.models") is not None and features.is_enabled(
        db, store.organization_id, store.id, "catalog.preps"
    )


def batch_preparations(db: Session, store: Store, *, key_items_only: bool = False) -> list[Any]:
    """Las preparaciones activas en modo lote de la sede (las que tienen stock)."""
    if not enabled(db, store):
        return []
    from app.recipes.models import Preparation, PrepMode

    stmt = select(Preparation).where(
        Preparation.store_id == store.id, Preparation.active.is_(True), Preparation.mode == PrepMode.BATCH
    )
    if key_items_only:
        stmt = stmt.where(Preparation.key_item.is_(True))
    return list(db.execute(stmt.order_by(Preparation.name)).scalars().all())


def add_lines(db: Session, *, count: StockCount, store: Store) -> None:
    for prep in batch_preparations(db, store, key_items_only=count.scope == StockCountScope.KEY_ITEMS):
        db.add(StockCountPrepLine(count_id=count.id, preparation_id=prep.id, qty_counted=None, was_counted=False))


def lines(db: Session, count: StockCount) -> list[StockCountPrepLine]:
    stmt = select(StockCountPrepLine).where(StockCountPrepLine.count_id == count.id).order_by(StockCountPrepLine.id)
    return list(db.execute(stmt).scalars().all())


def preparation_map(db: Session, ids: list[int]) -> dict[int, Any]:
    if not ids or find_spec_safe("app.recipes.models") is None:
        return {}
    from app.recipes.models import Preparation

    return {p.id: p for p in db.execute(select(Preparation).where(Preparation.id.in_(ids))).scalars().all()}


def _previous(db: Session, *, count: StockCount, preparation_id: int) -> int | None:
    stmt = (
        select(StockCountPrepLine.qty_counted)
        .join(StockCount, StockCount.id == StockCountPrepLine.count_id)
        .where(
            StockCount.store_id == count.store_id,
            StockCount.id != count.id,
            StockCountPrepLine.preparation_id == preparation_id,
            StockCountPrepLine.was_counted.is_(True),
            StockCount.opened_at < count.opened_at,
        )
        .order_by(StockCount.opened_at.desc(), StockCount.id.desc())
        .limit(1)
    )
    return db.execute(stmt).scalar_one_or_none()


def line_outs(db: Session, count: StockCount) -> list[CountLineOut]:
    """Los renglones de preparación, **a ciegas** como los de insumo: sólo el
    valor del conteo anterior, nunca el libro."""
    rows = lines(db, count)
    preps = preparation_map(db, [r.preparation_id for r in rows])
    out: list[CountLineOut] = []
    for r in rows:
        prep = preps.get(r.preparation_id)
        if prep is None:
            continue
        previous = _previous(db, count=count, preparation_id=r.preparation_id)
        out.append(
            CountLineOut(
                ingredient_id=None,
                preparation_id=r.preparation_id,
                ingredient_name=prep.name,
                base_unit=prep.standard_yield_unit,
                qty_counted=format_qty_base(r.qty_counted) if r.qty_counted is not None else None,
                was_counted=r.was_counted,
                previous_qty_counted=format_qty_base(previous) if previous is not None else None,
            )
        )
    return out


@dataclass
class PrepCost:
    cost_micros: int | None
    cost_source: CostSource


def last_batch_cost(db: Session, *, preparation_id: int) -> PrepCost:
    """El costo por unidad del último lote producido: es lo que vale lo que
    hay en el estante. Sin lote con costo, sin costo (nunca $ 0)."""
    from app.recipes.models import PrepBatch

    batch = db.execute(
        select(PrepBatch)
        .where(PrepBatch.preparation_id == preparation_id, PrepBatch.unit_cost_micros.is_not(None))
        .order_by(PrepBatch.produced_at.desc(), PrepBatch.id.desc())
        .limit(1)
    ).scalar_one_or_none()
    if batch is None or batch.unit_cost_micros is None:
        return PrepCost(None, CostSource.NONE)
    try:
        source = CostSource(batch.cost_source)
    except ValueError:
        source = CostSource.ESTIMATED
    if source is CostSource.NONE:
        source = CostSource.ESTIMATED
    return PrepCost(int(batch.unit_cost_micros), source)


def save(db: Session, *, count: StockCount, preparation_id: int, qty: int, was_counted: bool, now: datetime) -> bool:
    """Guarda un renglón de preparación; `False` si no está en el conteo."""
    row = db.execute(
        select(StockCountPrepLine).where(
            StockCountPrepLine.count_id == count.id, StockCountPrepLine.preparation_id == preparation_id
        )
    ).scalar_one_or_none()
    if row is None:
        return False
    if row.was_counted and not was_counted:
        return True
    row.qty_counted = qty
    row.was_counted = was_counted
    if was_counted:
        row.counted_at = now
    return True
