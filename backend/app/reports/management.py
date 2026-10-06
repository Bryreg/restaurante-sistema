"""Gestión del período: lo que el dueño mira para decidir, en Informes y en
Hoy (`GET /admin/reports/management`, `GET /admin/reports/month`).

- **Rotación de mesas y RevPASH** (h2).
- **Costo primo** (h3): costo de lo vendido + mano de obra.
- **Mano de obra contra la venta, por hora** (h4).
- **Ranking de anulaciones, descuentos y cortesías por persona** (h8).
- **«¿Le puedo creer a estos números?»** (h10).
- **Ritmo hacia la meta del mes** (h6, en `accountant.goal_pace`).

**No hay una segunda matemática.** La venta sale de
`service.aggregate_sales`; el costo de lo vendido y la nómina, de
`app.expenses.hooks` (los mismos de Utilidad); los minutos trabajados por
hora, de `app.payroll.hooks` (la jornada que liquida la nómina); la varianza
y la antigüedad del último conteo, de `app.inventory.hooks`. Este módulo
divide, reparte (`money.prorate`) y redacta; la interfaz sólo pinta.
"""

from __future__ import annotations

import importlib
from collections import defaultdict
from datetime import date, timedelta
from types import ModuleType

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit.models import AuditLog
from app.core import features, tz
from app.core import hours as hours_mod
from app.core.modules import find_spec_safe
from app.orders import money
from app.orders.models import Order, OrderDiscount, OrderItem, OrderItemStatus
from app.reports import accountant, panel, service
from app.reports.schemas import (
    AuthorizerCountOut,
    ControlPersonRowOut,
    ControlsRankingOut,
    LaborByHourOut,
    LaborHourOut,
    ManagementOut,
    PrimeCostOut,
    ReliabilityItemOut,
    ReliabilityOut,
    TodayMonthOut,
    TurnoverOut,
)
from app.shifts.models import BusinessDay, Shift, ShiftStatus
from app.stores.models import Store, Table, Zone


def _bp(numerator: int, denominator: int) -> int | None:
    """`numerator / denominator` en puntos básicos, con signo; `None` sin
    denominador positivo."""
    if denominator <= 0:
        return None
    magnitude = money.round_half_up(abs(numerator) * 10_000, denominator)
    return -magnitude if numerator < 0 else magnitude


def _hooks(db: Session, store: Store, *, module: str, feature: str | None) -> ModuleType | None:
    if find_spec_safe(module) is None:
        return None
    if feature is not None and not features.is_enabled(db, store.organization_id, store.id, feature):
        return None
    return importlib.import_module(module)


# ---------------------------------------------------------------------------
# Rotación de mesas y RevPASH (h2).
# ---------------------------------------------------------------------------


def _clock_minutes(text: str) -> int | None:
    try:
        hh, mm = text.split(":")
        value = int(hh) * 60 + int(mm)
    except (ValueError, AttributeError):
        return None
    return value if 0 <= value <= 24 * 60 else None


def scheduled_open_minutes(store: Store, *, date_from: date, date_to: date) -> int | None:
    """Minutos abiertos según el horario de la sede (`opening_hours`,
    `weekday` 0 = lunes) en los días del período. Un cierre igual o antes de
    la apertura cruza la medianoche. `None` si la sede no tiene horario."""
    schedule = [h for h in (store.opening_hours or []) if isinstance(h, dict)]
    if not schedule:
        return None
    per_weekday: dict[int, int] = defaultdict(int)
    for entry in schedule:
        opens = _clock_minutes(str(entry.get("open", "")))
        closes = _clock_minutes(str(entry.get("close", "")))
        weekday = entry.get("weekday")
        if opens is None or closes is None or not isinstance(weekday, int):
            continue
        span = closes - opens if closes > opens else closes + 24 * 60 - opens
        per_weekday[weekday] += span
    if not per_weekday:
        return None
    total = 0
    day = date_from
    while day <= date_to:
        total += per_weekday.get(day.weekday(), 0)
        day += timedelta(days=1)
    return total


def _seats_and_tables(db: Session, store: Store) -> tuple[int, int]:
    rows = db.execute(
        select(Table.seats)
        .join(Zone, Zone.id == Table.zone_id)
        .where(Table.store_id == store.id, Table.active.is_(True), Zone.active.is_(True))
    ).all()
    return sum(int(r[0] or 0) for r in rows), len(rows)


