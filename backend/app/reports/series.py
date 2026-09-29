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
from app.core.money import format_cop
from app.core.percent import format_pct_bp
from app.reports.schemas import HourBucketOut, SalesBucketOut
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
    SectionCardOut,
    SectionOut,
    SectionRowOut,
    SeriesOut,
    SeriesPointOut,
    SeriesUnit,
    StockByDaySeriesOut,
    StockDayPointOut,
    StoresWeekSeriesOut,
    StoreWeekPointOut,
)
from app.shifts import hooks as shifts_hooks
from app.stores import service as stores_service
from app.shifts.models import BusinessDay, Shift, ShiftStatus
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
#: Un día con menos comandas que esto (el de la semana o su raya) no sostiene
#: un porcentaje: el punto sale con `low_base` y no cuenta como «por encima».
DAILY_LOW_BASE_ORDERS = 5

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


def date_label(d: date) -> str:
    """«mié 16 sep» — la fecha como la lee el dueño, nunca `2026-09-16`."""
    return f"{_WEEKDAY_SHORT[d.weekday()]} {d.day} {_MONTH_SHORT[d.month - 1]}"


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
    orders_by_day = {r.key: r.orders or 0 for r in rows}
    daily_low_base = service.low_base_orders(db, scope, "daily_low_base_orders", DAILY_LOW_BASE_ORDERS)
    points: list[SeriesPointOut] = []
    days_ref = days_above = 0
    best: tuple[int, str] | None = None
    day = date_from
    while day <= date_to:
        key = day.isoformat()
        ref_key = (day - timedelta(days=7)).isoformat()
        value = by_day.get(key)
        reference = by_day.get(ref_key)
        delta = service._delta_bp(value, reference)
        outside = value is not None and reference is not None and value < reference
        # Un día contra otro de 2 comandas no es una comparación: el punto se
        # dibuja igual, pero no suma a «N de M días por encima» ni compite
        # por «el mejor». Un día sin raya (la semana anterior no vendió) no
        # es un día «por encima»: no tiene contra qué.
        low_base = delta is not None and (
            min(orders_by_day.get(key, 0), orders_by_day.get(ref_key, 0)) < daily_low_base
        )
        if value is not None and reference is not None and reference > 0 and not low_base:
            days_ref += 1
            if value >= reference:
                days_above += 1
        if delta is not None and delta > 0 and not low_base and (best is None or delta > best[0]):
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
                low_base=low_base,
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
    truncated_reason: str | None = None
    if truncated:
        # Un turno abandonado de días dibujaba treinta columnas iguales: el
        # cajón no se movió en todas esas horas. Se dibuja hasta la última
        # hora en que la plata se movió (más una, para que se vea que quedó
        # quieta) y se dice en palabras dónde se cortó.
        last_move = 0
        for i in range(1, len(points)):
            if points[i].value != points[i - 1].value or points[i].pickups:
                last_move = i
        keep = min(len(points), last_move + 2)
        points = points[:keep]
        opened_label = date_label(tz.to_bogota(opened_at).date())
        truncated_reason = (
            f"El turno sigue abierto desde el {opened_label}. La plata del cajón no se "
            f"mueve desde las {points[last_move].label}: el dibujo se corta ahí."
        )
    return CashByHourSeriesOut(
        reference=threshold,
        points=points,
        hours_over=sum(1 for p in points if p.outside),
        truncated=truncated,
        truncated_reason=truncated_reason,
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


# ---------------------------------------------------------------------------
# Celular: Caja, Equipo e Informes (handoff, `MovilSecciones` variante A)
#
# Cuatro tarjetas por sección; cada una trae su cifra, su estado en palabras,
# la serie con su raya y la lista de excepciones. Igual que el resto de este
# módulo, ninguna cifra de plata nace acá: las ventas salen de
# `service.aggregate_sales` y `service._today_comparison` (las de Hoy); los
# cierres, retiros y gastos se LEEN de sus filas (`Shift.difference`,
# `CashPickup.amount`, `CashMovement.amount`), que ya escribió el dominio de
# caja; las horas trabajadas, del motor de jornada de nómina.
# ---------------------------------------------------------------------------

#: Días de la tendencia de las tarjetas «por día» (cuadre, consignaciones,
#: salidas olvidadas).
SECTION_TREND_DAYS = 14
#: Retiros y gastos: la semana anterior y hoy.
SECTION_WEEK_DAYS = 8
#: «Gastos de caja»: lo que se pagó con plata del cajón. El pago a un
#: proveedor y la liquidación de domicilios tienen su propia pantalla.
_CASH_EXPENSE_LABEL = {
    "petty_expense": "Gasto menor",
    "emergency_purchase": "Compra de urgencia",
    "other_expense": "Otro gasto",
}

LATE_ARRIVALS_REASON = (
    "No hay horario programado en el sistema: sin la hora de entrada esperada "
    "no se puede saber quién llegó tarde."
)
BEST_STORE_ONE_REASON = "Con una sola sede no hay con cuál comparar."
DEPOSITS_OFF_REASON = "La función «Consignaciones» está apagada en estas sedes."

_TONE_RANK = {"critical": 0, "warning": 1, "ok": 2, "muted": 3}


def clock_label(instant: datetime) -> str:
    """«11:30 a. m.», hora de pared de Bogotá."""
    local = tz.to_bogota(instant)
    h = local.hour % 12 or 12
    return f"{h}:{local.minute:02d} {'a. m.' if local.hour < 12 else 'p. m.'}"


def _count_word(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


def _window(end: date, days: int) -> list[date]:
    return [end - timedelta(days=days - 1 - i) for i in range(days)]


def _trend_label(d: date, today: date) -> str:
    if d == today:
        return "hoy"
    if d == today - timedelta(days=1):
        return "ayer"
    return day_label(d)


def _delta_text(delta_bp: int | None, reference_day: date | None) -> str | None:
    """«▲ +5,5 % vs sáb 20»; `None` sin variación (nunca «0 %» inventado)."""
    if delta_bp is None:
        return None
    arrow = "▲" if delta_bp >= 0 else "▼"
    sign = "+" if delta_bp > 0 else ""
    text = f"{arrow} {sign}{format_pct_bp(delta_bp)}"
    return f"{text} vs {day_label(reference_day)}" if reference_day is not None else text


def _by_tone(rows: list[SectionRowOut]) -> list[SectionRowOut]:
    return sorted(rows, key=lambda r: _TONE_RANK[r.tone])


def _unavailable(key: str, reason: str, unit: SeriesUnit = "count") -> SectionCardOut:
    return SectionCardOut(
        key=key,
        available=False,
        reason=reason,
        unit=unit,
        series=SeriesOut(available=False, reason=reason, unit=unit, bad_side="above"),
    )


def _day_values(
    days: list[date], values: dict[date, int], operated: set[date], *, today: date
) -> list[SeriesPointOut]:
    """Una barra por día: `None` (rayado) el día que ninguna sede abrió, el
    `0` de verdad el día que abrió y no pasó nada."""
    return [
        SeriesPointOut(
            key=d.isoformat(),
            label=_trend_label(d, today),
            value=values.get(d, 0) if d in operated else None,
            outside=False,
            now=d == today,
        )
        for d in days
    ]


# ---- Caja ------------------------------------------------------------------


def _closes_card(db: Session, stores: list[Store], today: date) -> SectionCardOut:
    """«¿Cuadraron los turnos de ayer?»: por sede, cómo cerró ayer; la serie
    es la diferencia de cierre (`Shift.difference`, la del cierre a ciegas)
    sumada por día, arriba sobra y abajo falta."""
    yesterday = today - timedelta(days=1)
    days = _window(yesterday, SECTION_TREND_DAYS)
    ids = [s.id for s in stores]
    found = db.execute(
        select(Shift, BusinessDay.business_date)
        .join(BusinessDay, BusinessDay.id == Shift.business_day_id)
        .where(
            Shift.store_id.in_(ids),
            BusinessDay.business_date >= days[0],
            BusinessDay.business_date <= yesterday,
            Shift.status != ShiftStatus.CANCELLED,
        )
        .order_by(Shift.opened_at, Shift.id)
    ).all()
    by_day: dict[date, int] = defaultdict(int)
    counted_days: set[date] = set()
    of_yesterday: dict[int, list[Shift]] = defaultdict(list)
    for shift, business_date in found:
        if (
            shift.status == ShiftStatus.CLOSED
            and not shift.closed_without_count
            and shift.difference is not None
        ):
            by_day[business_date] += shift.difference
            counted_days.add(business_date)
        if business_date == yesterday:
            of_yesterday[shift.store_id].append(shift)

    rows: list[SectionRowOut] = []
    squared = operated = short = over = unclosed = no_count = 0
    for s in stores:
        shifts = of_yesterday.get(s.id, [])
        key = str(s.id)
        if not shifts:
            rows.append(SectionRowOut(key=key, label=f"{s.name} · no abrió", note="No abrió", tone="muted"))
            continue
        operated += 1
        if any(x.status == ShiftStatus.OPEN for x in shifts):
            unclosed += 1
            rows.append(SectionRowOut(key=key, label=f"{s.name} · nadie cerró", note="Sin cierre", tone="critical"))
            continue
        label = f"{s.name} · cerró {shifts[-1].closed_by_employee_name or 'sin nombre'}"
        if any(x.closed_without_count for x in shifts):
            no_count += 1
            rows.append(SectionRowOut(key=key, label=label, note="Sin conteo", tone="critical"))
            continue
        diffs = [x.difference for x in shifts if x.difference is not None]
        if not diffs:
            rows.append(SectionRowOut(key=key, label=label, note="Sin dato", tone="muted"))
            continue
        diff = sum(diffs)
        if diff == 0:
            squared += 1
            rows.append(SectionRowOut(key=key, label=label, value=0, note="Cuadra", tone="ok"))
        elif diff < 0:
            short += 1
            rows.append(SectionRowOut(key=key, label=label, value=diff, tone="critical"))
        else:
            over += 1
            rows.append(SectionRowOut(key=key, label=label, value=diff, tone="warning"))

    parts = []
    if short:
        parts.append(_count_word(short, "faltante", "faltantes"))
    if over:
        parts.append(_count_word(over, "sobrante", "sobrantes"))
    if unclosed:
        parts.append(f"{unclosed} sin cerrar")
    if no_count:
        parts.append(f"{no_count} sin conteo")
    if operated == 0:
        status, tone = "Ayer no abrió ninguna sede", "muted"
    elif parts:
        status = " · ".join(parts)
        tone = "critical" if short or unclosed or no_count else "warning"
    else:
        status, tone = "Todos cuadraron", "ok"
    points = [
        SeriesPointOut(
            key=d.isoformat(),
            label=_trend_label(d, today),
            value=by_day[d] if d in counted_days else None,
            outside=d in counted_days and by_day[d] < 0,
            now=d == yesterday,
        )
        for d in days
    ]
    todas = ", todas las sedes" if len(stores) > 1 else ""
    return SectionCardOut(
        key="closes",
        unit="count",
        value=squared if operated else None,
        of=operated if operated else None,
        tone=tone,  # type: ignore[arg-type]
        status=status,
        note=f"Diferencia total de cierre por día{todas}. Arriba sobra, abajo falta.",
        chart="diverging",
        series=SeriesOut(unit="cop", bad_side="below", reference=0, points=points),
        rows=_by_tone(rows),
    )


def _deposits_card(db: Session, stores: list[Store], today: date) -> SectionCardOut:
    """«¿Qué consignaciones faltan por confirmar?»: las hechas desde la caja
    (con su foto) que el administrador todavía no confirmó ni rechazó."""
    from app.banking.models import BankDeposit, BankDepositStatus

    on = {
        s.id: s.name
        for s in stores
        if features.is_enabled(db, s.organization_id, s.id, "money.deposits")
    }
    if not on:
        return _unavailable("deposits", DEPOSITS_OFF_REASON, unit="cop")
    pending = list(
        db.execute(
            select(BankDeposit)
            .where(
                BankDeposit.store_id.in_(list(on)),
                BankDeposit.status == BankDepositStatus.LIVE,
                BankDeposit.confirmed_at.is_(None),
            )
            .order_by(BankDeposit.deposited_at, BankDeposit.id)
        ).scalars()
    )
    per_day: dict[date, int] = defaultdict(int)
    for d in pending:
        per_day[d.business_date] += 1
    points = [
        SeriesPointOut(
            key=d.isoformat(),
            label=_trend_label(d, today),
            value=per_day.get(d, 0),
            outside=per_day.get(d, 0) > 0,
            now=d == today,
        )
        for d in _window(today, SECTION_TREND_DAYS)
    ]
    rows = [
        SectionRowOut(
            key=str(d.id),
            label=(
                f"{on[d.store_id]} · consignó {d.employee_name} · "
                f"{day_label(d.business_date)} {clock_label(d.deposited_at)}"
            ),
            value=d.amount,
            tone="warning",
        )
        for d in pending
    ]
    return SectionCardOut(
        key="deposits",
        unit="cop",
        value=sum(d.amount for d in pending),
        tone="warning" if pending else "ok",
        status=f"{len(pending)} por confirmar" if pending else "Todo confirmado",
        note="Consignaciones hechas desde la caja que esperan tu confirmación, por día. Cada una trae la foto del comprobante.",
        series=SeriesOut(unit="count", bad_side="above", points=points),
        rows=rows,
    )


def _pickups_card(db: Session, stores: list[Store], today: date) -> SectionCardOut:
    """«¿Cuánto salió en retiros hoy?»: los retiros vivos (un retiro
    reversado no salió) por día, y las sedes con el efectivo sobre el umbral
    —la misma lectura que el semáforo de Hoy—."""
    from app.shifts import service as shifts_service
    from app.shifts.models import CashPickup

    ids = [s.id for s in stores]
    names = {s.id: s.name for s in stores}
    days = _window(today, SECTION_WEEK_DAYS)
    found = db.execute(
        select(CashPickup, BusinessDay.business_date)
        .join(Shift, Shift.id == CashPickup.shift_id)
        .join(BusinessDay, BusinessDay.id == Shift.business_day_id)
        .where(
            CashPickup.store_id.in_(ids),
            CashPickup.reversed_at.is_(None),
            BusinessDay.business_date >= days[0],
            BusinessDay.business_date <= today,
        )
        .order_by(CashPickup.at, CashPickup.id)
    ).all()
    per_day: dict[date, int] = defaultdict(int)
    of_today: list[Any] = []
    for pickup, business_date in found:
        per_day[business_date] += pickup.amount
        if business_date == today:
            of_today.append(pickup)
    suggested: list[Store] = []
    for s in stores:
        shift = shifts_service.get_current_shift(db, store=s)
        if shift is not None and shifts_service.cash_over_threshold(db, shift, s):
            suggested.append(s)
    operated = service._operated_dates(db, ids, days[0], today)
    rows = [
        SectionRowOut(key=f"s{s.id}", label=f"{s.name} · efectivo sobre el umbral", note="Sugerido", tone="warning")
        for s in suggested
    ] + [
        SectionRowOut(
            key=str(p.id),
            label=f"{names[p.store_id]} · {p.employee_name} · {clock_label(p.at)}",
            value=p.amount,
            tone="muted",
        )
        for p in of_today
    ]
    if suggested:
        quien = ", ".join(s.name for s in suggested)
        status = f"{quien} {'tiene' if len(suggested) == 1 else 'tienen'} uno sugerido"
        tone = "warning"
    elif of_today:
        status, tone = _count_word(len(of_today), "retiro hoy", "retiros hoy"), "ok"
    else:
        status, tone = "Sin retiros hoy", "muted"
    return SectionCardOut(
        key="pickups",
        unit="cop",
        value=per_day.get(today, 0) if today in operated else None,
        tone=tone,  # type: ignore[arg-type]
        status=status,
        note="Retiros a caja fuerte por día. La barra de hoy sigue creciendo.",
        series=SeriesOut(
            unit="cop", bad_side="above", points=_day_values(days, per_day, operated, today=today)
        ),
        rows=rows,
    )


def _expenses_card(db: Session, stores: list[Store], today: date) -> SectionCardOut:
    """«¿Cuánto se gastó de la caja hoy?»: los egresos del cajón con causa
    de gasto (`CashMovement`, causa tipada), y si traen foto."""
    from app.shifts.models import CashMovement, CashMovementCause, CashMovementKind

    ids = [s.id for s in stores]
    names = {s.id: s.name for s in stores}
    days = _window(today, SECTION_WEEK_DAYS)
    causes = [CashMovementCause(c) for c in _CASH_EXPENSE_LABEL]
    found = db.execute(
        select(CashMovement, BusinessDay.business_date)
        .join(Shift, Shift.id == CashMovement.shift_id)
        .join(BusinessDay, BusinessDay.id == Shift.business_day_id)
        .where(
            CashMovement.store_id.in_(ids),
            CashMovement.kind == CashMovementKind.EXPENSE,
            CashMovement.cause.in_(causes),
            BusinessDay.business_date >= days[0],
            BusinessDay.business_date <= today,
        )
        .order_by(CashMovement.at, CashMovement.id)
    ).all()
    per_day: dict[date, int] = defaultdict(int)
    of_today: list[Any] = []
    for movement, business_date in found:
        per_day[business_date] += movement.amount
        if business_date == today:
            of_today.append(movement)
    operated = service._operated_dates(db, ids, days[0], today)
    without_photo = sum(1 for m in of_today if not m.receipt_photo)
    rows = [
        SectionRowOut(
            key=str(m.id),
            label=(
                f"{names[m.store_id]} · {m.note or _CASH_EXPENSE_LABEL.get(m.cause.value, 'Gasto')} · "
                f"{clock_label(m.at)}"
            ),
            value=m.amount,
            note=None if m.receipt_photo else "sin foto",
            tone="muted" if m.receipt_photo else "warning",
        )
        for m in of_today
    ]
    if not of_today:
        status, tone = "Sin gastos hoy", "muted"
    elif without_photo:
        status, tone = _count_word(without_photo, "gasto sin foto", "gastos sin foto"), "warning"
    else:
        n = len(of_today)
        status = "1 gasto, con foto" if n == 1 else f"{n} gastos, todos con foto"
        tone = "ok"
    return SectionCardOut(
        key="expenses",
        unit="cop",
        value=per_day.get(today, 0) if today in operated else None,
        tone=tone,  # type: ignore[arg-type]
        status=status,
        note="Gastos pagados con plata de la caja, por día.",
        series=SeriesOut(
            unit="cop", bad_side="above", points=_day_values(days, per_day, operated, today=today)
        ),
        rows=_by_tone(rows),
    )


# ---- Equipo ----------------------------------------------------------------


def _staff_now_card(db: Session, stores: list[Store], now: datetime) -> SectionCardOut:
    """«¿Quién trabaja hoy?»: personas en turno por hora (la serie de Hoy,
    sumada sede por sede) y quién está adentro ahora."""
    per_store = [(s, _staff_by_hour(db, s, now), shifts_hooks.present_today(db, store_id=s.id)) for s in stores]
    points: list[SeriesPointOut] = []
    for i, h in enumerate(STAFF_HOURS):
        these = [serie.points[i] for _s, serie, _p in per_store]
        points.append(
            SeriesPointOut(
                key=str(h),
                label=hour_label(h),
                value=sum(p.value or 0 for p in these),
                future=all(p.future for p in these),
                now=any(p.now for p in these),
            )
        )
    present = sum(len(p) for _s, _serie, p in per_store)
    paused = sum(1 for _s, _serie, p in per_store for r in p if r.on_pause)
    rows = [
        SectionRowOut(key=str(s.id), label=s.name, value=len(p), unit="people", tone="ok" if p else "muted")
        for s, _serie, p in per_store
    ]
    todas = ", todas las sedes" if len(stores) > 1 else ""
    return SectionCardOut(
        key="staff",
        unit="people",
        value=present,
        tone="ok" if present else "muted",
        status=_count_word(paused, "en pausa", "en pausa") if paused else "Nadie en pausa",
        note=(
            f"Personas en turno por hora{todas}. Lo que viene sale más claro: no hay horario "
            "programado, así que se supone que quien está sigue hasta el cierre."
        ),
        series=SeriesOut(unit="people", bad_side="below", points=points),
        rows=rows,
    )


def _forgotten_exits_card(db: Session, stores: list[Store], today: date) -> SectionCardOut:
    """«¿Quién no marcó salida?»: las salidas olvidadas de la asistencia
    (no suman horas hasta que se corrigen)."""
    per_day: dict[date, int] = defaultdict(int)
    rows: list[SectionRowOut] = []
    for s in stores:
        for r in shifts_hooks.attendance_pending_review(db, store_id=s.id):
            per_day[r.business_date] += 1
            rows.append(
                SectionRowOut(
                    key=str(r.entry_id),
                    label=f"{r.employee_name} · {s.name} · entró {day_label(r.business_date)} {clock_label(r.in_at)}",
                    unit="count",
                    note="Sin salida",
                    tone="warning",
                )
            )
    points = [
        SeriesPointOut(
            key=d.isoformat(),
            label=_trend_label(d, today),
            value=per_day.get(d, 0),
            outside=per_day.get(d, 0) > 0,
            now=d == today,
        )
        for d in _window(today, SECTION_TREND_DAYS)
    ]
    n = len(rows)
    if n == 0:
        status = "Todas marcadas"
    elif n == 1:
        status = rows[0].label.split(" · ")[0]
    else:
        status = f"{n} por corregir"
    return SectionCardOut(
        key="exits",
        unit="count",
        value=n,
        tone="warning" if n else "ok",
        status=status,
        note="Salidas sin marcar por día. Cada una deja las horas de nómina sin cerrar hasta corregirla.",
        series=SeriesOut(unit="count", bad_side="above", points=points),
        rows=rows,
    )


def _week_hours_card(db: Session, stores: list[Store], today: date, now: datetime) -> SectionCardOut:
    """«¿Cómo van las horas de la semana?»: minutos trabajados por día según
    la asistencia, con el mismo motor de jornada de nómina (resta las
    pausas). Las salidas olvidadas no cuentan hasta corregirlas."""
    from app.payroll.service import _worked_intervals
    from app.shifts import attendance

    monday = today - timedelta(days=today.weekday())
    days = [monday + timedelta(days=i) for i in range(7)]
    per_day: dict[date, int] = defaultdict(int)
    per_store: dict[int, int] = defaultdict(int)
    for s in stores:
        store_today = attendance.business_date_now(db, s.id)
        for entry in attendance.list_entries(db, store_id=s.id, date_from=monday, date_to=today):
            if attendance.entry_status(entry, store_today) == "review":
                continue
            seconds = sum((b - a).total_seconds() for a, b in _worked_intervals(entry, until=now))
            minutes = int(seconds // 60)
            per_day[entry.business_date] += minutes
            per_store[s.id] += minutes
    points = [
        SeriesPointOut(
            key=d.isoformat(),
            label=day_label(d) if d != today else "hoy",
            value=None if d > today else per_day.get(d, 0),
            future=d > today,
            now=d == today,
        )
        for d in days
    ]
    total = sum(per_store.values())
    rows = [
        SectionRowOut(key=str(s.id), label=s.name, value=per_store.get(s.id, 0), unit="minutes", tone="muted")
        for s in stores
    ]
    return SectionCardOut(
        key="hours",
        unit="minutes",
        value=total,
        tone="ok" if total else "muted",
        status="Sin horas programadas para comparar",
        note=(
            "Horas trabajadas por día esta semana, según la asistencia. No hay horas programadas en el "
            "sistema: por eso no hay raya. Las salidas olvidadas no cuentan hasta corregirlas."
        ),
        series=SeriesOut(unit="minutes", bad_side="below", points=points),
        rows=rows,
    )


# ---- Informes --------------------------------------------------------------


class _StoreDay:
    """Lo de hoy de una sede: la misma lectura que `Hoy` (`today_report`)."""

    def __init__(self, db: Session, store: Store, now: datetime) -> None:
        self.store = store
        self.today = tz.today_business_date(store.cutoff_hour)
        docs = service._sale_documents(db, store_id=store.id, date_from=self.today, date_to=self.today)
        _rows, total = service.aggregate_sales(
            db, store_id=store.id, date_from=self.today, date_to=self.today, group_by=None
        )
        self.net = total.net
        self.orders = total.orders
        self.comparison, self.ref_hours = service._today_comparison(
            db,
            store,
            business_date=self.today,
            now=now,
            net=total.net,
            orders=total.orders,
            first_activity=service._first_activity_date(db, store.id),
        )
        self.hours = service._hour_buckets(
            docs, cutoff_hour=store.cutoff_hour, now_local_hour=tz.to_bogota(now).hour
        )
        self._by_hour = {b.hour: b for b in self.hours}
        self._ref_by_hour = {b.hour: b for b in self.ref_hours}

    def hour(self, h: int) -> HourBucketOut:
        return self._by_hour[h]

    def ref_hour(self, h: int) -> HourBucketOut:
        return self._ref_by_hour[h]


def _trimmed(points: list[SeriesPointOut]) -> list[SeriesPointOut]:
    """Sin las horas del principio en que no pasó nada (ni hoy ni la raya)."""
    for i, p in enumerate(points):
        if (p.value or 0) != 0 or (p.reference or 0) != 0:
            return points[i:]
    return points[-1:]


def _sales_today_card(
    db: Session, stores: list[Store], days: list[_StoreDay], now: datetime
) -> SectionCardOut:
    """«¿Vendo más o menos que la semana pasada?»: ventas netas acumuladas
    por hora contra el mismo día de la semana pasada, acumulado a la misma
    hora (la comparación de Hoy)."""
    ids = [s.id for s in stores]
    today = days[0].today
    _rows, total = service.aggregate_sales(db, store_id=ids, date_from=today, date_to=today, group_by=None)
    refs = [d.comparison.net for d in days]
    reference = sum(r for r in refs if r is not None) if all(r is not None for r in refs) else None
    delta = service._delta_bp(total.net, reference)
    ref_day = days[0].comparison.reference_business_date
    ref_hours_ok = all(d.ref_hours for d in days)

    points: list[SeriesPointOut] = []
    cum = 0
    ref_cum = 0
    for bucket in days[0].hours:
        if bucket.pending:
            break
        cum += sum(d.hour(bucket.hour).net for d in days)
        ref_cum += sum(d.ref_hour(bucket.hour).net for d in days) if ref_hours_ok else 0
        points.append(
            SeriesPointOut(
                key=str(bucket.hour),
                label=hour_label(bucket.hour),
                value=cum,
                reference=ref_cum if ref_hours_ok else None,
            )
        )
    if points:
        # La hora en curso: la raya es la de la misma hora al minuto (la
        # cifra de la tarjeta), no la hora entera de la semana pasada.
        last = points[-1]
        last.value = total.net
        last.reference = reference
        last.now = True
    points = _trimmed(points)
    for p in points:
        p.delta_bp = service._delta_bp(p.value, p.reference)
        p.outside = p.value is not None and p.reference is not None and p.value < p.reference

    rows = [
        SectionRowOut(
            key=str(d.store.id),
            label=d.store.name,
            value=d.net,
            tone=(
                "warning"
                if d.comparison.net is not None and d.net < d.comparison.net
                else "ok" if d.net > 0 else "muted"
            ),
        )
        for d in days
    ]
    # «12:54 p. m.» ya termina en punto: no se le pone otro.
    note = f"Ventas netas acumuladas hasta las {clock_label(now)}"
    if reference is not None:
        note += f" El {day_label(ref_day)} a esta hora iba en {format_cop(reference)}."
    else:
        note += " " + (next((d.comparison.null_reason for d in days if d.comparison.null_reason), None) or "")
    status = _delta_text(delta, ref_day)
    return SectionCardOut(
        key="sales",
        unit="cop",
        value=total.net,
        tone="muted" if delta is None else "ok" if delta >= 0 else "warning",
        status=status or "Sin comparación con la semana pasada",
        note=note.strip(),
        chart="dual",
        series=SeriesOut(unit="cop", bad_side="below", points=points),
        rows=rows,
    )


def _best_store_card(stores: list[Store], days: list[_StoreDay]) -> SectionCardOut:
    """«¿Qué sede va mejor hoy?»: el cambio de cada una contra su mismo día
    de la semana pasada a la misma hora."""
    if len(stores) < 2:
        return _unavailable("best_store", BEST_STORE_ONE_REASON, unit="bp")
    ranked = sorted(days, key=lambda d: (d.comparison.delta_bp is None, -(d.comparison.delta_bp or 0)))
    points = [
        SeriesPointOut(
            key=str(d.store.id),
            label=d.store.name,
            value=d.comparison.delta_bp,
            outside=d.comparison.delta_bp is not None and d.comparison.delta_bp < 0,
        )
        for d in ranked
    ]
    rows = [
        SectionRowOut(
            key=str(d.store.id),
            label=d.store.name,
            value=d.comparison.delta_bp,
            unit="bp",
            note=None if d.comparison.delta_bp is not None else "Sin comparación",
            tone=(
                "muted"
                if d.comparison.delta_bp is None
                else "ok" if d.comparison.delta_bp >= 0 else "critical"
            ),
        )
        for d in ranked
    ]
    best = next((d for d in ranked if d.comparison.delta_bp is not None), None)
    ref_day = days[0].comparison.reference_business_date
    if best is None:
        return SectionCardOut(
            key="best_store",
            unit="bp",
            tone="muted",
            status="Ninguna sede tiene con qué comparar",
            note=f"Cambio contra el {day_label(ref_day)} a la misma hora.",
            chart="diverging",
            series=SeriesOut(unit="bp", bad_side="below", reference=0, points=points),
            rows=rows,
        )
    assert best.comparison.delta_bp is not None
    return SectionCardOut(
        key="best_store",
        unit="bp",
        value=best.comparison.delta_bp,
        value_text=best.store.name,
        tone="ok" if best.comparison.delta_bp >= 0 else "warning",
        status=_delta_text(best.comparison.delta_bp, ref_day),
        note=f"Cambio contra el {day_label(ref_day)} a la misma hora.",
        chart="diverging",
        series=SeriesOut(unit="bp", bad_side="below", reference=0, points=points),
        rows=rows,
    )


def _load_card(db: Session, stores: list[Store], today: date, now: datetime) -> SectionCardOut:
    """«¿A qué horas necesito más gente?»: comandas de salón por hora de
    hoy contra lo que alcanzan los meseros en turno (la misma cuenta que
    «Horas pico» de Informes). Lo que viene es lo del mismo día de la semana
    pasada, al 35 %."""
    ids = [s.id for s in stores]
    ref_day = today - timedelta(days=7)
    orders = _orders_by_day_hour(db, ids, date_from=ref_day, date_to=today)
    opw = {s.id: _sales_settings(db, s).orders_per_waiter for s in stores}
    waiters = {
        s.id: _waiters_by_day_hour(db, s, date_from=today, date_to=today, hours=PEAK_HOURS) for s in stores
    }
    cutoff = stores[0].cutoff_hour
    points: list[PeakHourPointOut] = []
    for h in PEAK_HOURS:
        start = _bogota_instant(today, h, cutoff)
        if start > now:
            points.append(
                PeakHourPointOut(
                    key=str(h), label=hour_label(h), value=orders.get((ref_day, h), 0), future=True
                )
            )
            continue
        w_total = sum(waiters[s.id].get((today, h), 0) for s in stores)
        capacity = sum(waiters[s.id].get((today, h), 0) * opw[s.id] for s in stores)
        value = orders.get((today, h), 0)
        points.append(
            PeakHourPointOut(
                key=str(h),
                label=hour_label(h),
                value=value,
                reference=capacity,
                delta_bp=service._delta_bp(value, capacity),
                outside=value > capacity,
                now=start <= now < start + timedelta(hours=1),
                waiters=w_total,
            )
        )
    common = set(opw.values())
    opw_text = f"{next(iter(common))} por mesero" if len(common) == 1 else "según cada sede"
    over = [p for p in points if p.outside and not p.future]
    rows = [
        SectionRowOut(
            key=p.key,
            label=f"{p.label} · {_count_word(p.waiters or 0, 'mesero', 'meseros')}",
            value=p.value,
            unit="count",
            tone="warning",
        )
        for p in over
    ]
    note = (
        f"Comandas de salón por hora contra lo que alcanzan los meseros en turno ({opw_text}). "
        f"Lo que viene, más claro, es lo del {day_label(ref_day)}."
    )
    series_out = SeriesOut(
        unit="count",
        bad_side="above",
        points=[SeriesPointOut(**p.model_dump(exclude={"waiters"})) for p in points],
    )
    if not over:
        return SectionCardOut(
            key="load",
            unit="count",
            value_text="Cubierto",
            tone="ok",
            status=f"Ninguna hora pasó de {opw_text}",
            note=note,
            chart="dual",
            series=series_out,
            rows=rows,
        )
    worst = max(over, key=lambda p: (p.value or 0) - (p.reference or 0))
    i = points.index(worst)
    start_i = end_i = i
    while start_i > 0 and points[start_i - 1].outside and not points[start_i - 1].future:
        start_i -= 1
    while end_i < len(points) - 1 and points[end_i + 1].outside and not points[end_i + 1].future:
        end_i += 1
    run = points[start_i : end_i + 1]
    run_orders = sum(p.value or 0 for p in run)
    run_waiters = sum(p.waiters or 0 for p in run)
    first_h = PEAK_HOURS[start_i]
    last_h = PEAK_HOURS[end_i] + 1
    if run_waiters > 0:
        tenths = money.round_half_up(run_orders * 10, run_waiters)
        per = f"{tenths // 10},{tenths % 10}" if tenths % 10 else str(tenths // 10)
        status = f"{per} comandas por mesero"
    else:
        status = "Sin meseros en turno"
    return SectionCardOut(
        key="load",
        unit="count",
        value=run_orders,
        value_text=f"{hour_label(first_h)} a {hour_label(last_h)}",
        tone="warning",
        status=status,
        note=note,
        chart="dual",
        series=series_out,
        rows=rows,
    )


def _orders_today_card(
    db: Session, stores: list[Store], days: list[_StoreDay]
) -> SectionCardOut:
    """«¿Cuántas comandas llevamos?»: comandas pagadas hoy, por hora, contra
    el mismo día de la semana pasada a la misma hora, con el ticket
    promedio de la misma agregación de Ventas."""
    ids = [s.id for s in stores]
    today = days[0].today
    by_channel, total = service.aggregate_sales(
        db, store_id=ids, date_from=today, date_to=today, group_by="channel"
    )
    refs = [d.comparison.orders for d in days]
    reference = sum(r for r in refs if r is not None) if all(r is not None for r in refs) else None
    delta = service._delta_bp(total.orders, reference)
    points: list[SeriesPointOut] = []
    for bucket in days[0].hours:
        if bucket.pending:
            break
        points.append(
            SeriesPointOut(
                key=str(bucket.hour),
                label=hour_label(bucket.hour),
                value=sum(d.hour(bucket.hour).orders for d in days),
            )
        )
    if points:
        points[-1].now = True
    points = _trimmed(points)
    parts = [t for t in (_delta_text(delta, None),) if t]
    if total.avg_ticket is not None:
        parts.append(f"ticket {format_cop(total.avg_ticket)}")
    rows = [
        SectionRowOut(key=r.key, label=r.label, value=r.orders, unit="count", tone="muted")
        for r in by_channel
    ]
    todas = ", todas las sedes" if len(stores) > 1 else ""
    return SectionCardOut(
        key="orders",
        unit="count",
        value=total.orders,
        tone="muted" if delta is None else "ok" if delta >= 0 else "warning",
        status=" · ".join(parts) if parts else "Todavía sin comandas pagadas",
        note=f"Comandas pagadas por hora{todas}.",
        series=SeriesOut(unit="count", bad_side="below", points=points),
        rows=rows,
    )


def sections(db: Session, *, stores: list[Store], all_stores: bool, section: str) -> SectionOut:
    """Las cuatro tarjetas de una sección del celular (`caja`, `equipo` o
    `informes`), para una sede o para todas."""
    now = clock.now_utc()
    today = tz.today_business_date(stores[0].cutoff_hour)
    cards: list[SectionCardOut]
    if section == "caja":
        cards = [
            _closes_card(db, stores, today),
            _deposits_card(db, stores, today),
            _pickups_card(db, stores, today),
            _expenses_card(db, stores, today),
        ]
    elif section == "equipo":
        cards = [
            _staff_now_card(db, stores, now),
            _unavailable("late", LATE_ARRIVALS_REASON),
            _forgotten_exits_card(db, stores, today),
            _week_hours_card(db, stores, today, now),
        ]
    else:
        days = [_StoreDay(db, s, now) for s in stores]
        cards = [
            _sales_today_card(db, stores, days, now),
            _best_store_card(stores, days),
            _load_card(db, stores, today, now),
            _orders_today_card(db, stores, days),
        ]
    return SectionOut(
        section=section,  # type: ignore[arg-type]
        scope="all" if all_stores else "store",
        store_ids=[s.id for s in stores],
        generated_at=now,
        cards=cards,
    )
