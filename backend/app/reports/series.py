"""Las series «barra + raya» del panel del dueño.

**Ninguna cifra de plata nace acá.** Cada serie reusa la función que ya
calcula su dato para otra pantalla:

- ventas por día, por categoría y por sede: `service.aggregate_sales` (la
  de «Ventas» e «Informes»);
- hoy contra la semana pasada a la misma hora: `service._today_comparison`
  (la de «Hoy»);
- efectivo en caja por hora: `shifts.hooks.expected_cash_at`, que es
  `compute_breakdown` leído con `as_of` (la única fórmula del esperado);
- stock al cierre: `inventory.hooks.current_stock` (el libro);
- cocina: `kitchen.hooks.kitchen_tickets` (la misma lectura del KDS).

Lo que se decide acá es la **raya** de cada serie —y ésas son supuestos del
dueño que viven en Ajustes (`StoreSalesSettings`: margen meta, mesa larga,
tiquete demorado, comandas por mesero; `StoreCashSettings.
cash_pickup_threshold` para el retiro)— y de qué lado de la raya queda
cada punto. Los conteos (comandas, personas, minutos) y sus promedios por
día son enteros redondeados half-up.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core import clock, features, tz
from app.core.quantity import format_qty_base
from app.orders import money
from app.orders.models import Order, OrderChannel, OrderStatus
from app.reports import service
from app.reports.schemas import SalesBucketOut
from app.reports.series_schemas import (
    AreaProgressOut,
    BulletOut,
    CashByHourSeriesOut,
    CashHourPointOut,
    CategoryMarginPointOut,
    CategoryMarginSeriesOut,
    DailySalesSeriesOut,
    DishMixGroup,
    DishMixPointOut,
    DishMixSeriesOut,
    OverviewSeriesOut,
    PanelBulletsOut,
    PeakHourPointOut,
    PeakHoursSeriesOut,
    PeakHoursViewOut,
    SeriesOut,
    SeriesPointOut,
    StockByDaySeriesOut,
    StockDayPointOut,
    StoresWeekSeriesOut,
    StoreWeekPointOut,
)
from app.shifts import hooks as shifts_hooks
from app.stores import service as stores_service
from app.shifts.models import Shift
from app.stores.models import Store, StoreSalesSettings

#: Horas de «Horas pico» (11 a. m. a 10 p. m., la franja del servicio).
PEAK_HOURS = tuple(range(11, 23))
#: Horas de «Quién trabaja» en Hoy (6 a. m. a 12 a. m.).
STAFF_HOURS = tuple(range(6, 24))
#: El puesto de quien atiende mesas (`app.auth.models.PUESTO_VALUES`).
WAITER_PUESTO = "salon"
#: Días cerrados de «¿Cuándo se me acaba?» y días proyectados.
STOCK_CLOSED_DAYS = 14
STOCK_PROJECTED_DAYS = 7
#: Más de esto la serie diaria no se dibuja como columnas.
DAILY_MAX_DAYS = 62
#: Más horas que esto de un turno abierto no se dibujan (turno abandonado).
CASH_MAX_HOURS = 30

_WEEKDAY_KEYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
_WEEKDAY_SHORT = ("lun", "mar", "mié", "jue", "vie", "sáb", "dom")
_MONTH_SHORT = (
    "ene",
    "feb",
    "mar",
    "abr",
    "may",
    "jun",
    "jul",
    "ago",
    "sep",
    "oct",
    "nov",
    "dic",
)

MARGIN_ALL_STORES_REASON = "Las sedes tienen metas de margen distintas: elegí una sede para ver la raya de la meta."
PEAK_NO_DAYS_REASON = (
    "No hay días operados en el período: no hay comandas por hora que mostrar."
)


def hour_label(hour: int) -> str:
    """«11 a. m.», «12 p. m.», «1 p. m.», «12 a. m.» (hora de reloj 0-23)."""
    h = hour % 24
    if h == 0:
        return "12 a. m."
    if h < 12:
        return f"{h} a. m."
    if h == 12:
        return "12 p. m."
    return f"{h - 12} p. m."


def day_label(d: date) -> str:
    """«sáb 20» — día de la semana corto y número."""
    return f"{_WEEKDAY_SHORT[d.weekday()]} {d.day}"


def _bogota_instant(
    business_date: date, hour: int, cutoff_hour: int, minute: int = 0
) -> datetime:
    """El instante UTC de la hora de reloj `hour`:`minute` DENTRO del día
    operativo `business_date` (una hora antes del corte cae al día
    calendario siguiente)."""
    calendar_day = (
        business_date if hour >= cutoff_hour else business_date + timedelta(days=1)
    )
    local = datetime.combine(
        calendar_day, time(hour=hour, minute=minute), tzinfo=tz.BOGOTA
    )
    return local.astimezone(timezone.utc)


def _margin_bp(row: SalesBucketOut) -> int | None:
    """Margen bruto sobre la venta neta, en puntos básicos. `None` sin
    costo o sin venta neta (nunca un 0 % mudo)."""
    if row.gross_margin is None or row.net <= 0 or not row.costed_pct:
        return None
    return service._signed_bp(row.gross_margin, row.net)


def _sales_settings(db: Session, store: Store) -> StoreSalesSettings:
    return stores_service.get_sales_settings(db, store.id)


# ---------------------------------------------------------------------------
# Informes
# ---------------------------------------------------------------------------


def daily_sales(
    db: Session,
    *,
    scope: service.StoreScope,
    date_from: date,
    date_to: date,
    today: date,
) -> DailySalesSeriesOut:
    """Ventas netas por día del período, cada una contra el MISMO día de
    la semana anterior (`d − 7`). Una sola agregación sobre
    `[from − 7, to]`."""
    length = (date_to - date_from).days + 1
    if length > DAILY_MAX_DAYS:
        return DailySalesSeriesOut(
            available=False,
            reason=f"El período tiene {length} días: la comparación día por día se dibuja hasta {DAILY_MAX_DAYS}.",
            unit="cop",
            bad_side="below",
        )
    rows, _total = service.aggregate_sales(
        db,
        store_id=scope,
        date_from=date_from - timedelta(days=7),
        date_to=date_to,
        group_by="business_date",
    )
    by_day = {r.key: r.net for r in rows}
    points: list[SeriesPointOut] = []
    days_ref = days_above = 0
    best: tuple[int, str] | None = None
    day = date_from
    while day <= date_to:
        key = day.isoformat()
        value = by_day.get(key)
        reference = by_day.get((day - timedelta(days=7)).isoformat())
        delta = service._delta_bp(value, reference)
        outside = value is not None and reference is not None and value < reference
        if value is not None and reference is not None:
            days_ref += 1
            if value >= reference:
                days_above += 1
        if delta is not None and (best is None or delta > best[0]):
            best = (delta, key)
        points.append(
            SeriesPointOut(
                key=key,
                label=day_label(day),
                value=value,
                reference=reference,
                delta_bp=delta,
                outside=outside,
                now=day == today,
            )
        )
        day += timedelta(days=1)
    return DailySalesSeriesOut(
        unit="cop",
        bad_side="below",
        points=points,
        days_with_reference=days_ref,
        days_above=days_above,
        best_key=best[1] if best else None,
    )


def category_margin(
    db: Session,
    *,
    stores: list[Store],
    scope: service.StoreScope,
    by_category: list[SalesBucketOut],
    total: SalesBucketOut,
    date_from: date,
    date_to: date,
) -> CategoryMarginSeriesOut:
    """Margen bruto por categoría contra la meta de la sede. Con varias
    sedes la meta es la común; si difieren, la serie sale sin raya y dice
    por qué."""
    targets = {_sales_settings(db, s).margin_target_pct for s in stores}
    target_bp = targets.pop() * 100 if len(targets) == 1 else None
    reason = None if target_bp is not None else MARGIN_ALL_STORES_REASON

    length = (date_to - date_from).days + 1
    prev_rows, _ = service.aggregate_sales(
        db,
        store_id=scope,
        date_from=date_from - timedelta(days=length),
        date_to=date_from - timedelta(days=1),
        group_by="category",
    )
    previous = {r.key: _margin_bp(r) for r in prev_rows}
    points: list[CategoryMarginPointOut] = []
    for row in by_category:
        value = _margin_bp(row)
        prev = previous.get(row.key)
        outside = value is not None and target_bp is not None and value < target_bp
        points.append(
            CategoryMarginPointOut(
                key=row.key,
                label=row.label,
                value=value,
                reference=target_bp,
                delta_bp=None,
                outside=outside,
                net=row.net,
                gross_margin=row.gross_margin,
                costed_pct=row.costed_pct,
                previous_bp=prev,
                delta_points_bp=(value - prev)
                if value is not None and prev is not None
                else None,
                gap_bp=(target_bp - value)
                if outside and target_bp is not None and value is not None
                else None,
            )
        )
    # Mayor margen arriba; sin dato al final.
    points.sort(key=lambda p: (p.value is None, -(p.value or 0), p.label))
    return CategoryMarginSeriesOut(
        reason=reason,
        reference=target_bp,
        total_bp=_margin_bp(total),
        points=points,
    )


def stores_week(
    db: Session, *, stores: list[Store], date_from: date, date_to: date
) -> StoresWeekSeriesOut:
    """Ventas netas de cada sede en el período contra el período anterior
    del mismo largo (la misma `aggregate_sales` por sede sola)."""
    length = (date_to - date_from).days + 1
    prev_from = date_from - timedelta(days=length)
    prev_to = date_from - timedelta(days=1)
    points: list[StoreWeekPointOut] = []
    for store in stores:
        _r, cur = service.aggregate_sales(
            db, store_id=store.id, date_from=date_from, date_to=date_to, group_by=None
        )
        first = service._first_activity_date(db, store.id)
        prev_net: int | None = None
        if first is not None and first <= prev_to:
            _p, prev = service.aggregate_sales(
                db,
                store_id=store.id,
                date_from=prev_from,
                date_to=prev_to,
                group_by=None,
            )
            prev_net = prev.net
        points.append(
            StoreWeekPointOut(
                key=str(store.id),
                label=store.name,
                store_id=store.id,
                value=cur.net,
                reference=prev_net,
                delta_bp=service._delta_bp(cur.net, prev_net),
                outside=prev_net is not None and cur.net < prev_net,
                avg_ticket=cur.avg_ticket,
                margin_bp=_margin_bp(cur),
            )
        )
    points.sort(key=lambda p: (-(p.value or 0), p.label))
    return StoresWeekSeriesOut(points=points)


def _waiters_by_day_hour(
    db: Session, store: Store, *, date_from: date, date_to: date, hours: tuple[int, ...]
) -> dict[tuple[date, int], int]:
    """Meseros (puesto «salon») en turno a la media hora de cada hora, por
    día operativo. Una salida olvidada («a revisar») no cuenta —la misma
    regla de la asistencia—; una entrada abierta de hoy cuenta hasta ahora."""
    now = clock.now_utc()
    out: dict[tuple[date, int], int] = defaultdict(int)
    for row in shifts_hooks.attendance_rows(
        db, store_id=store.id, date_from=date_from, date_to=date_to
    ):
        if row.puesto != WAITER_PUESTO or row.status == "review":
            continue
        until = row.out_at if row.out_at is not None else now
        for h in hours:
            mid = _bogota_instant(row.business_date, h, store.cutoff_hour, minute=30)
            if row.in_at <= mid < until:
                out[(row.business_date, h)] += 1
    return out


def _orders_by_day_hour(
    db: Session, store_ids: list[int], *, date_from: date, date_to: date
) -> dict[tuple[date, int], int]:
    """Comandas de SALÓN (`dine_in`) por día operativo y hora de apertura
    (reloj de Bogotá). Sin anuladas ni fusionadas: una fusionada ya cuenta
    en la comanda que la recibió."""
    rows = db.execute(
        select(Order.business_date, Order.opened_at).where(
            Order.store_id.in_(store_ids),
            Order.business_date >= date_from,
            Order.business_date <= date_to,
            Order.channel == OrderChannel.DINE_IN,
            Order.status.not_in((OrderStatus.VOIDED, OrderStatus.MERGED)),
        )
    ).all()
    out: dict[tuple[date, int], int] = defaultdict(int)
    for business_date, opened_at in rows:
        out[(business_date, tz.to_bogota(opened_at).hour)] += 1
    return out


def peak_hours(
    db: Session, *, stores: list[Store], date_from: date, date_to: date
) -> PeakHoursSeriesOut:
    """Comandas de salón por hora (11 a. m.–10 p. m.) contra lo que
    alcanzan los meseros en turno: promedio de los días operados y un
    promedio por día de la semana. Con varias sedes, meseros y capacidad
    se suman sede por sede (cada una con su «comandas por mesero»)."""
    store_ids = [s.id for s in stores]
    operated = sorted(service._operated_dates(db, store_ids, date_from, date_to))
    opw_by_store = {s.id: _sales_settings(db, s).orders_per_waiter for s in stores}
    common_opw = (
        next(iter(set(opw_by_store.values())))
        if len(set(opw_by_store.values())) == 1
        else None
    )
    if not operated:
        return PeakHoursSeriesOut(
            available=False, reason=PEAK_NO_DAYS_REASON, orders_per_waiter=common_opw
        )

    orders = _orders_by_day_hour(db, store_ids, date_from=date_from, date_to=date_to)
    waiters = {
        s.id: _waiters_by_day_hour(
            db, s, date_from=date_from, date_to=date_to, hours=PEAK_HOURS
        )
        for s in stores
    }

    def view(key: str, label: str, days: list[date]) -> PeakHoursViewOut:
        n = len(days)
        points: list[PeakHourPointOut] = []
        for h in PEAK_HOURS:
            if n == 0:
                points.append(
                    PeakHourPointOut(
                        key=str(h), label=hour_label(h), value=None, waiters=None
                    )
                )
                continue
            value = money.round_half_up(sum(orders.get((d, h), 0) for d in days), n)
            waiters_total = 0
            capacity = 0
            for s in stores:
                w = money.round_half_up(
                    sum(waiters[s.id].get((d, h), 0) for d in days), n
                )
                waiters_total += w
                capacity += w * opw_by_store[s.id]
            points.append(
                PeakHourPointOut(
                    key=str(h),
                    label=hour_label(h),
                    value=value,
                    reference=capacity,
                    delta_bp=service._delta_bp(value, capacity),
                    outside=value > capacity,
                    waiters=waiters_total,
                )
            )
        return PeakHoursViewOut(key=key, label=label, days=n, points=points)

    views = [view("avg", "Promedio", operated)]
    start = date_from.weekday()
    for i in range(7):
        wd = (start + i) % 7
        views.append(
            view(
                _WEEKDAY_KEYS[wd],
                _WEEKDAY_SHORT[wd],
                [d for d in operated if d.weekday() == wd],
            )
        )
    return PeakHoursSeriesOut(orders_per_waiter=common_opw, views=views)


#: Cuántos platos entran al «Mix de platos» (los de más unidades con costo).
DISH_MIX_MAX = 12
DISH_MIX_NO_COST_REASON = (
    "Ningún plato vendido en el período tiene costo: sin costo no hay margen que ubicar."
)
DISH_MIX_NO_SALES_REASON = "No se vendió ningún plato en el período."


def _signed_half_up(numerator: int, denominator: int) -> int:
    """`numerator / denominator` entero, half-up sobre el valor absoluto y
    con el signo del numerador (un margen promedio puede ser negativo)."""
    magnitude = money.round_half_up(abs(numerator), denominator)
    return magnitude if numerator >= 0 else -magnitude


def dish_mix(product_rows: list[SalesBucketOut]) -> DishMixSeriesOut:
    """Unidades contra margen de los platos más vendidos con costo. Los
    promedios que parten los cuadrantes son simples (un plato, un voto),
    y el grupo de cada plato lo decide acá el servidor: la pantalla no
    compara contra el promedio."""
    sold = [r for r in product_rows if (r.units or 0) > 0]
    if not sold:
        return DishMixSeriesOut(available=False, reason=DISH_MIX_NO_SALES_REASON)
    with_margin = [(r, _margin_bp(r)) for r in sold]
    costed = [(r, m) for r, m in with_margin if m is not None]
    without_cost = len(sold) - len(costed)
    if not costed:
        return DishMixSeriesOut(
            available=False, reason=DISH_MIX_NO_COST_REASON, without_cost=without_cost
        )
    costed.sort(key=lambda rm: (-(rm[0].units or 0), -rm[0].net, rm[0].label or rm[0].key))
    top = costed[:DISH_MIX_MAX]
    n = len(top)
    avg_units = money.round_half_up(sum(r.units or 0 for r, _ in top), n)
    avg_margin = _signed_half_up(sum(m for _, m in top if m is not None), n)
    points: list[DishMixPointOut] = []
    for r, m in top:
        assert m is not None
        units = r.units or 0
        sells = units >= avg_units
        earns = m >= avg_margin
        group: DishMixGroup = (
            "keep" if sells and earns else "promote" if earns else "reprice" if sells else "review"
        )
        points.append(
            DishMixPointOut(
                key=r.key,
                label=r.label or r.key,
                units=units,
                margin_bp=m,
                net=r.net,
                group=group,
            )
        )
    return DishMixSeriesOut(
        avg_units=avg_units,
        avg_margin_bp=avg_margin,
        points=points,
        without_cost=without_cost,
    )


def overview_series(
    db: Session,
    *,
    stores: list[Store],
    all_stores: bool,
    scope: service.StoreScope,
    date_from: date,
    date_to: date,
    by_category: list[SalesBucketOut],
    total: SalesBucketOut,
    product_rows: list[SalesBucketOut] | None = None,
) -> OverviewSeriesOut:
    today = tz.today_business_date(stores[0].cutoff_hour)
    return OverviewSeriesOut(
        daily_sales=daily_sales(
            db, scope=scope, date_from=date_from, date_to=date_to, today=today
        ),
        category_margin=category_margin(
            db,
            stores=stores,
            scope=scope,
            by_category=by_category,
            total=total,
            date_from=date_from,
            date_to=date_to,
        ),
        stores_week=stores_week(db, stores=stores, date_from=date_from, date_to=date_to)
        if all_stores
        else None,
        peak_hours=peak_hours(db, stores=stores, date_from=date_from, date_to=date_to),
        dish_mix=dish_mix(product_rows) if product_rows is not None else None,
    )


# ---------------------------------------------------------------------------
# Ficha de turno: efectivo en caja por hora
# ---------------------------------------------------------------------------


def cash_by_hour(db: Session, *, shift: Shift, store: Store) -> CashByHourSeriesOut:
    """El efectivo esperado del cajón al final de cada hora de reloj desde
    la apertura hasta el cierre (o ahora), contra el umbral de retiro. Los
    retiros de cada hora van marcados en su punto."""
    threshold = stores_service.get_cash_settings(db, store.id).cash_pickup_threshold
    opened_at: datetime = shift.opened_at
    now = clock.now_utc()
    end: datetime = shift.closed_at or now
    start_local = tz.to_bogota(opened_at).replace(minute=0, second=0, microsecond=0)
    hour_starts: list[datetime] = []
    cursor = start_local
    while cursor.astimezone(timezone.utc) < end and len(hour_starts) < CASH_MAX_HOURS:
        hour_starts.append(cursor)
        cursor += timedelta(hours=1)
    truncated = cursor.astimezone(timezone.utc) < end
    instants = [
        min((h + timedelta(hours=1)).astimezone(timezone.utc), end) for h in hour_starts
    ]
    values = shifts_hooks.expected_cash_at(db, shift, instants)
    pickups = shifts_hooks.live_pickups(db, shift.id)
    open_now = shift.closed_at is None
    points: list[CashHourPointOut] = []
    for h, at, value in zip(hour_starts, instants, values):
        h_utc = h.astimezone(timezone.utc)
        in_hour = [
            p.amount for p in pickups if h_utc <= p.at < h_utc + timedelta(hours=1)
        ]
        is_now = open_now and h_utc <= now < h_utc + timedelta(hours=1)
        points.append(
            CashHourPointOut(
                key=h_utc.isoformat(),
                label=hour_label(h.hour),
                value=value,
                reference=threshold,
                outside=value >= threshold,
                now=is_now,
                pickups=in_hour,
            )
        )
    return CashByHourSeriesOut(
        reference=threshold,
        points=points,
        hours_over=sum(1 for p in points if p.outside),
        truncated=truncated,
    )


# ---------------------------------------------------------------------------
# Ficha de insumo: stock al cierre, 14 días + 7 proyectados
# ---------------------------------------------------------------------------

#: Causas que son consumo (lo que se va): venta, producción, merma.
_USE_CAUSES = ("sale", "production_out", "waste")


def stock_by_day(db: Session, *, ingredient: Any, store: Store) -> StockByDaySeriesOut:
    """Stock según el libro al cierre de cada uno de los últimos 14 días
    operativos cerrados (Σ de movimientos con `business_date <= d`), y 7
    días proyectados restando el consumo diario promedio de esos 14 días
    (venta, producción y merma; las compras no se proyectan: no se sabe
    cuándo llega la próxima). Punto del lado malo = en el mínimo o debajo."""
    from app.inventory.models import StockMovement

    base_unit = getattr(ingredient.base_unit, "value", str(ingredient.base_unit))
    min_stock = int(ingredient.min_stock)
    out = StockByDaySeriesOut(base_unit=base_unit, min_stock=format_qty_base(min_stock))
    if not features.is_enabled(
        db, store.organization_id, store.id, "inventory.perpetual"
    ):
        out.available = False
        out.reason = "El inventario perpetuo está apagado para esta sede: no hay libro del que leer el stock."
        return out
    today = tz.today_business_date(store.cutoff_hour)
    last_closed = today - timedelta(days=1)
    first_day = last_closed - timedelta(days=STOCK_CLOSED_DAYS - 1)
    ing_id = int(ingredient.id)

    opening = int(
        db.execute(
            select(func.coalesce(func.sum(StockMovement.qty_base), 0)).where(
                StockMovement.store_id == store.id,
                StockMovement.ingredient_id == ing_id,
                StockMovement.business_date < first_day,
            )
        ).scalar_one()
    )
    per_day: dict[date, int] = defaultdict(int)
    use = 0
    for bd, cause, qty in db.execute(
        select(
            StockMovement.business_date, StockMovement.cause, StockMovement.qty_base
        ).where(
            StockMovement.store_id == store.id,
            StockMovement.ingredient_id == ing_id,
            StockMovement.business_date >= first_day,
            StockMovement.business_date <= last_closed,
        )
    ).all():
        per_day[bd] += int(qty)
        if getattr(cause, "value", str(cause)) in _USE_CAUSES and int(qty) < 0:
            use += -int(qty)

    # Antes del primer movimiento del insumo no hay libro: «sin dato», no 0.
    first_move = db.execute(
        select(func.min(StockMovement.business_date)).where(
            StockMovement.store_id == store.id, StockMovement.ingredient_id == ing_id
        )
    ).scalar_one_or_none()
    running = opening
    points: list[StockDayPointOut] = []
    for i in range(STOCK_CLOSED_DAYS):
        d = first_day + timedelta(days=i)
        running += per_day.get(d, 0)
        if first_move is None or d < first_move:
            points.append(
                StockDayPointOut(
                    key=d.isoformat(), label=day_label(d), business_date=d, qty=None
                )
            )
            continue
        points.append(
            StockDayPointOut(
                key=d.isoformat(),
                label=day_label(d),
                business_date=d,
                qty=format_qty_base(running),
                outside=running <= min_stock,
            )
        )
        if running <= min_stock and out.below_min_on is None:
            out.below_min_on = d
    # Consumo diario promedio sobre los días cerrados CON libro (un insumo
    # nuevo no promedia contra días en que no existía).
    days_with_ledger = (
        (last_closed - max(first_day, first_move)).days + 1
        if first_move is not None and first_move <= last_closed
        else 0
    )
    daily_use = (
        money.round_half_up(use, days_with_ledger)
        if use > 0 and days_with_ledger > 0
        else 0
    )
    out.daily_use = format_qty_base(daily_use) if daily_use > 0 else None
    projected = running
    for k in range(STOCK_PROJECTED_DAYS):
        d = today + timedelta(days=k)
        projected -= daily_use
        shown = max(projected, 0)
        points.append(
            StockDayPointOut(
                key=d.isoformat(),
                label=day_label(d),
                business_date=d,
                qty=format_qty_base(shown),
                outside=shown <= min_stock,
                future=True,
                now=d == today,
            )
        )
        if shown <= min_stock and out.below_min_on is None:
            out.below_min_on = d
        if projected <= 0 and out.runs_out_on is None and daily_use > 0:
            out.runs_out_on = d
    out.points = points
    return out


# ---------------------------------------------------------------------------
# Hoy: los bullets de cada bloque
# ---------------------------------------------------------------------------


def _staff_by_hour(db: Session, store: Store, now: datetime) -> SeriesOut:
    """Personas en turno a la media hora de cada hora de hoy. Las horas que
    no pasaron van marcadas `future` con quienes están adentro ahora —no hay
    horario programado en el sistema: se supone que quien está sigue, y la
    serie lo dice—."""
    today = tz.today_business_date(store.cutoff_hour)
    rows = [
        r
        for r in shifts_hooks.attendance_rows(
            db, store_id=store.id, date_from=today, date_to=today
        )
        if r.status != "review"
    ]
    present_now = sum(1 for r in rows if r.out_at is None)
    points: list[SeriesPointOut] = []
    for h in STAFF_HOURS:
        start = _bogota_instant(today, h, store.cutoff_hour)
        end = start + timedelta(hours=1)
        if start > now:
            points.append(
                SeriesPointOut(
                    key=str(h), label=hour_label(h), value=present_now, future=True
                )
            )
            continue
        is_now = start <= now < end
        at = now if is_now else start + timedelta(minutes=30)
        count = sum(
            1 for r in rows if r.in_at <= at and (r.out_at is None or at < r.out_at)
        )
        points.append(
            SeriesPointOut(key=str(h), label=hour_label(h), value=count, now=is_now)
        )
    return SeriesOut(
        unit="people",
        bad_side="below",
        points=points,
        reason="Lo que viene es una proyección: quien está adentro ahora sigue hasta el cierre.",
    )


def _tables(db: Session, store: Store, now: datetime, limit: int) -> SeriesOut:
    points: list[SeriesPointOut] = []
    for o in service._open_orders_out(db, store, now):
        if o.channel != OrderChannel.DINE_IN.value:
            continue
        label = " + ".join(o.tables) if o.tables else f"#{o.id}"
        points.append(
            SeriesPointOut(
                key=str(o.id),
                label=label,
                value=o.minutes_since_opened,
                outside=o.minutes_since_opened > limit,
            )
        )
    points.sort(key=lambda p: -(p.value or 0))
    return SeriesOut(unit="minutes", bad_side="above", reference=limit, points=points)


_CHANNEL_SHORT = {
    "counter": "Mostrador",
    "takeout": "Llevar",
    "delivery": "Domicilio",
    "platform": "Plataforma",
}


def _tickets(db: Session, store: Store, limit: int) -> SeriesOut:
    from app.kitchen import hooks as kitchen_hooks

    tickets = kitchen_hooks.kitchen_tickets(db, store=store)
    if tickets is None:
        return SeriesOut(
            available=False,
            reason="La función «Cocina» está apagada para esta sede.",
            unit="minutes",
            bad_side="above",
            reference=limit,
        )
    points = [
        SeriesPointOut(
            key=str(t.round_id),
            label=" + ".join(t.tables)
            if t.tables
            else f"{_CHANNEL_SHORT.get(t.channel, 'Comanda')} #{t.order_id}",
            value=t.minutes,
            outside=t.minutes > limit,
        )
        for t in tickets
    ]
    return SeriesOut(unit="minutes", bad_side="above", reference=limit, points=points)


def panel_bullets(
    db: Session,
    store: Store,
    *,
    now: datetime,
    expected_cash: int | None,
    areas: list[Any],
) -> PanelBulletsOut:
    settings = _sales_settings(db, store)
    business_date = tz.today_business_date(store.cutoff_hour)
    _rows, today_total = service.aggregate_sales(
        db,
        store_id=store.id,
        date_from=business_date,
        date_to=business_date,
        group_by=None,
    )
    comparison, _hours = service._today_comparison(
        db,
        store,
        business_date=business_date,
        now=now,
        net=today_total.net,
        orders=today_total.orders,
        first_activity=service._first_activity_date(db, store.id),
    )
    sales = BulletOut(
        value=today_total.net,
        reference=comparison.net,
        bad_side="below",
        outside=comparison.net is not None and today_total.net < comparison.net,
        delta_bp=comparison.delta_bp,
        reason=comparison.null_reason,
    )
    cash: BulletOut | None = None
    if expected_cash is not None:
        threshold = stores_service.get_cash_settings(db, store.id).cash_pickup_threshold
        over = expected_cash >= threshold
        cash = BulletOut(
            value=expected_cash,
            reference=threshold,
            bad_side="above",
            outside=over,
            over_by=(expected_cash - threshold) if over else None,
        )
    progress = [
        AreaProgressOut(
            area_id=a.area_id,
            area_name=a.area_name,
            counted=a.opening_counted,
            total=a.opening_total,
            behind=bool(a.opening_missing),
        )
        for a in areas
    ]
    return PanelBulletsOut(
        sales=sales,
        reference_business_date=comparison.reference_business_date,
        cash=cash,
        staff_by_hour=_staff_by_hour(db, store, now),
        area_progress=progress,
        tables=_tables(db, store, now, settings.long_table_minutes),
        tickets=_tickets(db, store, settings.late_ticket_minutes),
        generated_at=now,
    )