def turnover(db: Session, *, store: Store, date_from: date, date_to: date, net_sales: int) -> TurnoverOut:
    by_channel, _ = service.aggregate_sales(
        db, store_id=store.id, date_from=date_from, date_to=date_to, group_by="channel"
    )
    dine_in = next((r for r in by_channel if r.key == "dine_in"), None)
    dine_in_orders = int(dine_in.orders) if dine_in is not None else 0
    dine_in_covers = dine_in.covers if dine_in is not None else None
    services = len(service._operated_dates(db, store.id, date_from, date_to))
    open_minutes = scheduled_open_minutes(store, date_from=date_from, date_to=date_to)

    tables_on = features.is_enabled(db, store.organization_id, store.id, "pos.tables")
    seats, tables = _seats_and_tables(db, store) if tables_on else (0, 0)

    orders_bp = covers_bp = None
    turnover_reason: str | None = None
    if not tables_on:
        turnover_reason = "La sede no atiende en mesas (función «Mesas» apagada): no hay rotación que medir."
    elif tables == 0 or seats == 0:
        turnover_reason = "La sede no tiene mesas con sillas cargadas: cargalas en Configuración → Zonas y mesas."
    elif services == 0:
        turnover_reason = "La sede no abrió ningún día del período: no hubo servicios."
    else:
        orders_bp = money.round_half_up(dine_in_orders * 10_000, tables * services)
        covers_bp = (
            money.round_half_up(dine_in_covers * 10_000, seats * services) if dine_in_covers is not None else None
        )

    revpash: int | None = None
    revpash_reason: str | None = None
    seat_hours: str | None = None
    if not tables_on or seats == 0:
        revpash_reason = turnover_reason
    elif open_minutes is None:
        revpash_reason = "La sede no tiene horario de atención cargado: cargalo en Configuración → Sedes."
    elif open_minutes == 0:
        revpash_reason = "Según el horario, la sede no abre ningún día de este período."
    elif net_sales < 0:
        revpash_reason = "La venta neta del período es negativa: no hay ingreso por silla que medir."
    else:
        seat_minutes = seats * open_minutes
        seat_hours = hours_mod.format_hours(seat_minutes)
        # venta ÷ (sillas × minutos ÷ 60) = venta × 60 ÷ silla-minutos.
        revpash = money.round_half_up(net_sales * 60, seat_minutes)

    return TurnoverOut(
        seats=seats if tables_on and seats else None,
        tables=tables if tables_on and tables else None,
        services=services,
        open_hours=hours_mod.format_hours(open_minutes) if open_minutes is not None else None,
        seat_hours=seat_hours,
        dine_in_orders=dine_in_orders,
        dine_in_covers=dine_in_covers,
        orders_per_table_service_bp=orders_bp,
        covers_per_seat_service_bp=covers_bp,
        turnover_reason=turnover_reason,
        net_sales=net_sales,
        revpash=revpash,
        revpash_reason=revpash_reason,
    )


# ---------------------------------------------------------------------------
# Costo primo (h3).
# ---------------------------------------------------------------------------


def _expenses_hooks() -> ModuleType | None:
    if find_spec_safe("app.expenses.hooks") is None:
        return None
    return importlib.import_module("app.expenses.hooks")


def prime_cost(db: Session, *, store: Store, date_from: date, date_to: date) -> PrimeCostOut:
    _rows, total = service.aggregate_sales(db, store_id=store.id, date_from=date_from, date_to=date_to, group_by=None)
    net = int(total.net)
    hooks = _expenses_hooks()
    if hooks is None:
        missing = "El costo de lo vendido y la nómina no están disponibles en este momento."
        return PrimeCostOut(
            date_from=date_from, date_to=date_to, net_sales=net, cost_of_goods=None, cost_basis=None,
            cost_theoretical=None, cost_real=None, cost_real_reason=None, cost_reason=missing, labor=None,
            labor_reason=missing, prime_cost=None, prime_cost_pct_bp=None, cost_pct_bp=None, labor_pct_bp=None,
            reason=missing,
        )
    cog = hooks.cost_of_goods(db, store=store, date_from=date_from, date_to=date_to)
    labor, labor_reason = hooks.labor_cost(db, store=store, date_from=date_from, date_to=date_to)
    prime: int | None = None
    reason: str | None = cog.reason if cog.amount is None else labor_reason if labor is None else None
    if cog.amount is not None and labor is not None:
        prime = int(cog.amount) + int(labor)
    if prime is not None and net <= 0:
        reason = "No hubo venta neta en el período: el costo primo no se puede medir contra la venta."
    return PrimeCostOut(
        date_from=date_from,
        date_to=date_to,
        net_sales=net,
        cost_of_goods=cog.amount,
        cost_basis=cog.basis,
        cost_theoretical=cog.theoretical,
        cost_real=cog.real,
        cost_real_reason=cog.real_reason,
        cost_reason=cog.reason,
        labor=labor,
        labor_reason=labor_reason,
        prime_cost=prime,
        prime_cost_pct_bp=_bp(prime, net) if prime is not None else None,
        cost_pct_bp=_bp(cog.amount, net) if cog.amount is not None else None,
        labor_pct_bp=_bp(labor, net) if labor is not None else None,
        reason=reason,
    )


