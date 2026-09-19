"""Reglas de negocio del turno de caja.

Una sola fórmula (`compute_breakdown`), escrita una sola vez: todo lo demás
(relevos, arqueo, revisión de cierre, cierre en un paso) la envuelve, nunca la
repite. La reserva no entra; el `cash_swap` no entra; los retiros no
reversados sí entran. `None` nunca se trata como `0` en lo que cuenta el
usuario (conteos), pero las sumas internas de este módulo parten de listas
vacías = 0 porque ahí "nadie contó" no aplica (son sumatorias de filas, no
conteos humanos).
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.auth import service as auth_service
from app.auth.deps import Actor
from app.auth.models import Authorization, Employee
from app.core import clock, features, money, tz
from app.core import modules
from app.core.errors import AppError
from app.notifications.service import notify
from app.stores import service as stores_service
from app.stores.models import Store
from app.shifts import activity_metrics, hooks
from app.shifts.models import (
    BusinessDay,
    BusinessDayStatus,
    CashDifferenceCause,
    CashMovement,
    CashMovementKind,
    CashPickup,
    CashSwap,
    HandoverKind,
    Shift,
    ShiftCloseCount,
    ShiftHandover,
    ShiftRoster,
    ShiftStatus,
)
from app.shifts.schemas import (
    CashMovementIn,
    CashPickupIn,
    CashSwapIn,
    CloseCountIn,
    HandoverIn,
    OpenShiftIn,
    RosterActionIn,
    SingleStepCloseIn,
)

# ---------------------------------------------------------------------------
# Día operativo
# ---------------------------------------------------------------------------


def get_or_create_business_day(
    db: Session, *, organization_id: int, store_id: int, cutoff_hour: int
) -> tuple[BusinessDay, bool]:
    """Get-or-create bajo savepoint: sin esto la carrera entre dos tablets
    tumba la apertura del primer turno del día (`docs/SPEC-NEGOCIO.md §3.1`).

    Devuelve `(day, created)`.
    """

    business_date = tz.today_business_date(cutoff_hour)
    existing = db.execute(
        select(BusinessDay).where(
            BusinessDay.store_id == store_id, BusinessDay.business_date == business_date
        )
    ).scalar_one_or_none()
    if existing is not None:
        return existing, False

    day: BusinessDay | None
    try:
        with db.begin_nested():
            day = BusinessDay(
                organization_id=organization_id,
                store_id=store_id,
                business_date=business_date,
                status=BusinessDayStatus.OPEN,
                opened_at=clock.now_utc(),
            )
            db.add(day)
            db.flush()
    except IntegrityError:
        day = db.execute(
            select(BusinessDay).where(
                BusinessDay.store_id == store_id, BusinessDay.business_date == business_date
            )
        ).scalar_one_or_none()
        if day is None:
            raise
        return day, False
    assert day is not None
    return day, True


def _reset_daily_availability_if_present(db: Session, *, store_id: int) -> None:
    """Llama a `app.catalog.service.reset_daily_availability` si el módulo del
    catálogo ya existe (protegido con `find_spec`: se construye en paralelo).
    """

    if modules.find_spec_safe("app.catalog.service") is None:
        return
    module = importlib.import_module("app.catalog.service")
    fn = getattr(module, "reset_daily_availability", None)
    if fn is not None:
        fn(db, store_id=store_id)


# ---------------------------------------------------------------------------
# Gancho cruzado con `app.orders.hooks` (comandas abiertas al cerrar el
# turno; traslado al turno siguiente). Protegido con `find_spec` porque
# `app.orders` se construye en paralelo (CONTRATO-INTERNO-1b-1.md §2.5, dueño
# del test E2E: backend-base, `tests/shifts/test_open_orders_gate.py`).
# ---------------------------------------------------------------------------


def _orders_hooks_module() -> Any | None:
    if modules.find_spec_safe("app.orders.hooks") is None:
        return None
    return importlib.import_module("app.orders.hooks")


def _count_open_orders(db: Session, shift_id: int) -> int:
    module = _orders_hooks_module()
    if module is None:
        return 0
    fn = getattr(module, "count_open_orders", None)
    if fn is None:
        return 0
    return int(fn(db, shift_id=shift_id))


def _detach_open_orders(db: Session, *, shift_id: int, actor: Actor) -> list[int]:
    module = _orders_hooks_module()
    if module is None:
        return []
    fn = getattr(module, "detach_open_orders", None)
    if fn is None:
        return []
    return list(fn(db, shift_id=shift_id, actor=actor))


def _adopt_transferred_orders(db: Session, *, store_id: int, shift: Shift, actor: Actor) -> list[int]:
    module = _orders_hooks_module()
    if module is None:
        return []
    fn = getattr(module, "adopt_transferred_orders", None)
    if fn is None:
        return []
    return list(fn(db, store_id=store_id, shift=shift, actor=actor))


def _apply_open_orders_gate(db: Session, *, shift: Shift, actor: Actor, transfer_open_orders: bool) -> None:
    """`400 OPEN_ORDERS_EXIST` si el turno tiene comandas abiertas y no se
    pidió trasladarlas; con el traslado, las desprende del turno (quedan
    `shift_id NULL`, a la espera del próximo `open_shift`)."""

    open_count = _count_open_orders(db, shift.id)
    if open_count == 0:
        return
    if not transfer_open_orders:
        raise AppError(
            "OPEN_ORDERS_EXIST",
            "Cobrá o anulá las comandas abiertas, o marcá trasladarlas al turno siguiente",
            status=400,
            extra={"open_orders": open_count},
        )
    _detach_open_orders(db, shift_id=shift.id, actor=actor)


def _close_business_day(db: Session, business_day_id: int) -> None:
    day = db.get(BusinessDay, business_day_id)
    if day is None or day.status == BusinessDayStatus.CLOSED:
        return
    day.status = BusinessDayStatus.CLOSED
    day.closed_at = clock.now_utc()
    db.flush()


def _has_other_open_shift_same_day(db: Session, shift: Shift) -> bool:
    other = db.execute(
        select(Shift.id).where(
            Shift.business_day_id == shift.business_day_id,
            Shift.id != shift.id,
            Shift.status == ShiftStatus.OPEN,
        )
    ).first()
    return other is not None


# ---------------------------------------------------------------------------
# La matemática (una sola función)
# ---------------------------------------------------------------------------


def _sum_movements(db: Session, shift_id: int, kind: CashMovementKind) -> int:
    total = db.execute(
        select(func.coalesce(func.sum(CashMovement.amount), 0)).where(
            CashMovement.shift_id == shift_id, CashMovement.kind == kind
        )
    ).scalar_one()
    return int(total)


def _sum_pickups(db: Session, shift_id: int) -> int:
    total = db.execute(
        select(func.coalesce(func.sum(CashPickup.amount), 0)).where(
            CashPickup.shift_id == shift_id, CashPickup.reversed_at.is_(None)
        )
    ).scalar_one()
    return int(total)


def compute_breakdown(db: Session, shift: Shift) -> dict[str, int]:
    """`expected = base + cash_sales + incomes − expenses − pickups`.

    La reserva de caja NO entra (`cash_reserve` no aparece acá). El
    `cash_swap` NO cambia nada (no se consulta). Los retiros reversados no
    restan (filtrados por `reversed_at IS NULL`). Ajustar la apertura
    (rescate) reescribe `opening_cash_total`/`cash_reserve` y lo derivado se
    recalcula llamando de nuevo a esta misma función: no hay una segunda
    fórmula en ningún otro lado.
    """

    sales = hooks.get_sales_totals(db, shift.id)
    incomes = _sum_movements(db, shift.id, CashMovementKind.INCOME)
    expenses = _sum_movements(db, shift.id, CashMovementKind.EXPENSE)
    pickups = _sum_pickups(db, shift.id)
    base = shift.opening_cash_total
    expected = base + sales.cash + incomes - expenses - pickups
    return {
        "base": base,
        "cash_sales": sales.cash,
        "incomes": incomes,
        "expenses": expenses,
        "pickups": pickups,
        "expected": expected,
    }


# ---------------------------------------------------------------------------
# Stale / cash_over_threshold
# ---------------------------------------------------------------------------


def is_shift_stale(db: Session, shift: Shift, store: Store) -> bool:
    """Un turno abierto pasada la hora de corte del día SIGUIENTE a su
    `business_date` es un turno abandonado (`docs/SPEC-NEGOCIO.md §3.1`).
    """

    if shift.status != ShiftStatus.OPEN:
        return False
    day = db.get(BusinessDay, shift.business_day_id)
    if day is None:
        return False
    cutoff_local = datetime.combine(
        day.business_date + timedelta(days=1), time(hour=store.cutoff_hour), tzinfo=tz.BOGOTA
    )
    now_local = tz.to_bogota(clock.now_utc())
    return now_local >= cutoff_local


def cash_over_threshold(db: Session, shift: Shift, store: Store) -> bool:
    settings = stores_service.get_cash_settings(db, store.id)
    breakdown = compute_breakdown(db, shift)
    return breakdown["expected"] >= settings.cash_pickup_threshold


def notify_if_stale(db: Session, shift: Shift, store: Store) -> bool:
    stale = is_shift_stale(db, shift, store)
    if stale:
        notify(
            db,
            organization_id=shift.organization_id,
            store_id=store.id,
            type="shift_stale",
            level="warning",
            title="Turno sin cerrar",
            body=f"El turno #{shift.id} sigue abierto después de la hora de corte del día siguiente.",
            payload={"shift_id": shift.id},
            dedupe_key=f"shift_stale:{shift.id}",
        )
    return stale


def notify_if_cash_over_threshold(db: Session, shift: Shift, store: Store) -> bool:
    over = cash_over_threshold(db, shift, store)
    if over:
        notify(
            db,
            organization_id=shift.organization_id,
            store_id=store.id,
            type="cash_over_threshold",
            level="warning",
            title="Efectivo sobre el umbral",
            body=f"El efectivo esperado del turno #{shift.id} superó el umbral de retiro sugerido.",
            payload={"shift_id": shift.id},
            dedupe_key=f"cash_over_threshold:{shift.id}",
        )
    return over


# ---------------------------------------------------------------------------
# Helpers de lectura con aislamiento por organización/sede
# ---------------------------------------------------------------------------


def get_shift_or_404(db: Session, *, store_id: int, shift_id: int) -> Shift:
    shift = db.get(Shift, shift_id)
    if shift is None or shift.store_id != store_id:
        raise AppError("NOT_FOUND", "El turno no existe en esta sede", status=404)
    return shift


def _get_org_employee(db: Session, organization_id: int, employee_id: int) -> Employee:
    employee = db.get(Employee, employee_id)
    if employee is None or employee.organization_id != organization_id or not employee.active:
        raise AppError("NOT_FOUND", "El empleado no existe (o está inactivo) en esta organización", status=404)
    return employee


def _require_open(shift: Shift) -> None:
    if shift.status != ShiftStatus.OPEN:
        raise AppError("SHIFT_NOT_OPEN", "El turno no está abierto", status=400)


def _to_denominations(items: list[Any]) -> list[money.Denomination]:
    return [money.Denomination(value=item.value, count=item.count) for item in items]


def _check_photo_required(db: Session, store: Store, photo: str | None, *, setting_attr: str) -> None:
    if not features.is_enabled(db, store.organization_id, store.id, "cash.photo_required"):
        return
    settings = stores_service.get_cash_settings(db, store.id)
    if getattr(settings, setting_attr) and not photo:
        raise AppError("PHOTO_REQUIRED", "Subí la foto del conteo antes de continuar", status=400)


# ---------------------------------------------------------------------------
# GET /shifts/current
# ---------------------------------------------------------------------------


def get_current_shift(db: Session, *, store: Store) -> Shift | None:
    return db.execute(
        select(Shift).where(Shift.store_id == store.id, Shift.status == ShiftStatus.OPEN)
    ).scalar_one_or_none()


def list_roster(db: Session, shift_id: int) -> list[ShiftRoster]:
    return list(
        db.execute(select(ShiftRoster).where(ShiftRoster.shift_id == shift_id).order_by(ShiftRoster.in_at)).scalars()
    )


# ---------------------------------------------------------------------------
# POST /shifts/open
# ---------------------------------------------------------------------------


def open_shift(db: Session, *, actor: Actor, store: Store, payload: OpenShiftIn) -> Shift:
    cash_settings = stores_service.get_cash_settings(db, store.id)

    denominations = _to_denominations(payload.opening_cash.denominations)
    total = money.validate_denominations(denominations, payload.opening_cash.total)

    if total != cash_settings.opening_cash_fixed and not payload.opening_cause:
        raise AppError(
            "OPENING_DIFFERENCE_NEEDS_CAUSE",
            f"La base contada (${total}) no coincide con la base fija (${cash_settings.opening_cash_fixed}): "
            "elegí una causa para poder abrir el turno",
            status=400,
        )

    existing_open = db.execute(
        select(Shift.id).where(Shift.store_id == store.id, Shift.status == ShiftStatus.OPEN)
    ).first()
    if existing_open is not None:
        raise AppError("SHIFT_ALREADY_OPEN", "Ya hay un turno abierto en esta sede: cerralo antes de abrir otro", status=400)

    cash_responsible = _get_org_employee(db, store.organization_id, payload.cash_responsible_id)

    reserve_enabled = features.is_enabled(db, store.organization_id, store.id, "cash.reserve")
    cash_reserve = payload.cash_reserve if reserve_enabled else 0

    day, created = get_or_create_business_day(
        db, organization_id=store.organization_id, store_id=store.id, cutoff_hour=store.cutoff_hour
    )
    if created:
        _reset_daily_availability_if_present(db, store_id=store.id)

    now = clock.now_utc()
    opener_id = actor.employee_id or cash_responsible.id
    opener_name = actor.employee_name or cash_responsible.name

    shift = Shift(
        organization_id=store.organization_id,
        store_id=store.id,
        business_day_id=day.id,
        status=ShiftStatus.OPEN,
        opened_at=now,
        opened_by_employee_id=opener_id,
        opened_by_employee_name=opener_name,
        cash_responsible_id=cash_responsible.id,
        cash_responsible_name=cash_responsible.name,
        opening_cash_total=total,
        opening_denominations=[d.model_dump() for d in payload.opening_cash.denominations],
        cash_reserve=cash_reserve,
        opening_cause=payload.opening_cause,
        opening_note=payload.opening_note,
        adjustments=[],
    )
    db.add(shift)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise AppError(
            "SHIFT_OPEN_RACE",
            "Otra apertura ganó la carrera para esta sede: recargá y usá el turno que quedó abierto",
            status=409,
        ) from exc

    hooks.on_employee_identified(db, store_id=store.id, employee=cash_responsible)
    if opener_id != cash_responsible.id:
        opener = db.get(Employee, opener_id)
        if opener is not None:
            hooks.on_employee_identified(db, store_id=store.id, employee=opener)

    # Comandas que quedaron trasladadas (`shift_id NULL`) por el cierre de un
    # turno anterior: este nuevo turno las adopta (CONTRATO-INTERNO-1b-1.md
    # §2.5, dueño del test E2E: backend-base).
    _adopt_transferred_orders(db, store_id=store.id, shift=shift, actor=actor)

    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="shift",
        entity_id=shift.id,
        action="open",
        before=None,
        after={
            "opening_cash_total": total,
            "cash_reserve": cash_reserve,
            "cash_responsible_id": cash_responsible.id,
            "business_day_id": day.id,
        },
    )
    return shift


# ---------------------------------------------------------------------------
# POST /shifts/{id}/roster
# ---------------------------------------------------------------------------


def _open_roster_entry(db: Session, shift: Shift, employee_id: int) -> ShiftRoster | None:
    return db.execute(
        select(ShiftRoster)
        .where(ShiftRoster.shift_id == shift.id, ShiftRoster.employee_id == employee_id, ShiftRoster.out_at.is_(None))
        .order_by(ShiftRoster.in_at.desc())
    ).scalars().first()


def roster_action(db: Session, *, actor: Actor, shift: Shift, payload: RosterActionIn) -> ShiftRoster:
    _require_open(shift)
    employee = _get_org_employee(db, shift.organization_id, payload.employee_id)

    if not auth_service.verify_pin(db, employee, payload.pin):
        raise AppError("PIN_INVALID", "El PIN no es válido: volvé a intentarlo", status=400)

    if payload.action == "out" and employee.id == shift.cash_responsible_id:
        raise AppError(
            "NOT_CASH_RESPONSIBLE",
            "El responsable de caja no sale por acá: hacé un relevo (POST /shifts/{id}/handovers) antes de salir",
            status=400,
        )

    now = clock.now_utc()
    entry: ShiftRoster | None

    if payload.action == "in":
        hooks.on_employee_identified(db, store_id=shift.store_id, employee=employee)
        entry = _open_roster_entry(db, shift, employee.id)
        assert entry is not None
    elif payload.action == "out":
        entry = _open_roster_entry(db, shift, employee.id)
        if entry is None:
            raise AppError("EMPLOYEE_NOT_IN_ROSTER", "Esta persona no tiene una entrada abierta en el turno", status=400)
        entry.out_at = now
    elif payload.action == "pause_start":
        entry = _open_roster_entry(db, shift, employee.id)
        if entry is None:
            raise AppError("EMPLOYEE_NOT_IN_ROSTER", "Esta persona no tiene una entrada abierta en el turno", status=400)
        pauses = list(entry.pauses or [])
        pauses.append({"start": now.isoformat(), "end": None})
        entry.pauses = pauses
    else:  # pause_end
        entry = _open_roster_entry(db, shift, employee.id)
        if entry is None or not entry.pauses or entry.pauses[-1].get("end") is not None:
            raise AppError("EMPLOYEE_NOT_IN_ROSTER", "No hay una pausa abierta para cerrar", status=400)
        pauses = list(entry.pauses)
        pauses[-1] = {**pauses[-1], "end": now.isoformat()}
        entry.pauses = pauses

    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=shift.organization_id,
        store_id=shift.store_id,
        entity="shift_roster",
        entity_id=entry.id,
        action=payload.action,
        before=None,
        after={"employee_id": employee.id, "action": payload.action, "at": now.isoformat()},
    )
    return entry


# ---------------------------------------------------------------------------
# POST /shifts/{id}/handovers
# ---------------------------------------------------------------------------


def create_handover(db: Session, *, actor: Actor, shift: Shift, store: Store, payload: HandoverIn) -> ShiftHandover:
    _require_open(shift)

    denominations = _to_denominations(payload.counted_cash.denominations)
    counted_cash_total = money.validate_denominations(denominations, payload.counted_cash.total)

    breakdown = compute_breakdown(db, shift)
    difference = counted_cash_total - breakdown["expected"]

    new_responsible: Employee | None = None
    authorizer: Employee | None = None

    if payload.kind == "spot_check":
        authorizer = auth_service.verify_authorizer(
            db,
            organization_id=shift.organization_id,
            store_id=shift.store_id,
            pin=payload.authorizer_pin,
            action="spot_check",
            requested_by=actor,
        )
    else:
        if not payload.new_responsible_id:
            raise AppError("VALIDATION_ERROR", "new_responsible_id: es obligatorio para registrar un relevo", status=400)
        new_responsible = _get_org_employee(db, shift.organization_id, payload.new_responsible_id)
        if payload.authorizer_pin:
            authorizer = auth_service.verify_authorizer(
                db,
                organization_id=shift.organization_id,
                store_id=shift.store_id,
                pin=payload.authorizer_pin,
                action="handover",
                requested_by=actor,
            )

    from_id = shift.cash_responsible_id
    from_name = shift.cash_responsible_name

    handover = ShiftHandover(
        organization_id=shift.organization_id,
        store_id=shift.store_id,
        shift_id=shift.id,
        kind=HandoverKind(payload.kind),
        counted_cash=counted_cash_total,
        counted_cash_denominations=[d.model_dump() for d in payload.counted_cash.denominations],
        counted_card=payload.counted_card,
        counted_transfer=payload.counted_transfer,
        breakdown={**breakdown, "counted": counted_cash_total, "difference": difference},
        from_responsible_id=from_id,
        from_responsible_name=from_name,
        new_responsible_id=new_responsible.id if new_responsible else None,
        new_responsible_name=new_responsible.name if new_responsible else None,
        authorized_by_employee_id=authorizer.id if authorizer else None,
        authorized_by_employee_name=authorizer.name if authorizer else None,
        photo=payload.photo,
        at=clock.now_utc(),
    )
    db.add(handover)

    if new_responsible is not None:
        shift.cash_responsible_id = new_responsible.id
        shift.cash_responsible_name = new_responsible.name
        hooks.on_employee_identified(db, store_id=shift.store_id, employee=new_responsible)

    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=shift.organization_id,
        store_id=shift.store_id,
        entity="shift",
        entity_id=shift.id,
        action=f"handover.{payload.kind}",
        before={"cash_responsible_id": from_id, "cash_responsible_name": from_name},
        after={
            "cash_responsible_id": shift.cash_responsible_id,
            "difference": difference,
            "handover_id": handover.id,
        },
    )
    return handover


# ---------------------------------------------------------------------------
# POST /shifts/{id}/cash-movements
# ---------------------------------------------------------------------------


def create_cash_movement(
    db: Session, *, actor: Actor, shift: Shift, store: Store, payload: CashMovementIn
) -> CashMovement:
    _require_open(shift)

    authorizer: Employee | None = None
    if payload.kind == "expense":
        settings = stores_service.get_cash_settings(db, store.id)
        if payload.amount > settings.petty_cash_limit:
            if not payload.authorizer_pin:
                raise AppError(
                    "PETTY_CASH_LIMIT",
                    f"El egreso supera el límite de caja menor (${settings.petty_cash_limit}): pedí el PIN de un administrador",
                    status=400,
                )
            authorizer = auth_service.verify_authorizer(
                db,
                organization_id=shift.organization_id,
                store_id=shift.store_id,
                pin=payload.authorizer_pin,
                action="petty_over_limit",
                requested_by=actor,
            )

    movement = CashMovement(
        organization_id=shift.organization_id,
        store_id=shift.store_id,
        shift_id=shift.id,
        kind=payload.kind,
        cause=payload.cause,
        amount=payload.amount,
        note=payload.note,
        receipt_photo=payload.receipt_photo,
        employee_id=actor.employee_id,
        employee_name=actor.employee_name,
        authorized_by_employee_id=authorizer.id if authorizer else None,
        authorized_by_employee_name=authorizer.name if authorizer else None,
        at=clock.now_utc(),
    )
    db.add(movement)
    db.flush()

    record_audit(
        db,
        actor=actor,
        organization_id=shift.organization_id,
        store_id=shift.store_id,
        entity="cash_movement",
        entity_id=movement.id,
        action="create",
        before=None,
        after={"kind": payload.kind, "cause": payload.cause, "amount": payload.amount},
    )

    if payload.kind == "income":
        notify_if_cash_over_threshold(db, shift, store)

    return movement


# ---------------------------------------------------------------------------
# POST /shifts/{id}/cash-swaps
# ---------------------------------------------------------------------------


def create_cash_swap(db: Session, *, actor: Actor, shift: Shift, payload: CashSwapIn) -> CashSwap:
    _require_open(shift)

    out_denoms = _to_denominations(payload.out.denominations)
    in_denoms = _to_denominations(payload.in_.denominations)
    out_total = money.validate_denominations(out_denoms, payload.out.total)
    in_total = money.validate_denominations(in_denoms, payload.in_.total)

    if out_total != in_total:
        raise AppError(
            "SWAP_NOT_ZERO",
            "El cambio de denominaciones no es neto cero: lo que sale y lo que entra tienen que sumar igual",
            status=400,
        )

    swap = CashSwap(
        organization_id=shift.organization_id,
        store_id=shift.store_id,
        shift_id=shift.id,
        out_denominations=[d.model_dump() for d in payload.out.denominations],
        in_denominations=[d.model_dump() for d in payload.in_.denominations],
        amount=out_total,
        employee_id=actor.employee_id,
        employee_name=actor.employee_name,
        at=clock.now_utc(),
    )
    db.add(swap)
    db.flush()

    record_audit(
        db,
        actor=actor,
        organization_id=shift.organization_id,
        store_id=shift.store_id,
        entity="cash_swap",
        entity_id=swap.id,
        action="create",
        before=None,
        after={"amount": out_total},
    )
    return swap


# ---------------------------------------------------------------------------
# POST /shifts/{id}/pickups (+ reverse)
# ---------------------------------------------------------------------------


def create_pickup(db: Session, *, actor: Actor, shift: Shift, store: Store, payload: CashPickupIn) -> CashPickup:
    _require_open(shift)
    _check_photo_required(db, store, payload.photo, setting_attr="photo_required_on_pickup")

    authorizer = auth_service.verify_authorizer(
        db,
        organization_id=shift.organization_id,
        store_id=shift.store_id,
        pin=payload.authorizer_pin,
        action="pickup",
        requested_by=actor,
    )

    breakdown = compute_breakdown(db, shift)

    denominations_out: list[dict] | None = None
    if payload.denominations:
        denoms = _to_denominations(payload.denominations)
        money.validate_denominations(denoms, payload.amount)
        denominations_out = [d.model_dump() for d in payload.denominations]

    pickup = CashPickup(
        organization_id=shift.organization_id,
        store_id=shift.store_id,
        shift_id=shift.id,
        amount=payload.amount,
        denominations=denominations_out,
        envelope_ref=payload.envelope_ref,
        note=payload.note,
        photo=payload.photo,
        expected_at_pickup=breakdown["expected"],
        employee_id=actor.employee_id or authorizer.id,
        employee_name=actor.employee_name or authorizer.name,
        authorized_by_employee_id=authorizer.id,
        authorized_by_employee_name=authorizer.name,
        at=clock.now_utc(),
    )
    db.add(pickup)
    db.flush()

    record_audit(
        db,
        actor=actor,
        organization_id=shift.organization_id,
        store_id=shift.store_id,
        entity="cash_pickup",
        entity_id=pickup.id,
        action="create",
        before=None,
        after={"amount": payload.amount, "expected_at_pickup": breakdown["expected"]},
    )
    return pickup


def get_pickup_or_404(db: Session, *, shift: Shift, pickup_id: int) -> CashPickup:
    pickup = db.get(CashPickup, pickup_id)
    if pickup is None or pickup.shift_id != shift.id:
        raise AppError("NOT_FOUND", "El retiro no existe en este turno", status=404)
    return pickup


def reverse_pickup(
    db: Session, *, actor: Actor, shift: Shift, pickup: CashPickup, reason: str, authorizer_pin: str
) -> CashPickup:
    if pickup.reversed_at is not None:
        raise AppError("PICKUP_ALREADY_REVERSED", "Este retiro ya fue reversado", status=400)

    authorizer = auth_service.verify_authorizer(
        db,
        organization_id=shift.organization_id,
        store_id=shift.store_id,
        pin=authorizer_pin,
        action="pickup_reverse",
        requested_by=actor,
    )

    pickup.reversed_at = clock.now_utc()
    pickup.reversed_reason = reason
    pickup.reversed_by_employee_id = authorizer.id
    pickup.reversed_by_employee_name = authorizer.name
    db.flush()

    record_audit(
        db,
        actor=actor,
        organization_id=shift.organization_id,
        store_id=shift.store_id,
        entity="cash_pickup",
        entity_id=pickup.id,
        action="reverse",
        before={"reversed_at": None},
        after={"reversed_at": pickup.reversed_at.isoformat(), "reason": reason},
        reason=reason,
    )
    return pickup


# ---------------------------------------------------------------------------
# Cierre: evaluación compartida por review, confirm y el paso único
# ---------------------------------------------------------------------------


@dataclass
class CloseEvaluation:
    breakdown: dict[str, int]
    expected: int
    counted: int
    difference: int
    card_registered: int
    card_counted: int | None
    card_difference: int | None
    transfer_registered: int
    transfer_counted: int | None
    transfer_difference: int | None
    requires_cause: bool
    requires_identified_cause: bool
    is_critical: bool


def _evaluate_close(db: Session, shift: Shift, store: Store, count: ShiftCloseCount) -> CloseEvaluation:
    breakdown = compute_breakdown(db, shift)
    sales = hooks.get_sales_totals(db, shift.id)
    settings = stores_service.get_cash_settings(db, store.id)

    difference = count.counted_cash_total - breakdown["expected"]
    card_difference = None if count.counted_card is None else count.counted_card - sales.card
    transfer_difference = None if count.counted_transfer is None else count.counted_transfer - sales.transfer

    return CloseEvaluation(
        breakdown=breakdown,
        expected=breakdown["expected"],
        counted=count.counted_cash_total,
        difference=difference,
        card_registered=sales.card,
        card_counted=count.counted_card,
        card_difference=card_difference,
        transfer_registered=sales.transfer,
        transfer_counted=count.counted_transfer,
        transfer_difference=transfer_difference,
        requires_cause=difference != 0,
        requires_identified_cause=abs(difference) > settings.tolerance_unknown_cause,
        is_critical=abs(difference) >= settings.critical_difference,
    )


def _validate_close_cause(ev: CloseEvaluation, cause: str | None) -> None:
    if ev.requires_cause and not cause:
        raise AppError("CAUSE_REQUIRED", "La diferencia no es cero: elegí una causa para poder cerrar", status=400)
    if ev.requires_identified_cause and (cause is None or cause == CashDifferenceCause.UNKNOWN.value):
        raise AppError(
            "IDENTIFIED_CAUSE_REQUIRED",
            "La diferencia supera la tolerancia de causa desconocida: elegí una causa identificada",
            status=400,
        )


def review_close(db: Session, *, shift: Shift, store: Store, count: ShiftCloseCount) -> dict[str, Any]:
    ev = _evaluate_close(db, shift, store, count)
    equation = {
        "base": ev.breakdown["base"],
        "cash_sales": ev.breakdown["cash_sales"],
        "incomes": ev.breakdown["incomes"],
        "expenses": ev.breakdown["expenses"],
        "pickups": ev.breakdown["pickups"],
        "expected": ev.expected,
    }
    return {
        "count_id": count.id,
        "expected": ev.expected,
        "difference": ev.difference,
        "equation": equation,
        "card": {"registered": ev.card_registered, "counted": ev.card_counted, "difference": ev.card_difference},
        "transfer": {
            "registered": ev.transfer_registered,
            "counted": ev.transfer_counted,
            "difference": ev.transfer_difference,
        },
        "requires_cause": ev.requires_cause,
        "requires_identified_cause": ev.requires_identified_cause,
        "is_critical": ev.is_critical,
        "closes_day_suggested": not _has_other_open_shift_same_day(db, shift),
        "open_orders": _count_open_orders(db, shift.id),
    }


def _check_difference_streak(db: Session, shift: Shift, store: Store) -> None:
    settings = stores_service.get_cash_settings(db, store.id)
    n = settings.streak_alert_shifts
    if not n or n <= 0:
        return
    recent = list(
        db.execute(
            select(Shift)
            .where(
                Shift.store_id == shift.store_id,
                Shift.cash_responsible_id == shift.cash_responsible_id,
                Shift.status == ShiftStatus.CLOSED,
            )
            .order_by(Shift.closed_at.desc())
            .limit(n)
        ).scalars()
    )
    if len(recent) < n:
        return
    if all((s.difference or 0) != 0 for s in recent):
        notify(
            db,
            organization_id=shift.organization_id,
            store_id=shift.store_id,
            type="difference_streak",
            level="warning",
            title="Racha de diferencias de caja",
            body=f"{shift.cash_responsible_name} cerró {n} turnos seguidos con diferencia distinta de cero.",
            payload={"employee_id": shift.cash_responsible_id, "shift_id": shift.id},
            dedupe_key=f"difference_streak:{shift.id}",
        )


def _finalize_close(
    db: Session,
    *,
    actor: Actor,
    shift: Shift,
    store: Store,
    count: ShiftCloseCount,
    cause: str | None,
    note: str | None,
    closes_day: bool,
    ev: CloseEvaluation,
) -> dict[str, Any]:
    settings = stores_service.get_cash_settings(db, store.id)
    now = clock.now_utc()
    before = {"status": shift.status.value if hasattr(shift.status, "value") else shift.status}

    shift.status = ShiftStatus.CLOSED
    shift.closed_at = now
    shift.closed_by_employee_id = actor.employee_id
    shift.closed_by_employee_name = actor.employee_name
    shift.expected_cash = ev.expected
    shift.counted_cash = ev.counted
    shift.difference = ev.difference
    shift.close_cause = CashDifferenceCause(cause) if cause else None
    shift.close_note = note
    shift.closes_day = closes_day
    shift.closed_without_count = False

    to_deposit = count.counted_cash_total - settings.opening_cash_fixed - (count.tips_cash_out or 0)
    shift.to_deposit = to_deposit

    db.flush()

    if closes_day:
        _close_business_day(db, shift.business_day_id)

    record_audit(
        db,
        actor=actor,
        organization_id=shift.organization_id,
        store_id=shift.store_id,
        entity="shift",
        entity_id=shift.id,
        action="close",
        before=before,
        after={"difference": ev.difference, "cause": cause, "to_deposit": to_deposit, "closes_day": closes_day},
        reason=note,
    )

    if ev.difference != 0:
        notify(
            db,
            organization_id=shift.organization_id,
            store_id=shift.store_id,
            type="cash_difference",
            level="warning",
            title="Diferencia de caja al cierre",
            body=f"El turno #{shift.id} cerró con una diferencia de ${ev.difference}.",
            payload={"shift_id": shift.id, "difference": ev.difference},
            dedupe_key=f"cash_difference:{shift.id}",
        )
    if ev.is_critical:
        notify(
            db,
            organization_id=shift.organization_id,
            store_id=shift.store_id,
            type="cash_difference_critical",
            level="critical",
            title="Diferencia crítica de caja",
            body=f"El turno #{shift.id} cerró con una diferencia crítica de ${ev.difference}. El cierre sigue en pie.",
            payload={"shift_id": shift.id, "difference": ev.difference},
            dedupe_key=f"cash_difference_critical:{shift.id}",
        )

    _check_difference_streak(db, shift, store)

    return {"to_deposit": to_deposit, "closes_day": closes_day}


# ---------------------------------------------------------------------------
# Cierre a ciegas en tres pasos (cash.blind_close encendido)
# ---------------------------------------------------------------------------


def create_close_count(db: Session, *, actor: Actor, shift: Shift, store: Store, payload: CloseCountIn) -> ShiftCloseCount:
    _require_open(shift)
    _check_photo_required(db, store, payload.photo, setting_attr="photo_required_on_close")

    denominations = _to_denominations(payload.counted_cash.denominations)
    total = money.validate_denominations(denominations, payload.counted_cash.total)

    sales = hooks.get_sales_totals(db, shift.id)
    if sales.card > 0 and payload.counted_card is None:
        raise AppError("CARD_TOTAL_REQUIRED", "Ingresá el total del datáfono: hubo ventas registradas con tarjeta", status=400)
    if sales.transfer > 0 and payload.counted_transfer is None:
        raise AppError(
            "TRANSFER_TOTAL_REQUIRED", "Ingresá el total de transferencias: hubo ventas registradas por transferencia", status=400
        )

    count = ShiftCloseCount(
        organization_id=shift.organization_id,
        store_id=shift.store_id,
        shift_id=shift.id,
        counted_cash_total=total,
        counted_cash_denominations=[d.model_dump() for d in payload.counted_cash.denominations],
        counted_card=payload.counted_card,
        counted_transfer=payload.counted_transfer,
        tips_cash_out=payload.tips_cash_out,
        photo=payload.photo,
        created_by_employee_id=actor.employee_id,
        created_by_employee_name=actor.employee_name,
        created_at=clock.now_utc(),
    )
    db.add(count)
    db.flush()

    record_audit(
        db,
        actor=actor,
        organization_id=shift.organization_id,
        store_id=shift.store_id,
        entity="shift_close_count",
        entity_id=count.id,
        action="create",
        before=None,
        after={"counted_cash_total": total},
    )
    return count


def get_close_count_or_404(db: Session, *, shift: Shift, count_id: int) -> ShiftCloseCount:
    count = db.get(ShiftCloseCount, count_id)
    if count is None or count.shift_id != shift.id:
        raise AppError("NOT_FOUND", "El conteo de cierre no existe en este turno", status=404)
    return count


def _get_active_close_count(db: Session, shift_id: int) -> ShiftCloseCount | None:
    """El conteo de cierre "activo" (el más reciente no superado) de un turno.

    No hay un puntero (`Shift.active_close_count_id`) a propósito: crearía un
    ciclo de FK entre `shifts` y `shift_close_counts` que SQLite no puede
    resolver con `ALTER TABLE ADD CONSTRAINT`. Se busca por consulta.
    """

    return (
        db.execute(
            select(ShiftCloseCount)
            .where(ShiftCloseCount.shift_id == shift_id, ShiftCloseCount.superseded.is_(False))
            .order_by(ShiftCloseCount.created_at.desc())
        )
        .scalars()
        .first()
    )


def confirm_close(
    db: Session,
    *,
    actor: Actor,
    shift: Shift,
    store: Store,
    count: ShiftCloseCount,
    difference_seen: int,
    cause: str | None,
    note: str | None,
    closes_day: bool,
    transfer_open_orders: bool = False,
) -> dict[str, Any]:
    _require_open(shift)
    _apply_open_orders_gate(db, shift=shift, actor=actor, transfer_open_orders=transfer_open_orders)
    ev = _evaluate_close(db, shift, store, count)

    if ev.difference != difference_seen:
        raise AppError(
            "DIFFERENCE_CHANGED",
            "La diferencia cambió desde que la viste (un movimiento se registró mientras tanto): revisá el resumen actualizado",
            status=400,
            extra={"review": review_close(db, shift=shift, store=store, count=count)},
        )

    _validate_close_cause(ev, cause)
    return _finalize_close(db, actor=actor, shift=shift, store=store, count=count, cause=cause, note=note, closes_day=closes_day, ev=ev)


# ---------------------------------------------------------------------------
# Cierre en un solo paso (cash.blind_close apagado)
# ---------------------------------------------------------------------------


def close_single_step(db: Session, *, actor: Actor, shift: Shift, store: Store, payload: SingleStepCloseIn) -> dict[str, Any]:
    _require_open(shift)
    _apply_open_orders_gate(db, shift=shift, actor=actor, transfer_open_orders=payload.transfer_open_orders)
    count = create_close_count(
        db,
        actor=actor,
        shift=shift,
        store=store,
        payload=CloseCountIn(
            counted_cash=payload.counted_cash,
            counted_card=payload.counted_card,
            counted_transfer=payload.counted_transfer,
            tips_cash_out=payload.tips_cash_out,
            photo=payload.photo,
        ),
    )
    ev = _evaluate_close(db, shift, store, count)
    _validate_close_cause(ev, payload.cause)
    result = _finalize_close(
        db, actor=actor, shift=shift, store=store, count=count, cause=payload.cause, note=payload.note, closes_day=payload.closes_day, ev=ev
    )
    return {**result, "expected": ev.expected, "difference": ev.difference}


# ---------------------------------------------------------------------------
# Rescates de administrador
# ---------------------------------------------------------------------------


def close_administrative(db: Session, *, actor: Actor, shift: Shift, store: Store, reason: str) -> dict[str, Any]:
    _require_open(shift)
    if not is_shift_stale(db, shift, store):
        raise AppError(
            "SHIFT_NOT_STALE",
            "Este turno todavía no pasó la hora de corte: no se puede cerrar administrativamente",
            status=400,
        )

    # El cierre administrativo traslada las comandas abiertas siempre (nunca
    # bloquea con `OPEN_ORDERS_EXIST`): es un rescate de administrador sobre
    # un turno abandonado, no algo que el responsable de caja pueda resolver
    # cobrando o anulando.
    _detach_open_orders(db, shift_id=shift.id, actor=actor)

    cash_settings = stores_service.get_cash_settings(db, store.id)
    breakdown = compute_breakdown(db, shift)
    now = clock.now_utc()

    before = {"status": "open"}
    shift.status = ShiftStatus.CLOSED
    shift.closed_at = now
    shift.closed_by_employee_id = actor.employee_id
    shift.closed_by_employee_name = actor.employee_name or "Administrador"
    shift.expected_cash = breakdown["expected"]
    shift.counted_cash = breakdown["expected"]
    shift.difference = 0
    shift.close_cause = None
    shift.close_note = reason
    shift.closed_without_count = True
    shift.closes_day = True
    shift.to_deposit = breakdown["expected"] - cash_settings.opening_cash_fixed

    db.flush()
    _close_business_day(db, shift.business_day_id)

    record_audit(
        db,
        actor=actor,
        organization_id=shift.organization_id,
        store_id=shift.store_id,
        entity="shift",
        entity_id=shift.id,
        action="close_administrative",
        before=before,
        after={"reason": reason, "expected": breakdown["expected"]},
        reason=reason,
    )
    return {"to_deposit": shift.to_deposit, "closes_day": True}


def reopen_shift(db: Session, *, actor: Actor, shift: Shift, reason: str) -> Shift:
    if shift.status != ShiftStatus.CLOSED:
        raise AppError("CONFLICT", "El turno no está cerrado: no hay nada para reabrir", status=409)

    before = {
        "status": "closed",
        "closed_at": shift.closed_at.isoformat() if shift.closed_at else None,
        "difference": shift.difference,
    }

    active_count = _get_active_close_count(db, shift.id)
    if active_count is not None:
        active_count.superseded = True

    day = db.get(BusinessDay, shift.business_day_id)
    if shift.closes_day and day is not None and day.status == BusinessDayStatus.CLOSED:
        day.status = BusinessDayStatus.OPEN
        day.closed_at = None

    shift.status = ShiftStatus.OPEN
    shift.reopen_reason = reason
    shift.reopened_at = clock.now_utc()
    shift.reopened_by_employee_id = actor.employee_id
    shift.closed_at = None
    shift.closed_by_employee_id = None
    shift.closed_by_employee_name = None
    shift.closed_without_count = False

    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=shift.organization_id,
        store_id=shift.store_id,
        entity="shift",
        entity_id=shift.id,
        action="reopen",
        before=before,
        after={"status": "open", "reason": reason},
        reason=reason,
    )
    return shift


def _has_activity(db: Session, shift: Shift) -> bool:
    for model in (CashMovement, CashSwap, CashPickup, ShiftHandover, ShiftCloseCount):
        found = db.execute(select(model.id).where(model.shift_id == shift.id).limit(1)).first()
        if found is not None:
            return True
    roster_rows = list(db.execute(select(ShiftRoster).where(ShiftRoster.shift_id == shift.id)).scalars())
    if len(roster_rows) > 1:
        return True
    for row in roster_rows:
        if row.out_at is not None or row.pauses:
            return True
    return False


def cancel_shift(db: Session, *, actor: Actor, shift: Shift, reason: str | None) -> Shift:
    if shift.status != ShiftStatus.OPEN:
        raise AppError("CONFLICT", "Solo se puede cancelar un turno abierto", status=409)
    if _has_activity(db, shift):
        raise AppError(
            "SHIFT_HAS_ACTIVITY",
            "Este turno ya tiene actividad registrada: no se puede cancelar, usá un cierre administrativo",
            status=400,
        )

    shift.status = ShiftStatus.CANCELLED
    shift.cancelled_at = clock.now_utc()
    shift.cancelled_reason = reason
    shift.cancelled_by_employee_id = actor.employee_id
    db.flush()

    record_audit(
        db,
        actor=actor,
        organization_id=shift.organization_id,
        store_id=shift.store_id,
        entity="shift",
        entity_id=shift.id,
        action="cancel",
        before={"status": "open"},
        after={"status": "cancelled", "reason": reason},
        reason=reason,
    )
    return shift


def adjust_opening(
    db: Session, *, actor: Actor, shift: Shift, opening_cash: Any, cash_reserve: int, reason: str
) -> Shift:
    if shift.status == ShiftStatus.CANCELLED:
        raise AppError("CONFLICT", "No se puede ajustar un turno cancelado", status=409)

    denominations = _to_denominations(opening_cash.denominations)
    total = money.validate_denominations(denominations, opening_cash.total)

    before = {"opening_cash_total": shift.opening_cash_total, "cash_reserve": shift.cash_reserve}
    now = clock.now_utc()

    adjustments = list(shift.adjustments or [])
    adjustments.append(
        {
            "at": now.isoformat(),
            "by_employee_id": actor.employee_id,
            "by_employee_name": actor.employee_name,
            "reason": reason,
            "before": before,
            "after": {"opening_cash_total": total, "cash_reserve": cash_reserve},
        }
    )

    shift.opening_cash_total = total
    shift.opening_denominations = [d.model_dump() for d in opening_cash.denominations]
    shift.cash_reserve = cash_reserve
    shift.adjustments = adjustments

    # Lo derivado se recalcula con la MISMA función (`compute_breakdown`), no
    # una copia: si el turno ya estaba cerrado, el esperado, la diferencia y
    # lo que hay que consignar se corrigen acá también.
    if shift.status == ShiftStatus.CLOSED and shift.counted_cash is not None:
        breakdown = compute_breakdown(db, shift)
        shift.expected_cash = breakdown["expected"]
        shift.difference = shift.counted_cash - breakdown["expected"]
        settings = stores_service.get_cash_settings(db, shift.store_id)
        active_count = _get_active_close_count(db, shift.id)
        tips_cash_out = active_count.tips_cash_out if active_count is not None else 0
        shift.to_deposit = shift.counted_cash - settings.opening_cash_fixed - tips_cash_out

    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=shift.organization_id,
        store_id=shift.store_id,
        entity="shift",
        entity_id=shift.id,
        action="adjust_opening",
        before=before,
        after={"opening_cash_total": total, "cash_reserve": cash_reserve},
        reason=reason,
    )
    return shift


# ---------------------------------------------------------------------------
# Admin: listados, timeline y actividad por empleado
# ---------------------------------------------------------------------------


def list_admin_shifts(
    db: Session, *, store_id: int, date_from: date | None, date_to: date | None
) -> list[Shift]:
    stmt = select(Shift).join(BusinessDay, Shift.business_day_id == BusinessDay.id).where(Shift.store_id == store_id)
    if date_from is not None:
        stmt = stmt.where(BusinessDay.business_date >= date_from)
    if date_to is not None:
        stmt = stmt.where(BusinessDay.business_date <= date_to)
    stmt = stmt.order_by(Shift.opened_at.desc())
    return list(db.execute(stmt).scalars())


def list_business_days(db: Session, *, store_id: int, date_from: date | None, date_to: date | None) -> list[BusinessDay]:
    stmt = select(BusinessDay).where(BusinessDay.store_id == store_id)
    if date_from is not None:
        stmt = stmt.where(BusinessDay.business_date >= date_from)
    if date_to is not None:
        stmt = stmt.where(BusinessDay.business_date <= date_to)
    stmt = stmt.order_by(BusinessDay.business_date.desc())
    return list(db.execute(stmt).scalars())


_MOVEMENT_KIND_LABEL = {"income": "Ingreso", "expense": "Egreso"}
#: Etiqueta legible de cada causa de movimiento de caja, para la cronología
#: del turno. **Tiene que cubrir el enum entero**: `_movement_cause_label`
#: cae al valor crudo si falta una, y esa degradación es SILENCIOSA — así
#: llegó `supplier_payment` (2b) a pintarse como «Egreso (supplier_payment)
#: por $150.000» en la pantalla de Dinero, que es exactamente el defecto que
#: 1a ya había arreglado una vez para las otras seis. Hay un test que recorre
#: `CashMovementCause` y exige una etiqueta por miembro.
_MOVEMENT_CAUSE_LABEL = {
    "petty_expense": "Gasto menor",
    "emergency_purchase": "Compra de emergencia",
    "refund": "Devolución",
    "tip_payout": "Pago de propinas",
    "supplier_payment": "Pago a proveedor",
    "other_income": "Otro ingreso",
    "other_expense": "Otro egreso",
}


def _enum_value(value: object) -> str:
    return str(getattr(value, "value", value))


def _movement_kind_label(kind: object) -> str:
    return _MOVEMENT_KIND_LABEL.get(_enum_value(kind), _enum_value(kind))


def _movement_cause_label(cause: object) -> str:
    return _MOVEMENT_CAUSE_LABEL.get(_enum_value(cause), _enum_value(cause))


def build_timeline(db: Session, shift: Shift) -> list[dict[str, Any]]:
    """Eventos ordenados: apertura, roster, movimientos, cambios, retiros,
    relevos, conteos, cierre y rescates (`GET /admin/shifts/{id}/timeline`).
    """

    events: list[dict[str, Any]] = [
        {
            "at": shift.opened_at,
            "kind": "open",
            "summary": f"Apertura del turno por {shift.opened_by_employee_name}",
            "employee_name": shift.opened_by_employee_name,
            "data": {"opening_cash_total": shift.opening_cash_total, "cash_reserve": shift.cash_reserve},
        }
    ]

    for r in db.execute(select(ShiftRoster).where(ShiftRoster.shift_id == shift.id)).scalars():
        events.append(
            {"at": r.in_at, "kind": "roster_in", "summary": f"{r.employee_name} entra al turno", "employee_name": r.employee_name, "data": {"employee_id": r.employee_id}}
        )
        if r.out_at is not None:
            events.append(
                {"at": r.out_at, "kind": "roster_out", "summary": f"{r.employee_name} sale del turno", "employee_name": r.employee_name, "data": {"employee_id": r.employee_id}}
            )

    for m in db.execute(select(CashMovement).where(CashMovement.shift_id == shift.id)).scalars():
        events.append(
            {
                "at": m.at,
                "kind": "movement",
                "summary": f"{_movement_kind_label(m.kind)} ({_movement_cause_label(m.cause)}) por ${m.amount:,}".replace(",", "."),
                "employee_name": m.employee_name,
                "data": {"id": m.id, "kind": m.kind, "cause": m.cause, "amount": m.amount},
            }
        )

    for s in db.execute(select(CashSwap).where(CashSwap.shift_id == shift.id)).scalars():
        events.append({"at": s.at, "kind": "swap", "summary": f"Cambio de denominaciones por ${s.amount}", "employee_name": s.employee_name, "data": {"id": s.id, "amount": s.amount}})

    for p in db.execute(select(CashPickup).where(CashPickup.shift_id == shift.id)).scalars():
        events.append(
            {"at": p.at, "kind": "pickup", "summary": f"Retiro de ${p.amount}", "employee_name": p.employee_name, "data": {"id": p.id, "amount": p.amount}}
        )
        if p.reversed_at is not None:
            events.append(
                {"at": p.reversed_at, "kind": "pickup_reverse", "summary": f"Reversa del retiro #{p.id}: {p.reversed_reason}", "employee_name": p.reversed_by_employee_name, "data": {"id": p.id}}
            )

    for h in db.execute(select(ShiftHandover).where(ShiftHandover.shift_id == shift.id)).scalars():
        label = "Relevo" if h.kind == "handover" else "Arqueo sorpresa"
        events.append(
            {"at": h.at, "kind": h.kind, "summary": f"{label} por {h.from_responsible_name} (diferencia ${h.breakdown.get('difference')})", "employee_name": h.from_responsible_name, "data": {"id": h.id}}
        )

    for c in db.execute(select(ShiftCloseCount).where(ShiftCloseCount.shift_id == shift.id)).scalars():
        events.append(
            {"at": c.created_at, "kind": "close_count", "summary": f"Conteo de cierre por {c.created_by_employee_name}", "employee_name": c.created_by_employee_name, "data": {"id": c.id, "counted_cash_total": c.counted_cash_total, "superseded": c.superseded}}
        )

    if shift.closed_at is not None:
        label = "Cierre administrativo" if shift.closed_without_count else "Cierre"
        events.append(
            {"at": shift.closed_at, "kind": "close", "summary": f"{label}: diferencia ${shift.difference}", "employee_name": shift.closed_by_employee_name, "data": {"difference": shift.difference, "to_deposit": shift.to_deposit}}
        )

    if shift.reopened_at is not None:
        events.append({"at": shift.reopened_at, "kind": "reopen", "summary": f"Turno reabierto: {shift.reopen_reason}", "employee_name": None, "data": {}})

    if shift.cancelled_at is not None:
        events.append({"at": shift.cancelled_at, "kind": "cancel", "summary": f"Turno cancelado: {shift.cancelled_reason}", "employee_name": None, "data": {}})

    for adj in shift.adjustments or []:
        events.append(
            {"at": datetime.fromisoformat(adj["at"]), "kind": "adjust_opening", "summary": f"Ajuste de apertura: {adj.get('reason')}", "employee_name": adj.get("by_employee_name"), "data": adj}
        )

    events.sort(key=lambda e: e["at"])
    return events


def employee_activity(
    db: Session,
    *,
    organization_id: int,
    store_id: int | None,
    employee_id: int,
    date_from: date | None,
    date_to: date | None,
) -> dict[str, Any]:
    """Turnos, entradas/salidas, diferencias y racha, autorizaciones dadas.

    "Racha" acá es la cantidad de cierres consecutivos más recientes con
    diferencia distinta de cero en los que esta persona fue responsable de
    caja (mismo criterio que `_check_difference_streak`, pero de lectura).
    """

    employee = db.get(Employee, employee_id)
    if employee is None or employee.organization_id != organization_id:
        raise AppError("NOT_FOUND", "El empleado no existe en esta organización", status=404)

    stmt = (
        select(ShiftRoster, Shift)
        .join(Shift, ShiftRoster.shift_id == Shift.id)
        .join(BusinessDay, Shift.business_day_id == BusinessDay.id)
        .where(ShiftRoster.employee_id == employee_id, Shift.organization_id == organization_id)
    )
    if store_id is not None:
        stmt = stmt.where(Shift.store_id == store_id)
    if date_from is not None:
        stmt = stmt.where(BusinessDay.business_date >= date_from)
    if date_to is not None:
        stmt = stmt.where(BusinessDay.business_date <= date_to)
    stmt = stmt.order_by(BusinessDay.business_date.desc())

    rows = db.execute(stmt).all()

    shifts_out: list[dict[str, Any]] = []
    closed_as_responsible: list[Shift] = []
    for roster, shift in rows:
        was_responsible = shift.cash_responsible_id == employee_id
        shifts_out.append(
            {
                "shift_id": shift.id,
                "business_date": shift.business_day_id and _business_date_cache(db, shift.business_day_id),
                "role": "cash_responsible" if was_responsible else "roster",
                "in_at": roster.in_at,
                "out_at": roster.out_at,
                "was_cash_responsible": was_responsible,
                "difference": shift.difference if was_responsible else None,
            }
        )
        if was_responsible and shift.status == ShiftStatus.CLOSED:
            closed_as_responsible.append(shift)

    closed_as_responsible.sort(key=lambda s: s.closed_at or clock.now_utc(), reverse=True)
    streak = 0
    for shift in closed_as_responsible:
        if (shift.difference or 0) != 0:
            streak += 1
        else:
            break

    authorizations = list(
        db.execute(
            select(Authorization).where(
                Authorization.authorizer_id == employee_id, Authorization.organization_id == organization_id
            )
        ).scalars()
    )
    authorizations_out = [
        {
            "action": a.action,
            "at": a.at.isoformat() if hasattr(a.at, "isoformat") else a.at,
            "reference_type": a.reference_type,
            "reference_id": a.reference_id,
        }
        for a in authorizations
    ]

    activity = activity_metrics.employee_sales_metrics(
        db,
        organization_id=organization_id,
        store_id=store_id,
        employee_id=employee_id,
        date_from=date_from,
        date_to=date_to,
    )
    team_average = activity_metrics.team_average_metrics(
        db,
        organization_id=organization_id,
        store_id=store_id,
        date_from=date_from,
        date_to=date_to,
        exclude_employee_id=employee_id,
    )

    return {
        "employee": {"id": employee.id, "name": employee.name},
        "shifts": shifts_out,
        "difference_streak": streak,
        "authorizations_given": authorizations_out,
        "activity": activity,
        "team_average": team_average,
    }


def _business_date_cache(db: Session, business_day_id: int) -> date | None:
    day = db.get(BusinessDay, business_day_id)
    return day.business_date if day is not None else None
