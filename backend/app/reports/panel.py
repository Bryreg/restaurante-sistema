"""El panel de control del administrador y sus fichas relacionales.

«El panel de admin es un panel de control sobre todo lo que está pasando en
el restaurante. Todo debe ser relacional y coherente.» — el dueño.

**Coherente quiere decir que una misma cosa se calcula en un solo lugar.**
Este módulo no tiene matemática propia de plata ni de estado: cada número
sale de la función que ya lo calculaba para otra pantalla, y por eso el
panel no puede decir algo distinto de ellas.

- El turno abierto: `shifts_service.get_current_shift` (la misma de `Hoy`),
  sea del día que sea. Su esperado, con `compute_breakdown`.
- El salón: `orders_service.tables_status` y `service._sweep_stale_orders`
  (las mismas de la tarjeta «Comandas abiertas» de `Hoy`).
- El conteo por área: `service._area_counts_tray` (la tarjeta de `Hoy`).
- La cocina: `app.kitchen.hooks.kitchen_load` (el color del KDS).
- Las ventas de un turno o de una persona: `service.aggregate_sales` (la de
  `Ventas` e `Informes`).

Lo único que se decide acá es el **semáforo** de cada sede (`_light`), y las
razones viajan con él: un color sin su porqué no se le cree.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit.models import AuditLog
from app.auth.models import Employee
from app.banking import hooks as banking_hooks
from app.core import clock, features, tz
from app.core.errors import AppError
from app.core.quantity import format_qty_base
from app.orders import service as orders_service
from app.orders.models import Order, OrderDiscount, OrderItem
from app.reports import service
from app.reports.panel_schemas import (
    EmployeeRecordOut,
    IngredientCauseTotalOut,
    IngredientCountLineOut,
    IngredientRecordOut,
    PanelAreaCountsOut,
    PanelCashOut,
    PanelKitchenOut,
    PanelLight,
    PanelOut,
    PanelPendingOut,
    PanelReasonOut,
    PanelSalonOut,
    PanelStaffOut,
    PanelStaffPersonOut,
    PersonRefOut,
    RecordAreaCountOut,
    RecordAttendanceOut,
    RecordDepositOut,
    RecordDiscountOut,
    RecordNoveltyOut,
    RecordShiftRowOut,
    RecordVoidOut,
    ShiftRecordOut,
    StorePanelOut,
)
from app.reports.schemas import SalesBucketOut
from app.shifts import service as shifts_service
from app.shifts.models import BusinessDay, Shift, ShiftRoster, ShiftStatus
from app.stores.models import Store

#: Acciones de auditoría del roster que dicen «esta persona marcó entrada»
#: (`app.shifts.service.roster_action` y la reapertura de un turno). Una
#: fila del roster sin ninguna de estas nació de identificarse en la tablet.
CLOCK_IN_ACTIONS = ("in", "in_on_reopen")

#: Rango por defecto de una ficha sin fechas: los últimos 30 días operativos.
RECORD_DEFAULT_DAYS = 30
#: Máximo de filas de una lista de ficha (lo más reciente primero).
RECORD_LIST_LIMIT = 200


# ---------------------------------------------------------------------------
# Personas: el nombre congelado + si hoy sigue activa
# ---------------------------------------------------------------------------


def _active_map(db: Session, ids: set[int]) -> dict[int, bool]:
    if not ids:
        return {}
    rows = db.execute(select(Employee.id, Employee.active).where(Employee.id.in_(ids))).all()
    return {int(i): bool(a) for i, a in rows}


def _person(db: Session, employee_id: int, frozen_name: str) -> PersonRefOut:
    active = _active_map(db, {employee_id}).get(employee_id, False)
    return PersonRefOut(id=employee_id, name=frozen_name, active=active)


# ---------------------------------------------------------------------------
# El turno abierto y quién trabaja
# ---------------------------------------------------------------------------


def current_cash(db: Session, store: Store) -> PanelCashOut | None:
    """El turno abierto de la sede, de cualquier día. Si pasó la hora de
    corte del día siguiente es abandonado: además de marcarlo, se emite (o
    se deja como estaba, deduplicada por día) la notificación
    `shift_stale`, para que la campana no dependa de que una tablet esté
    prendida preguntando por el turno."""
    shift = shifts_service.get_current_shift(db, store=store)
    if shift is None:
        return None
    day = db.get(BusinessDay, shift.business_day_id)
    assert day is not None
    stale = shifts_service.notify_if_stale(db, shift, store)
    return PanelCashOut(
        shift_id=shift.id,
        business_date=day.business_date,
        opened_at=shift.opened_at,
        responsible=_person(db, shift.cash_responsible_id, shift.cash_responsible_name),
        is_stale=stale,
        stale_since=shifts_service.end_of_business_day(db, shift, store),
        cash_over_threshold=shifts_service.cash_over_threshold(db, shift, store),
        expected_cash=shifts_service.compute_breakdown(db, shift)["expected"],
    )


def _clocked_in_entry_ids(db: Session, entry_ids: list[int]) -> set[int]:
    if not entry_ids:
        return set()
    rows = db.execute(
        select(AuditLog.entity_id).where(
            AuditLog.entity == "shift_roster",
            AuditLog.entity_id.in_([str(i) for i in entry_ids]),
            AuditLog.action.in_(CLOCK_IN_ACTIONS),
        )
    ).scalars()
    return {int(r) for r in rows}


def _attendance(db: Session, entries: list[ShiftRoster], shifts: dict[int, Shift]) -> list[RecordAttendanceOut]:
    """Asistencia: una fila por entrada del roster, con si la persona marcó
    entrada o sólo se identificó. El responsable de caja cuenta siempre
    como presente: tiene el cajón."""
    clocked = _clocked_in_entry_ids(db, [e.id for e in entries])
    day_ids = {s.business_day_id for s in shifts.values()}
    dates = (
        {d.id: d.business_date for d in db.execute(select(BusinessDay).where(BusinessDay.id.in_(day_ids))).scalars()}
        if day_ids
        else {}
    )
    out: list[RecordAttendanceOut] = []
    for e in entries:
        shift = shifts.get(e.shift_id)
        is_responsible = shift is not None and shift.cash_responsible_id == e.employee_id
        out.append(
            RecordAttendanceOut(
                shift_id=e.shift_id,
                business_date=dates.get(shift.business_day_id) if shift is not None else None,
                employee_id=e.employee_id,
                employee_name=e.employee_name,
                in_at=e.in_at,
                out_at=e.out_at,
                clocked_in=e.id in clocked or is_responsible,
            )
        )
    return out


def present_staff(db: Session, cash: PanelCashOut | None) -> PanelStaffOut:
    """Quién trabaja ahora: las entradas abiertas del roster del turno
    abierto, separando a quien marcó entrada de quien sólo se identificó.

    **Costura declarada.** El roster es hoy la única fuente de asistencia;
    cuando exista una tabla propia de asistencia, esta función es el único
    lugar del panel que cambia."""
    if cash is None:
        return PanelStaffOut(clocked_in=[], identified_only=[], reason="No hay un turno abierto.")
    if cash.is_stale:
        return PanelStaffOut(
            clocked_in=[],
            identified_only=[],
            reason=(
                f"El turno abierto es del {cash.business_date.isoformat()} y nadie lo cerró: "
                "su lista no dice quién está hoy."
            ),
        )
    shift = db.get(Shift, cash.shift_id)
    assert shift is not None
    entries = list(
        db.execute(
            select(ShiftRoster)
            .where(ShiftRoster.shift_id == shift.id, ShiftRoster.out_at.is_(None))
            .order_by(ShiftRoster.in_at)
        ).scalars()
    )
    attendance = _attendance(db, entries, {shift.id: shift})
    active = _active_map(db, {e.employee_id for e in entries})
    clocked: list[PanelStaffPersonOut] = []
    identified: list[PanelStaffPersonOut] = []
    for e, a in zip(entries, attendance, strict=True):
        pauses = e.pauses or []
        person = PanelStaffPersonOut(
            employee_id=e.employee_id,
            name=e.employee_name,
            since=e.in_at,
            on_pause=bool(pauses) and pauses[-1].get("end") is None,
            active=active.get(e.employee_id, False),
        )
        (clocked if a.clocked_in else identified).append(person)
    return PanelStaffOut(clocked_in=clocked, identified_only=identified, reason=None)


# ---------------------------------------------------------------------------
# El panel de una sede
# ---------------------------------------------------------------------------


def _area_counts(db: Session, store: Store) -> PanelAreaCountsOut:
    tray = service._area_counts_tray(db, store)
    areas = tray["area_counts_areas"]
    return PanelAreaCountsOut(
        enabled=bool(tray["area_counts_enabled"]),
        areas_total=len(areas),
        # `opening_missing` lo publica el conteo compartido cuando existe
        # (la apertura cuenta como hecha sólo completa); sin él, la regla de
        # siempre: hay un conteo de apertura.
        opening_done=sum(
            1 for a in areas if (not a.opening_missing if a.opening_missing is not None else a.opening is not None)
        ),
        closing_done=sum(1 for a in areas if a.closing is not None),
        flagged=sum(1 for f in tray["area_counts_flags"] if f.flagged),
        pending_recounts=int(tray["area_recounts_pending_count"]),
    )


def _salon(db: Session, store: Store, now: datetime) -> PanelSalonOut:
    tables = orders_service.tables_status(db, store_id=store.id)
    unsent, unpaid = service._sweep_stale_orders(db, store, now)
    open_orders = len(service._open_orders_out(db, store, now))
    return PanelSalonOut(
        tables_occupied=sum(1 for z in tables.zones for t in z.tables if t.status != "free"),
        tables_total=sum(len(z.tables) for z in tables.zones),
        open_orders=open_orders,
        unsent=unsent,
        unpaid=unpaid,
    )


def _kitchen(db: Session, store: Store) -> PanelKitchenOut:
    from app.kitchen import hooks as kitchen_hooks

    load = kitchen_hooks.kitchen_load(db, store=store)
    return PanelKitchenOut(
        enabled=load.enabled,
        in_kitchen=load.in_kitchen,
        late=load.late,
        very_late=load.very_late,
        oldest_late_minutes=load.oldest_late_minutes,
    )


def _pending(db: Session, store: Store) -> PanelPendingOut:
    deposits = service._deposits_tray(db, store)
    routine = service._pos_routine_tray(db, store)
    return PanelPendingOut(
        deposits_to_confirm=int(deposits["deposits_to_confirm_count"]),
        requests_pending=int(routine["requests_pending_count"]),
        novelties_open=int(routine["novelties_open_count"]),
        novelties_urgent=int(routine["novelties_urgent_count"]),
        unreviewed_closes=service._unreviewed_closes_count(db, store),
    )


def _plural(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


def _reasons(
    cash: PanelCashOut | None,
    area: PanelAreaCountsOut,
    salon: PanelSalonOut,
    kitchen: PanelKitchenOut,
    pending: PanelPendingOut,
) -> list[PanelReasonOut]:
    """Las razones del semáforo, con las mismas palabras y la misma gravedad
    que los avisos de `Hoy` para el mismo hecho."""
    out: list[PanelReasonOut] = []

    def add(key: str, level: str, text: str) -> None:
        out.append(PanelReasonOut(key=key, level=level, text=text))  # type: ignore[arg-type]

    if cash is None:
        # Igual que «Sin turno abierto» de Hoy: crítico, porque sin turno no se vende.
        add("no_shift", "critical", "Sin turno abierto: no se puede vender.")
    else:
        if cash.is_stale:
            add(
                "shift_stale",
                "critical",
                f"Turno abandonado: sigue abierto desde el {cash.business_date.isoformat()}.",
            )
        if not cash.responsible.active:
            add(
                "responsible_inactive",
                "warning",
                f"La caja está a nombre de {cash.responsible.name}, que ya no está activo.",
            )
        if cash.cash_over_threshold:
            add("cash_over_threshold", "warning", "Efectivo sobre el umbral: conviene un retiro.")
    if pending.novelties_urgent > 0:
        add("novelties_urgent", "critical", _plural(pending.novelties_urgent, "novedad urgente", "novedades urgentes") + ".")
    elif pending.novelties_open > 0:
        add("novelties_open", "warning", _plural(pending.novelties_open, "novedad sin resolver", "novedades sin resolver") + ".")
    if area.enabled and area.flagged > 0:
        add("area_count_flags", "warning", _plural(area.flagged, "faltante", "faltantes") + " del conteo por área sobre el umbral.")
    if area.enabled and area.areas_total > area.opening_done:
        missing = area.areas_total - area.opening_done
        add("area_counts_missing", "critical", _plural(missing, "área sin conteo", "áreas sin conteo") + " de apertura.")
    if salon.unsent > 0 or salon.unpaid > 0:
        parts = []
        if salon.unsent > 0:
            parts.append(f"{salon.unsent} sin enviar")
        if salon.unpaid > 0:
            parts.append(f"{salon.unpaid} sin cobrar")
        add("stale_orders", "warning", "Comandas atascadas: " + " · ".join(parts) + ".")
    if kitchen.enabled and kitchen.late > 0:
        add("kitchen_late", "warning", _plural(kitchen.late, "plato pasado", "platos pasados") + " de su tiempo en cocina.")
    if pending.deposits_to_confirm > 0:
        add(
            "deposits_to_confirm",
            "warning",
            _plural(pending.deposits_to_confirm, "consignación por confirmar", "consignaciones por confirmar") + ".",
        )
    if pending.requests_pending > 0:
        add(
            "requests_pending",
            "warning",
            _plural(pending.requests_pending, "solicitud del salón", "solicitudes del salón") + " por resolver.",
        )
    if pending.unreviewed_closes > 0:
        add("unreviewed_closes", "info", _plural(pending.unreviewed_closes, "cierre sin revisar", "cierres sin revisar") + ".")
    rank = {"critical": 0, "warning": 1, "info": 2}
    out.sort(key=lambda r: rank[r.level])
    return out


def _light(reasons: list[PanelReasonOut]) -> PanelLight:
    if any(r.level == "critical" for r in reasons):
        return "red"
    if any(r.level == "warning" for r in reasons):
        return "amber"
    return "green"


def store_panel(db: Session, store: Store, *, now: datetime) -> StorePanelOut:
    cash = current_cash(db, store)
    area = _area_counts(db, store)
    salon = _salon(db, store, now)
    kitchen = _kitchen(db, store)
    pending = _pending(db, store)
    reasons = _reasons(cash, area, salon, kitchen, pending)
    return StorePanelOut(
        store_id=store.id,
        store_name=store.name,
        business_date=tz.today_business_date(store.cutoff_hour),
        light=_light(reasons),
        reasons=reasons,
        cash=cash,
        staff=present_staff(db, cash),
        area_counts=area,
        salon=salon,
        kitchen=kitchen,
        pending=pending,
    )


def panel(db: Session, *, stores: list[Store], all_stores: bool) -> PanelOut:
    now = clock.now_utc()
    return PanelOut(
        scope="all" if all_stores else "store",
        generated_at=now,
        stores=[store_panel(db, s, now=now) for s in stores],
    )


# ---------------------------------------------------------------------------
# Fichas: lo que se relaciona con un turno, una persona, un insumo
# ---------------------------------------------------------------------------


def _voids(db: Session, stmt_where: list[Any]) -> list[RecordVoidOut]:
    rows = db.execute(
        select(OrderItem, Order)
        .join(Order, OrderItem.order_id == Order.id)
        .where(OrderItem.voided_at.is_not(None), *stmt_where)
        .order_by(OrderItem.voided_at.desc())
        .limit(RECORD_LIST_LIMIT)
    ).all()
    return [
        RecordVoidOut(
            order_id=order.id,
            item_name=item.name,
            qty=item.qty,
            amount=int(item.unit_price) * int(item.qty),
            reason=item.void_reason.value if item.void_reason is not None else None,
            voided_at=item.voided_at,
            voided_by=item.voided_by_employee_name,
            authorized_by=item.void_authorized_by_employee_name,
            after_bill=bool(item.void_after_bill),
        )
        for item, order in rows
    ]


def _discounts(db: Session, discount_where: list[Any], courtesy_where: list[Any]) -> list[RecordDiscountOut]:
    """Descuentos vivos y cortesías, con los montos que cuenta la actividad
    de la persona: el descuento con su `amount`; la cortesía a precio de
    carta (`list_price × qty`)."""
    out: list[RecordDiscountOut] = []
    for d, order in db.execute(
        select(OrderDiscount, Order)
        .join(Order, OrderDiscount.order_id == Order.id)
        .where(OrderDiscount.voided_at.is_(None), *discount_where)
        .order_by(OrderDiscount.at.desc())
        .limit(RECORD_LIST_LIMIT)
    ).all():
        out.append(
            RecordDiscountOut(
                order_id=order.id,
                kind="discount",
                amount=int(d.amount),
                reason=getattr(d.reason, "value", d.reason),
                employee_name=d.employee_name,
                authorized_by=d.authorized_by_employee_name,
                at=d.at,
            )
        )
    for item, order in db.execute(
        select(OrderItem, Order)
        .join(Order, OrderItem.order_id == Order.id)
        .where(OrderItem.courtesy_reason.is_not(None), *courtesy_where)
        .order_by(OrderItem.courtesy_at.desc())
        .limit(RECORD_LIST_LIMIT)
    ).all():
        out.append(
            RecordDiscountOut(
                order_id=order.id,
                kind="courtesy",
                amount=int(item.list_price) * int(item.qty),
                reason=getattr(item.courtesy_reason, "value", item.courtesy_reason),
                employee_name=None,
                authorized_by=item.courtesy_authorized_by_employee_name,
                at=item.courtesy_at,
            )
        )
    # Lo más reciente primero; sin instante, al final.
    out.sort(key=lambda r: (r.at is not None, r.at.timestamp() if r.at is not None else 0.0), reverse=True)
    return out


def _sales_row(rows: list[SalesBucketOut], key: str) -> SalesBucketOut | None:
    for r in rows:
        if r.key == key:
            return r
    return None


def shift_record(db: Session, *, shift: Shift) -> ShiftRecordOut:
    store = db.get(Store, shift.store_id)
    assert store is not None
    day = db.get(BusinessDay, shift.business_day_id)
    assert day is not None

    # Las ventas del turno: `aggregate_sales(group_by="shift")` sobre los
    # días en que el turno emitió documentos (un turno abandonado puede
    # cobrar pasada su fecha).
    from app.fiscal.models import FiscalDocument
    from sqlalchemy import func

    bounds = db.execute(
        select(func.min(FiscalDocument.business_date), func.max(FiscalDocument.business_date)).where(
            FiscalDocument.shift_id == shift.id
        )
    ).one()
    sales: SalesBucketOut | None = None
    if bounds[0] is not None:
        rows, _total = service.aggregate_sales(
            db, store_id=store.id, date_from=bounds[0], date_to=bounds[1], group_by="shift"
        )
        sales = _sales_row(rows, str(shift.id))

    deposit: RecordDepositOut | None = None
    if features.is_enabled(db, store.organization_id, store.id, "money.deposits") and shift.status == ShiftStatus.CLOSED:
        deposit = RecordDepositOut(
            deposited_total=banking_hooks.allocated_live(db, shift.id),
            to_deposit=shift.to_deposit,
            outstanding=banking_hooks.outstanding_of(db, shift),
        )

    from app.novelties.models import Novelty

    novelties = [
        RecordNoveltyOut(
            id=n.id,
            title=n.title,
            level=getattr(n.level, "value", str(n.level)),
            category=getattr(n.category, "value", str(n.category)),
            employee_name=n.employee_name,
            created_at=n.created_at,
            resolved_at=n.resolved_at,
        )
        for n in db.execute(
            select(Novelty).where(Novelty.shift_id == shift.id).order_by(Novelty.created_at)
        ).scalars()
    ]

    # Conteos por área hechos mientras el turno estuvo abierto (el conteo no
    # guarda el turno: se relaciona por sede e instante).
    from app.inventory.models import AreaCount

    until = shift.closed_at or clock.now_utc()
    area_counts = [
        RecordAreaCountOut(
            count_id=c.id,
            area_name=c.area_name,
            moment=getattr(c.moment, "value", str(c.moment)),
            counted_at=c.counted_at,
            employee_name=c.employee_name,
        )
        for c in db.execute(
            select(AreaCount)
            .where(AreaCount.store_id == store.id, AreaCount.counted_at >= shift.opened_at, AreaCount.counted_at <= until)
            .order_by(AreaCount.counted_at)
        ).scalars()
    ]

    roster = list(db.execute(select(ShiftRoster).where(ShiftRoster.shift_id == shift.id).order_by(ShiftRoster.in_at)).scalars())

    return ShiftRecordOut(
        shift_id=shift.id,
        store_id=store.id,
        store_name=store.name,
        business_date=day.business_date,
        status=getattr(shift.status, "value", str(shift.status)),
        opened_at=shift.opened_at,
        closed_at=shift.closed_at,
        is_stale=shifts_service.is_shift_stale(db, shift, store),
        responsible=_person(db, shift.cash_responsible_id, shift.cash_responsible_name),
        opened_by=_person(db, shift.opened_by_employee_id, shift.opened_by_employee_name),
        closed_by=shift.closed_by_employee_name,
        reviewed=shift.reviewed_at is not None,
        sales=sales,
        deposit=deposit,
        voids=_voids(db, [Order.shift_id == shift.id]),
        discounts=_discounts(db, [Order.shift_id == shift.id], [Order.shift_id == shift.id]),
        novelties=novelties,
        area_counts=area_counts,
        attendance=_attendance(db, roster, {shift.id: shift}),
    )


def _record_range(date_from: date | None, date_to: date | None, *, cutoff_hour: int) -> tuple[date, date]:
    to = date_to or tz.today_business_date(cutoff_hour)
    frm = date_from or (to - timedelta(days=RECORD_DEFAULT_DAYS - 1))
    service._validate_range(frm, to)
    return frm, to


def employee_record(
    db: Session, *, employee: Employee, store: Store, date_from: date | None, date_to: date | None
) -> EmployeeRecordOut:
    frm, to = _record_range(date_from, date_to, cutoff_hour=store.cutoff_hour)
    rows, _total = service.aggregate_sales(db, store_id=store.id, date_from=frm, date_to=to, group_by="employee")
    charged = _sales_row(rows, str(employee.id))

    shift_rows = list(
        db.execute(
            select(Shift, BusinessDay.business_date)
            .join(BusinessDay, Shift.business_day_id == BusinessDay.id)
            .where(
                Shift.store_id == store.id,
                Shift.cash_responsible_id == employee.id,
                BusinessDay.business_date >= frm,
                BusinessDay.business_date <= to,
            )
            .order_by(BusinessDay.business_date.desc(), Shift.id.desc())
        ).all()
    )
    shifts_out = [
        RecordShiftRowOut(
            shift_id=s.id,
            business_date=bd,
            status=getattr(s.status, "value", str(s.status)),
            is_stale=shifts_service.is_shift_stale(db, s, store),
            difference=s.difference,
            closed_without_count=bool(s.closed_without_count),
        )
        for s, bd in shift_rows
    ]

    roster = list(
        db.execute(
            select(ShiftRoster, Shift)
            .join(Shift, ShiftRoster.shift_id == Shift.id)
            .join(BusinessDay, Shift.business_day_id == BusinessDay.id)
            .where(
                ShiftRoster.employee_id == employee.id,
                Shift.store_id == store.id,
                BusinessDay.business_date >= frm,
                BusinessDay.business_date <= to,
            )
            .order_by(ShiftRoster.in_at.desc())
            .limit(RECORD_LIST_LIMIT)
        ).all()
    )
    attendance = _attendance(db, [r for r, _s in roster], {s.id: s for _r, s in roster})

    scope = [Order.store_id == store.id, Order.business_date >= frm, Order.business_date <= to]
    return EmployeeRecordOut(
        employee=PersonRefOut(id=employee.id, name=employee.name, active=bool(employee.active)),
        role=employee.role,
        store_id=employee.store_id,
        date_from=frm,
        date_to=to,
        charged=charged,
        shifts_as_responsible=shifts_out,
        attendance=attendance,
        voids=_voids(db, [OrderItem.voided_by_employee_id == employee.id, *scope]),
        discounts=_discounts(
            db,
            [OrderDiscount.employee_id == employee.id, *scope],
            [OrderItem.courtesy_authorized_by_employee_id == employee.id, *scope],
        ),
    )


def ingredient_record(
    db: Session, *, ingredient: Any, store: Store, date_from: date | None, date_to: date | None
) -> IngredientRecordOut:
    """El insumo en el período: su stock según el libro, lo que entró y
    salió por causa (compra, venta, merma, conteo, traslado…) y sus conteos
    por área. Las cantidades son sumas del libro de movimientos
    (`StockMovement`), el único asiento del inventario."""
    from app.inventory import hooks as inventory_hooks
    from app.inventory.models import AreaCount, AreaCountLine, StockMovement

    frm, to = _record_range(date_from, date_to, cutoff_hour=store.cutoff_hour)
    perpetual = features.is_enabled(db, store.organization_id, store.id, "inventory.perpetual")
    stock = (
        format_qty_base(inventory_hooks.current_stock(db, store_id=store.id, ingredient_id=ingredient.id))
        if perpetual
        else None
    )
    by_cause: dict[str, list[int]] = {}
    if perpetual:
        for cause, qty in db.execute(
            select(StockMovement.cause, StockMovement.qty_base).where(
                StockMovement.store_id == store.id,
                StockMovement.ingredient_id == ingredient.id,
                StockMovement.business_date >= frm,
                StockMovement.business_date <= to,
            )
        ).all():
            bucket = by_cause.setdefault(getattr(cause, "value", str(cause)), [0, 0])
            bucket[0] += 1
            bucket[1] += int(qty)
    lines = db.execute(
        select(AreaCountLine, AreaCount)
        .join(AreaCount, AreaCountLine.count_id == AreaCount.id)
        .where(
            AreaCount.store_id == store.id,
            AreaCountLine.ingredient_id == ingredient.id,
            AreaCount.business_date >= frm,
            AreaCount.business_date <= to,
        )
        .order_by(AreaCount.counted_at.desc())
        .limit(RECORD_LIST_LIMIT)
    ).all()
    return IngredientRecordOut(
        ingredient_id=ingredient.id,
        name=ingredient.name,
        base_unit=getattr(ingredient.base_unit, "value", str(ingredient.base_unit)),
        active=bool(ingredient.active),
        store_id=store.id,
        date_from=frm,
        date_to=to,
        stock=stock,
        by_cause=[
            IngredientCauseTotalOut(cause=k, movements=v[0], qty=format_qty_base(v[1]))
            for k, v in sorted(by_cause.items())
        ],
        area_counts=[
            IngredientCountLineOut(
                count_id=c.id,
                area_name=c.area_name,
                moment=getattr(c.moment, "value", str(c.moment)),
                counted_at=c.counted_at,
                employee_name=c.employee_name,
                qty=format_qty_base(line.qty_base),
            )
            for line, c in lines
        ],
    )


def get_employee_or_404(db: Session, *, organization_id: int, employee_id: int) -> Employee:
    employee = db.get(Employee, employee_id)
    if employee is None or employee.organization_id != organization_id:
        raise AppError("NOT_FOUND", "La persona no existe en esta organización", status=404)
    return employee