# ---------------------------------------------------------------------------
# Mano de obra contra la venta, por hora (h4).
# ---------------------------------------------------------------------------


def labor_by_hour(db: Session, *, store: Store, date_from: date, date_to: date) -> LaborByHourOut:
    by_hour, _ = service.aggregate_sales(db, store_id=store.id, date_from=date_from, date_to=date_to, group_by="hour")
    net_by_hour = {int(r.key): int(r.net) for r in by_hour}
    payroll = _hooks(db, store, module="app.payroll.hooks", feature="payroll")
    order = service._hours_from_cutoff(store.cutoff_hour)

    minutes: dict[int, int] = {h: 0 for h in range(24)}
    labor_total: int | None = None
    reason: str | None = None
    if payroll is None:
        reason = (
            "La sede no lleva la nómina en el sistema: sin horas trabajadas no hay mano de obra por hora. "
            "Prendé «Nómina» en Admin → Funciones."
        )
    else:
        minutes = payroll.worked_minutes_by_hour(db, store_id=store.id, date_from=date_from, date_to=date_to) or minutes
        hooks = _expenses_hooks()
        labor_total, labor_reason = (
            hooks.labor_cost(db, store=store, date_from=date_from, date_to=date_to) if hooks is not None else (None, None)
        )
        if labor_total is None:
            reason = labor_reason or "La nómina del período no está disponible."
        elif sum(minutes.values()) == 0:
            reason = "Nadie marcó horas trabajadas en el período: no hay mano de obra que repartir por hora."

    shares: dict[int, int | None] = {h: None for h in range(24)}
    if reason is None and labor_total is not None:
        weights = [minutes[h] for h in order]
        for h, share in zip(order, money.prorate(labor_total, weights)):
            shares[h] = share

    active = [h for h in order if net_by_hour.get(h, 0) != 0 or minutes[h] > 0]
    visible = order[order.index(active[0]) : order.index(active[-1]) + 1] if active else []
    hours_out = [
        LaborHourOut(
            hour=h,
            label=f"{h:02d}:00",
            net=net_by_hour.get(h, 0),
            worked_hours=hours_mod.format_hours(minutes[h]),
            labor=shares[h],
            labor_pct_bp=_bp(shares[h], net_by_hour.get(h, 0)) if shares[h] is not None else None,  # type: ignore[arg-type]
            outside=(shares[h] > net_by_hour.get(h, 0)) if shares[h] is not None else None,  # type: ignore[operator]
        )
        for h in visible
    ]
    return LaborByHourOut(
        available=reason is None,
        reason=reason,
        labor_total=labor_total if reason is None else None,
        worked_hours_total=hours_mod.format_hours(sum(minutes.values())),
        hours=hours_out,
    )


# ---------------------------------------------------------------------------
# Anulaciones, descuentos y cortesías por persona (h8).
# ---------------------------------------------------------------------------

_NO_AUTHORIZER = "Sin autorización"
_UNKNOWN_PERSON = "Sin registro de quién la pidió"


class _PersonAgg:
    def __init__(self, employee_id: int | None, name: str) -> None:
        self.employee_id = employee_id
        self.name = name
        self.counts = {"voids": 0, "discounts": 0, "courtesies": 0}
        self.amounts = {"voids": 0, "discounts": 0, "courtesies": 0}
        self.authorizers: dict[str, list[int]] = defaultdict(lambda: [0, 0])


