"""La vida de cada insumo en el período (Inventario › Línea de tiempo).

Una sola lectura del libro de movimientos (`StockMovement`) y de los conteos,
por sede y rango de días operativos, que contesta lo que una tabla de saldos
no contesta: **cuándo** entró y salió cada cosa, **cuánto tiempo** estuvo bajo
el mínimo o en cero, y **qué vio quien contó** contra lo que el libro creía en
ese instante.

Adaptada de la pestaña «Insumos» de café-sistema, con tres cosas que allá no
estaban y que son las que deciden una compra:

- **Tiempo bajo el mínimo y en cero**, exacto, sobre la curva escalonada. Dos
  insumos con los mismos totales pueden haber pasado uno dos horas y el otro
  tres días sin stock; los totales no lo dicen.
- **El mínimo de cada insumo** viaja con la fila y se dibuja sobre su barra.
- **Cada conteo con su teórico de ese instante** (`at <= contado`), la misma
  lectura que usa `apply_count`, y la diferencia en plata al costo vigente.

Toda la cuenta vive acá; la pantalla sólo dibuja. Las cantidades viajan como
texto decimal (`format_qty_base`) y la plata como pesos enteros, igual que el
resto de la API.

El rango se lee por **instante** (`at`) entre el arranque del primer día
operativo y el del día siguiente al último, con la hora de corte de la sede:
es la única forma de que «arrancó + movimientos = queda» cierre con la curva
dibujada. Un movimiento con fecha operativa corrida a mano cae donde ocurrió.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Literal

from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core import clock, tz
from app.core.errors import AppError
from app.core.quantity import format_cost_micros, format_qty_base, line_cost_micros, micros_to_pesos
from app.inventory import hooks
from app.inventory.models import (
    AreaCount,
    AreaCountLine,
    Ingredient,
    MovementCause,
    StockCount,
    StockCountLine,
    StockCountScope,
    StockCountStatus,
    StockMovement,
)
from app.stores.models import Store

# Más de dos meses en una barra de 1000 px ya no deja ver un día.
MAX_RANGE_DAYS = 62
DEFAULT_RANGE_DAYS = 7
# La curva se manda en tramos: con 30 días y cien ventas diarias un insumo
# tendría miles de escalones que la pantalla no puede distinguir. El tiempo
# bajo el mínimo y en cero se calcula ANTES de agrupar, sobre cada movimiento.
CURVE_BUCKETS = 240

# Lo que trae mercancía al estante y se marca como llegada en la barra.
ARRIVAL_CAUSES = frozenset(
    {MovementCause.PURCHASE, MovementCause.TRANSFER_IN, MovementCause.PRODUCTION_IN}
)
# Un ajuste por conteo no es mercancía que salió: es el libro corrigiéndose.
# Va aparte, como diferencia de conteo, y no suma a «la plata que salió».
NOT_AN_OUTFLOW = frozenset({MovementCause.COUNT_ADJUSTMENT})


# ---------------------------------------------------------------------------
# Esquemas.
# ---------------------------------------------------------------------------


class TimelineCauseOut(BaseModel):
    cause: str
    movements: int
    # Cantidad neta con signo, unidad base.
    qty: str
    # Pesos al costo congelado en cada movimiento; `None` si ninguno tenía
    # costo. `uncosted` dice cuántos quedaron afuera de la suma.
    value: int | None
    uncosted: int


class TimelinePointOut(BaseModel):
    # El saldo después del último movimiento del tramo, y su instante.
    at: datetime
    qty: str


class TimelineArrivalOut(BaseModel):
    at: datetime
    cause: str
    qty: str


class TimelineCountOut(BaseModel):
    at: datetime
    kind: Literal["full", "key_items", "area"]
    # «Conteo completo», «Conteo de críticos», «Bar · al abrir»…
    label: str
    employee_name: str | None
    counted: str
    # Lo que el libro tenía en ese instante.
    expected: str
    # Contado − esperado: negativo es faltante.
    diff: str
    # La diferencia al costo vigente; `None` sin costo.
    diff_value: int | None


class TimelineRowOut(BaseModel):
    ingredient_id: int
    name: str
    base_unit: str
    key_item: bool
    min_stock: str
    # Costo vigente por unidad base (`resolve_ingredient_cost`), texto.
    cost: str | None
    start_qty: str
    in_qty: str
    out_qty: str
    count_adjustment_qty: str
    end_qty: str
    by_cause: list[TimelineCauseOut]
    # La plata que salió del estante (todo lo negativo menos los ajustes por
    # conteo), al costo de cada movimiento. `None` = salió algo sin costo
    # y nada con costo; `value_out_partial` = parte de lo que salió no tenía.
    value_out: int | None
    value_out_partial: bool
    # Lo que corrigieron los conteos aplicados en el período, en plata
    # (negativo = faltante).
    value_count_adjustment: int | None
    # Segundos del período (hasta ahora) bajo el mínimo y en cero o menos.
    seconds_below_min: int
    seconds_at_zero: int
    # La primera vez que tocó cero en el período; `None` si nunca.
    first_zero_at: datetime | None
    points: list[TimelinePointOut]
    arrivals: list[TimelineArrivalOut]
    counts: list[TimelineCountOut]


class TimelineSummaryOut(BaseModel):
    ingredients: int
    with_movement: int
    value_out: int
    value_out_partial: bool
    # La plata que salió, por causa (venta, merma, producción…), de mayor a
    # menor.
    value_out_by_cause: list[TimelineCauseOut]
    value_count_shortage: int
    value_count_surplus: int
    counts: int
    below_min: int
    hit_zero: int
    negative_now: int


class TimelineOut(BaseModel):
    store_id: int
    date_from: date
    date_to: date
    # El arranque del primer día operativo y el del día siguiente al último
    # (UTC): la regla horizontal de cada barra.
    start_at: datetime
    end_at: datetime
    # Hasta dónde llegó el día: el resto del rango todavía no pasó.
    now_at: datetime
    summary: TimelineSummaryOut
    rows: list[TimelineRowOut]


# ---------------------------------------------------------------------------
# Cálculo.
# ---------------------------------------------------------------------------


@dataclass
class _Cause:
    movements: int = 0
    qty: int = 0
    value_micros: int = 0
    costed: int = 0
    uncosted: int = 0


@dataclass
class _Acc:
    start: int = 0
    # Tuvo movimientos antes del rango: existía desde antes, diga lo que diga
    # su `created_at` (una carga o una migración puede dejarlo posterior).
    before: bool = False
    causes: dict[MovementCause, _Cause] = field(default_factory=lambda: defaultdict(_Cause))
    moves: list[tuple[datetime, int, MovementCause, int | None]] = field(default_factory=list)


def business_day_start(day: date, cutoff_hour: int) -> datetime:
    """El instante (UTC) en que arranca el día operativo `day` en la sede."""
    return tz.from_bogota_wall_clock(datetime.combine(day, time(hour=cutoff_hour)))


def resolve_range(date_from: date | None, date_to: date | None, *, cutoff_hour: int) -> tuple[date, date]:
    to = date_to or tz.today_business_date(cutoff_hour)
    frm = date_from or (to - timedelta(days=DEFAULT_RANGE_DAYS - 1))
    if frm > to:
        raise AppError("VALIDATION_ERROR", "from: tiene que ser anterior o igual a to", status=400)
    if (to - frm).days + 1 > MAX_RANGE_DAYS:
        raise AppError(
            "VALIDATION_ERROR",
            f"El rango puede tener hasta {MAX_RANGE_DAYS} días: elegí un período más corto",
            status=400,
        )
    return frm, to


def _pesos(micros: int, costed: int) -> int | None:
    return micros_to_pesos(micros) if costed else None


def _durations(
    start_qty: int, moves: list[tuple[datetime, int, MovementCause, int | None]], *, min_stock: int,
    start_at: datetime, until: datetime,
) -> tuple[int, int, datetime | None]:
    """Segundos bajo el mínimo y en cero o menos, sobre la curva escalonada
    exacta (cada movimiento, sin agrupar), entre `start_at` y `until`."""
    below = at_zero = 0
    first_zero: datetime | None = start_at if start_qty <= 0 else None
    saldo, prev = start_qty, start_at
    for at, qty, _cause, _cost in moves:
        if at > until:
            break
        span = int((at - prev).total_seconds())
        if span > 0:
            if saldo < min_stock:
                below += span
            if saldo <= 0:
                at_zero += span
        saldo += qty
        prev = max(prev, at)
        if saldo <= 0 and first_zero is None:
            first_zero = at
    span = int((until - prev).total_seconds())
    if span > 0:
        if saldo < min_stock:
            below += span
        if saldo <= 0:
            at_zero += span
    return below, at_zero, first_zero


def _curve(
    start_qty: int, moves: list[tuple[datetime, int, MovementCause, int | None]], *, start_at: datetime, end_at: datetime
) -> list[TimelinePointOut]:
    """El saldo al final de cada tramo con movimiento: `CURVE_BUCKETS` tramos
    iguales entre `start_at` y `end_at`, y sólo los que cambiaron."""
    total = max(1.0, (end_at - start_at).total_seconds())
    points: list[TimelinePointOut] = []
    saldo = start_qty
    bucket: int | None = None
    last_at: datetime | None = None
    for at, qty, _cause, _cost in moves:
        b = min(CURVE_BUCKETS - 1, int((at - start_at).total_seconds() / total * CURVE_BUCKETS))
        if bucket is not None and b != bucket and last_at is not None:
            points.append(TimelinePointOut(at=last_at, qty=format_qty_base(saldo)))
        bucket = b
        saldo += qty
        last_at = at
    if last_at is not None:
        points.append(TimelinePointOut(at=last_at, qty=format_qty_base(saldo)))
    return points


def _saldo_at(start_qty: int, moves: list[tuple[datetime, int, MovementCause, int | None]], instant: datetime) -> int:
    """Lo que el libro tenía en `instant` (`at <= instant`, como
    `hooks.current_stock(as_of=...)`)."""
    saldo = start_qty
    for at, qty, _cause, _cost in moves:
        if at > instant:
            break
        saldo += qty
    return saldo


_MOMENT_LABEL = {"opening": "al abrir", "closing": "al cerrar", "spot": "recuento"}


def inventory_timeline(
    db: Session,
    *,
    store: Store,
    date_from: date | None,
    date_to: date | None,
    ingredient_id: int | None = None,
    critical_only: bool = False,
) -> TimelineOut:
    frm, to = resolve_range(date_from, date_to, cutoff_hour=store.cutoff_hour)
    start_at = business_day_start(frm, store.cutoff_hour)
    end_at = business_day_start(to + timedelta(days=1), store.cutoff_hour)
    now = clock.now_utc()
    until = min(end_at, max(start_at, now))

    stmt = select(Ingredient).where(Ingredient.store_id == store.id, Ingredient.active.is_(True))
    if ingredient_id is not None:
        stmt = select(Ingredient).where(Ingredient.store_id == store.id, Ingredient.id == ingredient_id)
    if critical_only:
        stmt = stmt.where(Ingredient.key_item.is_(True))
    ingredients = list(db.execute(stmt.order_by(Ingredient.name)).scalars().all())
    ids = [i.id for i in ingredients]
    acc: dict[int, _Acc] = {i: _Acc() for i in ids}

    if ids:
        for iid, qty in db.execute(
            select(StockMovement.ingredient_id, func.coalesce(func.sum(StockMovement.qty_base), 0))
            .where(
                StockMovement.store_id == store.id,
                StockMovement.ingredient_id.in_(ids),
                StockMovement.at < start_at,
            )
            .group_by(StockMovement.ingredient_id)
        ).all():
            acc[int(iid)].start = int(qty)
            acc[int(iid)].before = True

        for iid, at, qty, cause, cost in db.execute(
            select(
                StockMovement.ingredient_id, StockMovement.at, StockMovement.qty_base,
                StockMovement.cause, StockMovement.cost_micros,
            )
            .where(
                StockMovement.store_id == store.id,
                StockMovement.ingredient_id.in_(ids),
                StockMovement.at >= start_at,
                StockMovement.at < end_at,
            )
            .order_by(StockMovement.at, StockMovement.id)
        ).all():
            a = acc[int(iid)]
            c = a.causes[cause]
            c.movements += 1
            c.qty += int(qty)
            if cost is None:
                c.uncosted += 1
            else:
                c.costed += 1
                c.value_micros += line_cost_micros(int(qty), int(cost))
            a.moves.append((at, int(qty), cause, None if cost is None else int(cost)))

    counts_by_ingredient: dict[int, list[tuple[datetime, str, str, str | None, int]]] = defaultdict(list)
    if ids:
        for line, count in db.execute(
            select(StockCountLine, StockCount)
            .join(StockCount, StockCountLine.count_id == StockCount.id)
            .where(
                StockCount.store_id == store.id,
                StockCountLine.ingredient_id.in_(ids),
                StockCountLine.was_counted.is_(True),
                # Un conteo anulado no dice lo que había: su reversa ya está en el libro.
                StockCount.status != StockCountStatus.VOIDED,
                StockCountLine.qty_counted.is_not(None),
                StockCount.opened_at >= start_at,
                StockCount.opened_at < end_at,
            )
        ).all():
            key = count.scope == StockCountScope.KEY_ITEMS
            counts_by_ingredient[line.ingredient_id].append(
                (
                    count.opened_at,
                    "key_items" if key else "full",
                    "Conteo de críticos" if key else "Conteo completo",
                    count.applied_by_employee_name or count.opened_by_employee_name,
                    int(line.qty_counted),
                )
            )
        for aline, acount in db.execute(
            select(AreaCountLine, AreaCount)
            .join(AreaCount, AreaCountLine.count_id == AreaCount.id)
            .where(
                AreaCount.store_id == store.id,
                AreaCountLine.ingredient_id.in_(ids),
                AreaCount.counted_at >= start_at,
                AreaCount.counted_at < end_at,
            )
        ).all():
            moment = getattr(acount.moment, "value", str(acount.moment))
            counts_by_ingredient[aline.ingredient_id].append(
                (
                    aline.counted_at or acount.counted_at,
                    "area",
                    f"{acount.area_name} · {_MOMENT_LABEL.get(moment, moment)}",
                    aline.employee_name or acount.employee_name,
                    int(aline.qty_base),
                )
            )

    rows: list[TimelineRowOut] = []
    total_out_micros = 0
    total_out_costed = False
    total_partial = False
    by_cause_total: dict[MovementCause, _Cause] = defaultdict(_Cause)
    shortage = surplus = 0
    n_counts = n_below = n_zero = n_negative = n_moved = 0

    for ingredient in ingredients:
        a = acc[ingredient.id]
        end_qty = a.start + sum(q for _at, q, _c, _k in a.moves)
        in_qty = sum(q for _at, q, c, _k in a.moves if q > 0 and c not in NOT_AN_OUTFLOW)
        out_qty = sum(q for _at, q, c, _k in a.moves if q < 0 and c not in NOT_AN_OUTFLOW)
        adj_qty = sum(q for _at, q, c, _k in a.moves if c in NOT_AN_OUTFLOW)
        cost_micros, _source = hooks.resolve_ingredient_cost(db, ingredient)

        out_micros = 0
        out_costed = out_uncosted = 0
        for cause, c in a.causes.items():
            t = by_cause_total[cause]
            t.movements += c.movements
            t.qty += c.qty
            t.value_micros += c.value_micros
            t.costed += c.costed
            t.uncosted += c.uncosted
        # La plata que salió: sólo los movimientos negativos que no son
        # ajuste por conteo. Se recorre por movimiento porque una causa
        # (traslado, anulación de recepción) puede tener los dos signos.
        adj_micros = 0
        adj_costed = 0
        for _at, qty, cause, cost in a.moves:
            if cause in NOT_AN_OUTFLOW:
                if cost is not None:
                    adj_micros += line_cost_micros(qty, cost)
                    adj_costed += 1
                continue
            if qty < 0:
                if cost is None:
                    out_uncosted += 1
                else:
                    out_costed += 1
                    out_micros += line_cost_micros(-qty, cost)

        # Antes de que el insumo existiera no estuvo «en cero»: no estaba.
        # Si tiene movimientos anteriores a su `created_at`, existía desde el
        # primero de ellos.
        born = ingredient.created_at
        if a.moves and (born is None or a.moves[0][0] < born):
            born = a.moves[0][0]
        since = start_at if a.before or born is None or born <= start_at else min(born, until)
        start_since = _saldo_at(a.start, a.moves, since) if since > start_at else a.start
        below, at_zero, first_zero = _durations(
            start_since, [m for m in a.moves if m[0] > since], min_stock=ingredient.min_stock,
            start_at=since, until=until,
        )

        counts: list[TimelineCountOut] = []
        for at, kind, label, who, counted in sorted(counts_by_ingredient.get(ingredient.id, []), key=lambda x: x[0]):
            expected = _saldo_at(a.start, a.moves, at)
            diff = counted - expected
            value = micros_to_pesos(line_cost_micros(diff, cost_micros)) if cost_micros is not None else None
            counts.append(
                TimelineCountOut(
                    at=at, kind=kind, label=label, employee_name=who,  # type: ignore[arg-type]
                    counted=format_qty_base(counted), expected=format_qty_base(expected),
                    diff=format_qty_base(diff), diff_value=value,
                )
            )

        value_out = _pesos(out_micros, out_costed)
        value_adj = _pesos(adj_micros, adj_costed)
        if value_out is not None:
            total_out_micros += out_micros
            total_out_costed = True
        if out_uncosted:
            total_partial = True
        if value_adj is not None:
            if value_adj < 0:
                shortage += value_adj
            else:
                surplus += value_adj
        n_counts += len(counts)
        n_below += 1 if below > 0 else 0
        n_zero += 1 if at_zero > 0 else 0
        n_negative += 1 if end_qty < 0 else 0
        n_moved += 1 if a.moves else 0

        rows.append(
            TimelineRowOut(
                ingredient_id=ingredient.id,
                name=ingredient.name,
                base_unit=getattr(ingredient.base_unit, "value", str(ingredient.base_unit)),
                key_item=bool(ingredient.key_item),
                min_stock=format_qty_base(ingredient.min_stock),
                cost=format_cost_micros(cost_micros) if cost_micros is not None else None,
                start_qty=format_qty_base(a.start),
                in_qty=format_qty_base(in_qty),
                out_qty=format_qty_base(out_qty),
                count_adjustment_qty=format_qty_base(adj_qty),
                end_qty=format_qty_base(end_qty),
                by_cause=[
                    TimelineCauseOut(
                        cause=cause.value, movements=c.movements, qty=format_qty_base(c.qty),
                        value=_pesos(c.value_micros, c.costed), uncosted=c.uncosted,
                    )
                    for cause, c in sorted(a.causes.items(), key=lambda kv: kv[1].qty)
                ],
                value_out=value_out,
                value_out_partial=out_uncosted > 0 and out_costed > 0,
                value_count_adjustment=value_adj,
                seconds_below_min=below,
                seconds_at_zero=at_zero,
                first_zero_at=first_zero,
                points=_curve(a.start, a.moves, start_at=start_at, end_at=end_at),
                arrivals=[
                    TimelineArrivalOut(at=at, cause=cause.value, qty=format_qty_base(qty))
                    for at, qty, cause, _cost in a.moves
                    if cause in ARRIVAL_CAUSES and qty > 0
                ],
                counts=counts,
            )
        )

    outflow_causes = [
        (cause, c) for cause, c in by_cause_total.items() if cause not in NOT_AN_OUTFLOW and c.qty < 0 and c.costed
    ]
    return TimelineOut(
        store_id=store.id,
        date_from=frm,
        date_to=to,
        start_at=start_at,
        end_at=end_at,
        now_at=until,
        summary=TimelineSummaryOut(
            ingredients=len(ingredients),
            with_movement=n_moved,
            value_out=micros_to_pesos(total_out_micros) if total_out_costed else 0,
            value_out_partial=total_partial,
            value_out_by_cause=sorted(
                (
                    TimelineCauseOut(
                        cause=cause.value, movements=c.movements, qty=format_qty_base(c.qty),
                        value=-micros_to_pesos(c.value_micros), uncosted=c.uncosted,
                    )
                    for cause, c in outflow_causes
                ),
                key=lambda x: -(x.value or 0),
            ),
            value_count_shortage=shortage,
            value_count_surplus=surplus,
            counts=n_counts,
            below_min=n_below,
            hit_zero=n_zero,
            negative_now=n_negative,
        ),
        rows=rows,
    )