def controls_ranking(db: Session, *, store: Store, date_from: date, date_to: date, net_sales: int) -> ControlsRankingOut:
    scope = [Order.store_id == store.id, Order.business_date >= date_from, Order.business_date <= date_to]
    people: dict[tuple[int | None, str], _PersonAgg] = {}
    by_authorizer: dict[str, list[int]] = defaultdict(lambda: [0, 0])

    def add(kind: str, employee_id: int | None, name: str | None, authorizer: str | None, amount: int) -> None:
        label = name or _UNKNOWN_PERSON
        agg = people.setdefault((employee_id, label), _PersonAgg(employee_id, label))
        agg.counts[kind] += 1
        agg.amounts[kind] += amount
        auth = authorizer or _NO_AUTHORIZER
        agg.authorizers[auth][0] += 1
        agg.authorizers[auth][1] += amount
        by_authorizer[auth][0] += 1
        by_authorizer[auth][1] += amount

    for item in db.execute(
        select(OrderItem).join(Order, OrderItem.order_id == Order.id).where(OrderItem.voided_at.is_not(None), *scope)
    ).scalars():
        add("voids", item.voided_by_employee_id, item.voided_by_employee_name, item.void_authorized_by_employee_name,
            panel.void_amount(item))

    for discount in db.execute(
        select(OrderDiscount)
        .join(Order, OrderDiscount.order_id == Order.id)
        .where(OrderDiscount.voided_at.is_(None), *scope)
    ).scalars():
        add("discounts", discount.employee_id, discount.employee_name, discount.authorized_by_employee_name,
            int(discount.amount))

    courtesies = list(
        db.execute(
            select(OrderItem)
            .join(Order, OrderItem.order_id == Order.id)
            .where(OrderItem.courtesy_reason.is_not(None), OrderItem.status != OrderItemStatus.VOIDED, *scope)
        ).scalars()
    )
    # La cortesía no guarda en el ítem quién la pidió: lo dice la auditoría
    # del cambio (`order_item` / `courtesy`), escrita con la persona activa.
    requested_by: dict[str, tuple[int | None, str | None]] = {}
    if courtesies:
        for log in db.execute(
            select(AuditLog).where(
                AuditLog.store_id == store.id,
                AuditLog.entity == "order_item",
                AuditLog.action == "courtesy",
                AuditLog.entity_id.in_([str(i.id) for i in courtesies]),
            )
        ).scalars():
            requested_by[log.entity_id] = (log.actor_employee_id, log.actor_employee_name)
    for item in courtesies:
        emp_id, emp_name = requested_by.get(str(item.id), (None, None))
        add("courtesies", emp_id, emp_name, item.courtesy_authorized_by_employee_name, panel.courtesy_amount(item))

    def auth_list(source: dict[str, list[int]]) -> list[AuthorizerCountOut]:
        return [
            AuthorizerCountOut(name=name, count=c, amount=a)
            for name, (c, a) in sorted(source.items(), key=lambda kv: (-kv[1][1], -kv[1][0], kv[0]))
        ]

    rows = [
        ControlPersonRowOut(
            employee_id=p.employee_id,
            employee_name=p.name,
            voids_count=p.counts["voids"],
            voids_amount=p.amounts["voids"],
            discounts_count=p.counts["discounts"],
            discounts_amount=p.amounts["discounts"],
            courtesies_count=p.counts["courtesies"],
            courtesies_amount=p.amounts["courtesies"],
            total_count=sum(p.counts.values()),
            total_amount=sum(p.amounts.values()),
            authorizers=auth_list(p.authorizers),
        )
        for p in people.values()
    ]
    rows.sort(key=lambda r: (-r.total_amount, -r.total_count, r.employee_name))
    total_amount = sum(r.total_amount for r in rows)
    return ControlsRankingOut(
        rows=rows,
        by_authorizer=auth_list(by_authorizer),
        total_count=sum(r.total_count for r in rows),
        total_amount=total_amount,
        net_sales=net_sales,
        total_pct_of_sales_bp=_bp(total_amount, net_sales),
    )


# ---------------------------------------------------------------------------
# «¿Le puedo creer a estos números?» (h10).
# ---------------------------------------------------------------------------


def _plural(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


def reliability(db: Session, *, store: Store, date_from: date, date_to: date) -> ReliabilityOut:
    items: list[ReliabilityItemOut] = []
    today = tz.today_business_date(store.cutoff_hour)

    def item(key: str, severity: str, title: str, detail: str, affects: str, count: int | None = None) -> None:
        items.append(
            ReliabilityItemOut(key=key, severity=severity, title=title, detail=detail, affects=affects, count=count)  # type: ignore[arg-type]
        )

    # Inventario: el último conteo completo (`inventory_staleness`, el
    # umbral de la sede, `INVENTORY_STALE_DAYS` por defecto).
    inventory = _hooks(db, store, module="app.inventory.hooks", feature="inventory.counts")
    if inventory is not None:
        staleness = inventory.inventory_staleness(db, store_id=store.id, cutoff_hour=store.cutoff_hour)
        if staleness.days_since_last_full_count is None:
            item(
                "inventory_never_counted", "critical", "Nunca se hizo un conteo completo de inventario",
                "Sin un conteo completo no se sabe cuánto se usó de verdad: el costo real y la varianza no existen.",
                "Costo real, varianza, utilidad con costo real",
            )
        elif staleness.unreliable:
            item(
                "inventory_stale", "warning",
                f"El inventario no se cuenta hace {_plural(staleness.days_since_last_full_count, 'día', 'días')}",
                f"Pasados {staleness.stale_days} días sin conteo completo, el stock y el costo real se alejan de lo "
                "que hay en la bodega.",
                "Stock, costo real, varianza",
                staleness.days_since_last_full_count,
            )

    # Venta sin costo y platos que no descontaron nada.
    _rows, total = service.aggregate_sales(db, store_id=store.id, date_from=date_from, date_to=date_to, group_by=None)
    expenses = _expenses_hooks()
    costed_min = int(expenses.COSTED_PCT_MIN) if expenses is not None else 100
    if total.orders and total.costed_pct is not None and total.costed_pct < 100:
        item(
            "uncosted_sales", "critical" if total.costed_pct < costed_min else "warning",
            f"El {100 - total.costed_pct} % de lo vendido no tiene costo",
            "Lo vendido sin ficha técnica o sin costo entra con costo cero: el margen, el costo primo y la "
            "utilidad salen mejores de lo que son.",
            "Costo de lo vendido, margen, costo primo, utilidad",
            100 - total.costed_pct,
        )
    recipes = _hooks(db, store, module="app.recipes.hooks", feature="catalog.recipes")
    if recipes is not None:
        uncosted = recipes.uncosted_products(db, store_id=store.id, date_from=date_from, date_to=date_to)
        if uncosted:
            item(
                "uncosted_products", "warning",
                f"{_plural(len(uncosted), 'plato vendido', 'platos vendidos')} sin receta",
                "Se vendieron sin ficha técnica ni insumo directo: no descontaron inventario y no tienen costo.",
                "Inventario, costo de lo vendido",
                len(uncosted),
            )

    # Turnos sin cerrar (de días anteriores) y cierres sin revisar del período.
    open_old = len(
        db.execute(
            select(Shift.id)
            .join(BusinessDay, BusinessDay.id == Shift.business_day_id)
            .where(Shift.store_id == store.id, Shift.status == ShiftStatus.OPEN, BusinessDay.business_date < today)
        ).scalars().all()
    )
    if open_old:
        item(
            "shifts_open", "critical", f"{_plural(open_old, 'turno', 'turnos')} de días anteriores sin cerrar",
            "Mientras un turno no se cierra, su venta, su efectivo y su diferencia no están completos.",
            "Ventas, caja, consignaciones", open_old,
        )
    unreviewed = len(
        db.execute(
            select(Shift.id)
            .join(BusinessDay, BusinessDay.id == Shift.business_day_id)
            .where(
                Shift.store_id == store.id,
                Shift.status == ShiftStatus.CLOSED,
                Shift.reviewed_by_employee_id.is_(None),
                BusinessDay.business_date >= date_from,
                BusinessDay.business_date <= date_to,
            )
        ).scalars().all()
    )
    if unreviewed:
        item(
            "shifts_unreviewed", "warning", f"{_plural(unreviewed, 'cierre', 'cierres')} de caja sin revisar",
            "Nadie revisó esos cierres: una diferencia o un movimiento mal cargado sigue contando.",
            "Caja, diferencias", unreviewed,
        )

    # Nómina: horas a revisar, tablas, parámetros, tarifas y contratos.
    payroll = _hooks(db, store, module="app.payroll.hooks", feature="payroll")
    if payroll is not None:
        from app.shifts import hooks as shifts_hooks

        pending = len(shifts_hooks.attendance_pending_review(db, store_id=store.id))
        if pending:
            item(
                "attendance_review", "warning", f"{_plural(pending, 'salida olvidada', 'salidas olvidadas')} a revisar",
                "Esas horas no cuentan hasta que alguien escriba la hora de salida.",
                "Nómina, mano de obra, costo primo", pending,
            )
        gaps = payroll.payroll_gaps(db, store_id=store.id, date_from=date_from, date_to=date_to)
        if gaps is not None and gaps.no_surcharge_table:
            item(
                "payroll_no_tables", "critical", "No hay tabla de recargos de nómina",
                "Sin ella la nómina no se calcula: la mano de obra, el costo primo y la utilidad quedan sin dato.",
                "Nómina, costo primo, utilidad",
            )
        elif gaps is not None:
            if gaps.unconfirmed_surcharge_tables:
                item(
                    "payroll_tables_unconfirmed", "warning", "La tabla de recargos vigente no la confirmó nadie",
                    "Los recargos nocturnos, dominicales y de horas extra salen de valores que nadie revisó.",
                    "Nómina, costo primo", gaps.unconfirmed_surcharge_tables,
                )
            if gaps.legal_params_unconfirmed:
                item(
                    "payroll_legal_unconfirmed", "warning", "Los parámetros legales de nómina no están confirmados",
                    "Salario mínimo, auxilio y aportes salen de los valores de ley cargados de fábrica.",
                    "Nómina, costo primo",
                )
            if gaps.without_wage:
                names = ", ".join(gaps.without_wage[:3]) + ("…" if len(gaps.without_wage) > 3 else "")
                item(
                    "payroll_without_wage", "critical",
                    f"{_plural(len(gaps.without_wage), 'persona trabajó', 'personas trabajaron')} sin tarifa por hora",
                    f"{names}: sin tarifa, la nómina del período no se puede calcular.",
                    "Nómina, costo primo, utilidad", len(gaps.without_wage),
                )
            if gaps.without_contract:
                names = ", ".join(gaps.without_contract[:3]) + ("…" if len(gaps.without_contract) > 3 else "")
                item(
                    "payroll_without_contract", "warning",
                    f"{_plural(len(gaps.without_contract), 'persona', 'personas')} sin contrato cargado",
                    f"{names}: sin contrato sólo cuentan sus horas, sin aportes ni prestaciones; el costo de la "
                    "nómina sale más bajo de lo que es.",
                    "Nómina, costo primo, utilidad", len(gaps.without_contract),
                )

    # Configuración que pide el RevPASH.
    if features.is_enabled(db, store.organization_id, store.id, "pos.tables"):
        seats, _tables = _seats_and_tables(db, store)
        if seats == 0:
            item(
                "no_table_seats", "warning", "Las mesas no tienen sillas cargadas",
                "Sin sillas no hay rotación por silla ni RevPASH.", "Rotación de mesas, RevPASH",
            )
        if scheduled_open_minutes(store, date_from=date_from, date_to=date_to) is None:
            item(
                "no_opening_hours", "warning", "La sede no tiene horario de atención",
                "Sin horario no se sabe cuántas horas estuvo abierta: el RevPASH no se puede calcular.", "RevPASH",
            )

    severity_rank = {"critical": 0, "warning": 1}
    items.sort(key=lambda i: severity_rank[i.severity])
    return ReliabilityOut(date_from=date_from, date_to=date_to, reliable=not items, items=items)


# ---------------------------------------------------------------------------
# Las dos respuestas.
# ---------------------------------------------------------------------------


def management(db: Session, *, store: Store, date_from: date, date_to: date) -> ManagementOut:
    service._validate_range(date_from, date_to)
    _rows, total = service.aggregate_sales(db, store_id=store.id, date_from=date_from, date_to=date_to, group_by=None)
    net = int(total.net)
    return ManagementOut(
        store_id=store.id,
        date_from=date_from,
        date_to=date_to,
        reliability=reliability(db, store=store, date_from=date_from, date_to=date_to),
        turnover=turnover(db, store=store, date_from=date_from, date_to=date_to, net_sales=net),
        prime_cost=prime_cost(db, store=store, date_from=date_from, date_to=date_to),
        labor_by_hour=labor_by_hour(db, store=store, date_from=date_from, date_to=date_to),
        controls=controls_ranking(db, store=store, date_from=date_from, date_to=date_to, net_sales=net),
    )


def today_month(db: Session, *, store: Store) -> TodayMonthOut:
    """Lo del mes en curso que Hoy muestra compacto: el ritmo hacia la meta,
    el costo primo del mes hasta hoy y el aviso de confiabilidad del mes."""
    today = tz.today_business_date(store.cutoff_hour)
    first = today.replace(day=1)
    return TodayMonthOut(
        store_id=store.id,
        date_from=first,
        date_to=today,
        goal_pace=accountant.goal_pace(db, store=store),
        prime_cost=prime_cost(db, store=store, date_from=first, date_to=today),
        reliability=reliability(db, store=store, date_from=first, date_to=today),
    )
