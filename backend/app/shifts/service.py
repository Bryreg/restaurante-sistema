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
from datetime import date, datetime, time, timedelta, timezone
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
from app.core.money import format_cop
from app.notifications.service import notify
from app.banking import hooks as banking_hooks
from app.photos import hooks as photos_hooks
from app.stores import service as stores_service
from app.stores.models import Store
from app.shifts import activity_metrics, attendance, hooks, reserve
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
    CashReserveMovement,
    ShiftCarryIn,
    ShiftCloseCount,
    ShiftHandover,
    ShiftOpeningCount,
    ShiftRoster,
    ShiftStatus,
)
from app.shifts.schemas import (
    OpeningCountIn,
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
    """`expected = base + cash_sales + incomes − expenses − pickups − deposits`.

    **`deposits` (2026-09-24)**: lo consignado **desde el cajón** de este
    turno en el POS (`app.banking.hooks.drawer_deposits`). La plata de días
    anteriores se queda en el cajón (decisión del dueño) y entra al esperado
    por el conteo de apertura, que la incluye (`base`); cuando quien tiene la
    caja la lleva al banco, sale. Una consignación rechazada deja de restar.
    `carried_in` es informativo: cuánto de `base` es plata de días
    anteriores (`ShiftCarryIn`), no un sumando aparte.

    **`reserve_loan` (2026-09-26)**: lo que el cajón tomó prestado de la base
    de respaldo y todavía no devolvió (`app.shifts.reserve`). Entra al cajón,
    así que suma; devolverlo lo saca. La base de respaldo en sí NO entra: vive
    aparte y la verifica su custodio. `base` es la apertura del cajón (con la
    regla de sobres, la suma de los sobres contados; con la regla anterior, la
    base fija contada) — la pantalla la llama «Apertura», nunca «base».

    La reserva de caja NO entra (`cash_reserve` no aparece acá). El
    `cash_swap` NO cambia nada (no se consulta). Los retiros reversados no
    restan (filtrados por `reversed_at IS NULL`). Ajustar la apertura
    (rescate) reescribe `opening_cash_total`/`cash_reserve` y lo derivado se
    recalcula llamando de nuevo a esta misma función: no hay una segunda
    fórmula en ningún otro lado.

    **Pedido 2c — lo que NO cambió, que es lo importante.** La fórmula es la
    misma letra por letra. Los dos medios que 2c agrega llegan al esperado
    (o no llegan) sin tocarla:

    - Una venta cobrada por **plataforma** es una cuenta por cobrar, no
      plata en el cajón: `get_sales_totals` la manda a `.other` (el
      `_OTHER_METHODS` de `hooks` ya lo hacía desde 1b-1) y `.other` nunca
      se suma acá. El esperado **no se mueve**, y hay un test que lo cobra
      leyendo el esperado antes y después de vender.
    - El **efectivo de domicilios** que todavía tiene el domiciliario sale
      de `.cash` (ver `SalesTotals` en `hooks`) y entra al cajón recién al
      liquidar, por `incomes`, que ya existía. `delivery_cash_pending` se
      publica acá como **renglón propio e informativo**: es plata de la
      sede que todavía no está en el cajón, y por eso NO se suma a
      `expected`. Sumarlo sería una segunda matemática del esperado y
      además mentiría: el billete no está.
    """

    sales = hooks.get_sales_totals(db, shift.id)
    incomes = _sum_movements(db, shift.id, CashMovementKind.INCOME)
    expenses = _sum_movements(db, shift.id, CashMovementKind.EXPENSE)
    pickups = _sum_pickups(db, shift.id)
    deposits = banking_hooks.drawer_deposits(db, shift.id)
    reserve_loan = reserve.loan_outstanding(db, shift.id)
    base = shift.opening_cash_total
    expected = base + sales.cash + incomes - expenses - pickups - deposits + reserve_loan
    return {
        "base": base,
        "cash_sales": sales.cash,
        "incomes": incomes,
        "expenses": expenses,
        "pickups": pickups,
        "deposits": deposits,
        "reserve_loan": reserve_loan,
        "expected": expected,
        "carried_in": sum(hooks.carried_into(db, shift.id).values()),
        # Informativo, FUERA de `expected` (ver el docstring). Renglón
        # propio del desglose: "el efectivo de domicilios se arquea aparte".
        "delivery_cash_pending": sales.delivery_cash_pending + sales.tips_delivery_pending,
    }


def carried_still_in_drawer(db: Session, shift: Shift) -> int:
    """La plata de días anteriores que sigue en el cajón de este turno: lo que
    se marcó al abrir (`ShiftCarryIn`) menos lo que se consignó desde el
    cajón. **No es de este turno**: es saldo por consignar de sus turnos de
    origen, así que sale de lo que este turno debe consignar al cerrar. Sin
    eso, la venta de ayer se contaría dos veces: en el `to_deposit` de ayer y
    en el de hoy."""
    carried = sum(hooks.carried_into(db, shift.id).values())
    if carried == 0:
        return 0
    return max(0, carried - banking_hooks.drawer_deposits(db, shift.id))


# ---------------------------------------------------------------------------
# Stale / cash_over_threshold
# ---------------------------------------------------------------------------


def end_of_business_day(db: Session, shift: Shift, store: Store) -> datetime | None:
    """El instante (UTC) en que termina el día operativo del turno: la hora
    de corte del día siguiente a su `business_date`. Pasado este punto el
    turno ya es abandonado (`is_shift_stale`)."""
    day = db.get(BusinessDay, shift.business_day_id)
    if day is None:
        return None
    cutoff_local = datetime.combine(
        day.business_date + timedelta(days=1), time(hour=store.cutoff_hour), tzinfo=tz.BOGOTA
    )
    return cutoff_local.astimezone(timezone.utc)


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


def handover_candidates(db: Session, *, shift: Shift) -> list[tuple[Employee, bool]]:
    """A quién se le puede entregar el cajón en un relevo: personas activas
    de la sede (o admins de la organización) que pueden tocar la caja
    —`can_charge`, supervisor o admin, la misma regla de
    `hooks.can_handle_cash` sin el «responsable actual»—, menos quien ya la
    tiene. Cada una con `on_shift` (tiene entrada abierta en el roster), y
    las del turno primero."""

    on_shift_ids = {
        r.employee_id for r in list_roster(db, shift.id) if r.out_at is None
    }
    rows = db.execute(
        select(Employee)
        .where(
            Employee.organization_id == shift.organization_id,
            Employee.active.is_(True),
            (Employee.store_id == shift.store_id) | Employee.store_id.is_(None),
            Employee.id != shift.cash_responsible_id,
        )
        .order_by(Employee.name)
    ).scalars().all()
    eligible = [e for e in rows if e.can_charge or e.role in ("supervisor", "admin")]
    return sorted(
        ((e, e.id in on_shift_ids) for e in eligible),
        key=lambda pair: (not pair[1], pair[0].name),
    )


# ---------------------------------------------------------------------------
# POST /shifts/open
# ---------------------------------------------------------------------------


ENVELOPES = "envelopes"
FIXED_BASE = "fixed_base"


def opening_mode_of(db: Session, store: Store) -> str:
    """Cómo abre el cajón esta sede: `envelopes` (decisión del dueño,
    2026-09-26) o `fixed_base` (la regla anterior)."""
    mode = stores_service.get_cash_settings(db, store.id).opening_mode
    return ENVELOPES if mode == ENVELOPES else FIXED_BASE


def open_shift(db: Session, *, actor: Actor, store: Store, payload: OpenShiftIn) -> Shift:
    if opening_mode_of(db, store) == ENVELOPES:
        return _open_shift_with_envelopes(db, actor=actor, store=store, payload=payload)
    if payload.opening_count_id is not None:
        raise AppError(
            "OPENING_MODE_MISMATCH",
            "Esta sede abre con la base fija, no con sobres: contá la base y volvé a intentar",
            status=400,
        )
    if payload.opening_cash is None:
        raise AppError("OPENING_CASH_REQUIRED", "Contá la base fija por denominaciones para abrir el turno", status=400)
    cash_settings = stores_service.get_cash_settings(db, store.id)

    denominations = _to_denominations(payload.opening_cash.denominations)
    counted = money.validate_denominations(denominations, payload.opening_cash.total)

    carried = _resolve_carried(db, store=store, shift_ids=payload.carried_shift_ids)
    carried_total = sum(p.outstanding for p in carried)

    if payload.carried_counted_apart:
        # Base y sobres aparte: lo contado es sólo la base; cada sobre se
        # confirmó entero y vale lo que el servidor publica de ese día. La
        # apertura del cajón es la suma, hecha acá (una sola matemática).
        total = counted + carried_total
        if counted != cash_settings.opening_cash_fixed and not payload.opening_cause:
            raise AppError(
                "OPENING_DIFFERENCE_NEEDS_CAUSE",
                f"La base contada ({format_cop(counted)}) no coincide con la base fija "
                f"({format_cop(cash_settings.opening_cash_fixed)}). Volvé a contarla o elegí una causa para poder abrir el turno",
                status=400,
            )
    else:
        total = counted
    expected_opening = cash_settings.opening_cash_fixed + carried_total

    if not payload.carried_counted_apart and total != expected_opening and not payload.opening_cause:
        if carried_total:
            detail = (
                f"la base fija ({format_cop(cash_settings.opening_cash_fixed)}) más lo marcado de días anteriores "
                f"({format_cop(carried_total)}) da {format_cop(expected_opening)}"
            )
        else:
            detail = f"la base fija es {format_cop(cash_settings.opening_cash_fixed)}"
        raise AppError(
            "OPENING_DIFFERENCE_NEEDS_CAUSE",
            f"Lo contado ({format_cop(total)}) no coincide: {detail}. Elegí una causa para poder abrir el turno",
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
        opening_mode=FIXED_BASE,
        opening_fixed_base=cash_settings.opening_cash_fixed,
        adjustments=[],
    )
    _insert_shift(db, shift)

    for pending in carried:
        db.add(
            ShiftCarryIn(
                organization_id=store.organization_id,
                store_id=store.id,
                shift_id=shift.id,
                source_shift_id=pending.shift_id,
                amount=pending.outstanding,
                created_at=now,
            )
        )
    if carried:
        db.flush()

    _after_open(db, actor=actor, store=store, shift=shift, cash_responsible=cash_responsible, opener_id=opener_id)

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
            "carried": {str(p.shift_id): p.outstanding for p in carried},
            "carried_counted_apart": payload.carried_counted_apart,
        },
    )
    return shift


def _insert_shift(db: Session, shift: Shift) -> None:
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


def _after_open(
    db: Session, *, actor: Actor, store: Store, shift: Shift, cash_responsible: Employee, opener_id: int
) -> None:
    hooks.on_employee_identified(db, store_id=store.id, employee=cash_responsible)
    if opener_id != cash_responsible.id:
        opener = db.get(Employee, opener_id)
        if opener is not None:
            hooks.on_employee_identified(db, store_id=store.id, employee=opener)
    # La asistencia del día manda (0028): quien marcó entrada antes de que
    # se abriera la caja también está en este turno.
    attendance.sync_roster_on_shift_open(db, shift=shift)

    # Comandas que quedaron trasladadas (`shift_id NULL`) por el cierre de un
    # turno anterior: este nuevo turno las adopta (CONTRATO-INTERNO-1b-1.md
    # §2.5, dueño del test E2E: backend-base).
    _adopt_transferred_orders(db, store_id=store.id, shift=shift, actor=actor)


# ---------------------------------------------------------------------------
# Apertura por sobres (decisión del dueño, 2026-09-26)
# ---------------------------------------------------------------------------


def opening_envelope_candidates(db: Session, *, store: Store) -> list[banking_hooks.PendingShift]:
    """Los sobres que quien abre puede elegir: los días con saldo por
    consignar (sin «Consignaciones» no hay saldo publicado, y la lista queda
    vacía). La pantalla recibe sólo la fecha: el monto se revela al sellar."""
    if not features.is_enabled(db, store.organization_id, store.id, "money.deposits"):
        return []
    return banking_hooks.pending_shifts(db, organization_id=store.organization_id, store_id=store.id)


def _open_shift_in_store(db: Session, store: Store) -> bool:
    return (
        db.execute(select(Shift.id).where(Shift.store_id == store.id, Shift.status == ShiftStatus.OPEN)).first()
        is not None
    )


def pending_opening_count(db: Session, *, store: Store) -> ShiftOpeningCount | None:
    """El conteo sellado más reciente de la sede que todavía no abrió turno
    (ni quedó superado): la pantalla retoma la revelación con él."""
    return (
        db.execute(
            select(ShiftOpeningCount)
            .where(
                ShiftOpeningCount.store_id == store.id,
                ShiftOpeningCount.shift_id.is_(None),
                ShiftOpeningCount.superseded.is_(False),
            )
            .order_by(ShiftOpeningCount.created_at.desc(), ShiftOpeningCount.id.desc())
        )
        .scalars()
        .first()
    )


def opening_count_view(count: ShiftOpeningCount) -> dict[str, Any]:
    """La revelación de un conteo sellado: por sobre, esperado, contado y
    diferencia, con quién contó. La diferencia se calcula acá, una vez."""
    envelopes = [
        {
            "shift_id": e["source_shift_id"],
            "business_date": e["business_date"],
            "expected": e["expected"],
            "counted": e["counted"],
            "difference": e["counted"] - e["expected"],
        }
        for e in (count.envelopes or [])
    ]
    return {
        "id": count.id,
        "counted_by": {"id": count.counted_by_employee_id, "name": count.counted_by_employee_name},
        "counted_at": count.created_at,
        "envelopes": envelopes,
        "expected_total": count.expected_total,
        "counted_total": count.counted_total,
        "difference_total": count.counted_total - count.expected_total,
        "requires_cause": any(e["difference"] != 0 for e in envelopes),
        "used": count.shift_id is not None,
    }


def seal_opening_count(db: Session, *, actor: Actor, store: Store, payload: OpeningCountIn) -> ShiftOpeningCount:
    """El cuadre de apertura por sobres, **sellado a ciegas**: cada sobre
    elegido se contó aparte, por denominaciones, sin ver su monto. Se valida
    todo antes de escribir; el saldo de cada sobre lo calcula el servidor.
    Un conteo anterior sin usar queda superado (se conserva)."""
    if opening_mode_of(db, store) != ENVELOPES:
        raise AppError(
            "OPENING_MODE_MISMATCH",
            "Esta sede abre con la base fija, no con sobres: contá la base al abrir el turno",
            status=400,
        )
    if _open_shift_in_store(db, store):
        raise AppError("SHIFT_ALREADY_OPEN", "Ya hay un turno abierto en esta sede: cerralo antes de abrir otro", status=400)
    if actor.employee_id is None:
        raise AppError("IDENTIFY_REQUIRED", "Identificate con tu PIN antes de contar los sobres", status=401)

    ids = [e.shift_id for e in payload.envelopes]
    pending = {p.shift_id: p for p in _resolve_carried(db, store=store, shift_ids=ids)}
    envelopes: list[dict[str, Any]] = []
    for item in payload.envelopes:
        counted = money.validate_denominations(_to_denominations(item.counted.denominations), item.counted.total)
        p = pending[item.shift_id]
        envelopes.append(
            {
                "source_shift_id": p.shift_id,
                "business_date": p.business_date.isoformat(),
                "expected": p.outstanding,
                "counted": counted,
                "difference": counted - p.outstanding,
                "denominations": [d.model_dump() for d in item.counted.denominations],
            }
        )

    previous = pending_opening_count(db, store=store)
    if previous is not None:
        previous.superseded = True

    count = ShiftOpeningCount(
        organization_id=store.organization_id,
        store_id=store.id,
        shift_id=None,
        envelopes=envelopes,
        expected_total=sum(e["expected"] for e in envelopes),
        counted_total=sum(e["counted"] for e in envelopes),
        counted_by_employee_id=actor.employee_id,
        counted_by_employee_name=actor.employee_name or "",
        created_at=clock.now_utc(),
        superseded=False,
    )
    db.add(count)
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="shift_opening_count",
        entity_id=count.id,
        action="seal",
        before=None,
        after={
            "envelopes": {
                str(e["source_shift_id"]): {"expected": e["expected"], "counted": e["counted"]} for e in envelopes
            },
            "superseded": previous.id if previous is not None else None,
        },
    )
    return count


def get_opening_count_or_404(db: Session, *, store: Store, count_id: int) -> ShiftOpeningCount:
    count = db.get(ShiftOpeningCount, count_id)
    if count is None or count.store_id != store.id:
        raise AppError("NOT_FOUND", "El conteo de apertura no existe en esta sede", status=404)
    return count


def opening_count_of_shift(db: Session, shift_id: int) -> ShiftOpeningCount | None:
    return db.execute(select(ShiftOpeningCount).where(ShiftOpeningCount.shift_id == shift_id)).scalars().first()


def _open_shift_with_envelopes(db: Session, *, actor: Actor, store: Store, payload: OpenShiftIn) -> Shift:
    """Abrir con la regla de sobres: el cajón abre con lo contado en el
    conteo sellado (`opening_count_id`) y nada más —ni base fija, ni la base
    de respaldo, que vive aparte—. Sin conteo, el cajón abre vacío (no se
    eligió ningún sobre). Todo se valida antes de escribir."""
    if payload.carried_shift_ids or payload.carried_counted_apart:
        raise AppError(
            "OPENING_MODE_MISMATCH",
            "Esta sede abre con sobres: elegí y contá cada sobre en la apertura, no los marques",
            status=400,
        )
    count: ShiftOpeningCount | None = None
    if payload.opening_count_id is not None:
        count = get_opening_count_or_404(db, store=store, count_id=payload.opening_count_id)
        if count.shift_id is not None or count.superseded:
            raise AppError(
                "OPENING_COUNT_USED",
                "Ese conteo de sobres ya se usó o se reemplazó por otro: volvé a contar los sobres",
                status=409,
            )
    elif payload.opening_cash is not None and payload.opening_cash.total != 0:
        raise AppError(
            "OPENING_COUNT_REQUIRED",
            "Esta sede abre sólo con los sobres por consignar: elegí los sobres y contá cada uno antes de abrir",
            status=400,
        )

    if _open_shift_in_store(db, store):
        raise AppError("SHIFT_ALREADY_OPEN", "Ya hay un turno abierto en esta sede: cerralo antes de abrir otro", status=400)

    envelopes = list(count.envelopes or []) if count is not None else []
    # El saldo de cada sobre se vuelve a leer ahora: si cambió desde que se
    # contó (una consignación del administrador, por ejemplo), la
    # comparación ya no vale y hay que volver a contar.
    sealed = {int(e["source_shift_id"]): int(e["expected"]) for e in envelopes}
    stale: list[int] = []
    if sealed:
        pending = {p.shift_id: p.outstanding for p in opening_envelope_candidates(db, store=store)}
        stale = [sid for sid, expected in sealed.items() if pending.get(sid) != expected]
    if stale:
        raise AppError(
            "OPENING_COUNT_STALE",
            "El saldo de un sobre cambió mientras contabas (alguien lo consignó): volvé a contar los sobres",
            status=409,
            extra={"shift_ids": stale},
        )

    counted_total = count.counted_total if count is not None else 0
    expected_total = count.expected_total if count is not None else 0
    has_difference = any(int(e["counted"]) != int(e["expected"]) for e in envelopes)
    if has_difference and not payload.opening_cause:
        raise AppError(
            "OPENING_DIFFERENCE_NEEDS_CAUSE",
            f"Los sobres contados ({format_cop(counted_total)}) no coinciden con su saldo "
            f"({format_cop(expected_total)}). Elegí una causa para poder abrir el turno",
            status=400,
        )

    cash_responsible = _get_org_employee(db, store.organization_id, payload.cash_responsible_id)

    day, created = get_or_create_business_day(
        db, organization_id=store.organization_id, store_id=store.id, cutoff_hour=store.cutoff_hour
    )
    if created:
        _reset_daily_availability_if_present(db, store_id=store.id)

    now = clock.now_utc()
    opener_id = actor.employee_id or cash_responsible.id
    opener_name = actor.employee_name or cash_responsible.name

    merged: dict[int, int] = {}
    for e in envelopes:
        for d in e.get("denominations") or []:
            merged[int(d["value"])] = merged.get(int(d["value"]), 0) + int(d["count"])

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
        opening_cash_total=counted_total,
        opening_denominations=[{"value": v, "count": c} for v, c in sorted(merged.items(), reverse=True) if c],
        # La base de respaldo no se declara al abrir: vive aparte y la
        # verifica su custodio (`app.shifts.reserve`).
        cash_reserve=0,
        opening_cause=payload.opening_cause if has_difference else None,
        opening_note=payload.opening_note if has_difference else None,
        opening_mode=ENVELOPES,
        opening_fixed_base=0,
        adjustments=[],
    )
    _insert_shift(db, shift)

    for source_shift_id, expected in sealed.items():
        db.add(
            ShiftCarryIn(
                organization_id=store.organization_id,
                store_id=store.id,
                shift_id=shift.id,
                source_shift_id=source_shift_id,
                amount=expected,
                created_at=now,
            )
        )
    if count is not None:
        count.shift_id = shift.id
    db.flush()

    _after_open(db, actor=actor, store=store, shift=shift, cash_responsible=cash_responsible, opener_id=opener_id)

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
            "opening_mode": ENVELOPES,
            "opening_cash_total": counted_total,
            "opening_count_id": count.id if count is not None else None,
            "cash_responsible_id": cash_responsible.id,
            "business_day_id": day.id,
            "carried": {str(k): v for k, v in sealed.items()},
        },
    )
    return shift


def _resolve_carried(db: Session, *, store: Store, shift_ids: list[int]) -> list[banking_hooks.PendingShift]:
    """Los turnos que quien abre marcó como presentes en el cajón, con su
    saldo **recalculado acá** —nunca el número que mande la pantalla—.

    Sólo se puede marcar un turno de esta sede, cerrado con conteo y con
    saldo por consignar; y sólo con «Consignaciones» encendida, que es lo
    que publica ese saldo. Se valida todo antes de escribir nada.
    """
    if not shift_ids:
        return []
    if len(set(shift_ids)) != len(shift_ids):
        raise AppError("CARRIED_SHIFT_REPEATED", "Marcaste el mismo día dos veces", status=400)
    if not features.is_enabled(db, store.organization_id, store.id, "money.deposits"):
        raise AppError(
            "CARRIED_REQUIRES_DEPOSITS",
            "Para marcar días por consignar en la caja, activá «Consignaciones» en Funciones",
            status=400,
        )
    pending = {p.shift_id: p for p in banking_hooks.pending_shifts(db, organization_id=store.organization_id, store_id=store.id)}
    missing = [sid for sid in shift_ids if sid not in pending]
    if missing:
        raise AppError(
            "CARRIED_SHIFT_NOT_PENDING",
            "Uno de los días marcados ya no tiene plata por consignar (o no es de esta sede): recargá la lista",
            status=400,
            extra={"shift_ids": missing},
        )
    return [pending[sid] for sid in shift_ids]


# ---------------------------------------------------------------------------
# POST /shifts/{id}/roster
# ---------------------------------------------------------------------------


def _open_roster_entry(db: Session, shift: Shift, employee_id: int) -> ShiftRoster | None:
    return db.execute(
        select(ShiftRoster)
        .where(ShiftRoster.shift_id == shift.id, ShiftRoster.employee_id == employee_id, ShiftRoster.out_at.is_(None))
        .order_by(ShiftRoster.in_at.desc())
    ).scalars().first()


def _end_open_roster(db: Session, *, actor: Actor, shift: Shift, at: datetime) -> None:
    """Al cerrar el turno, la jornada de quien sigue adentro termina con él.

    Sin esto, una entrada sin `out_at` de un turno ya cerrado se contaba
    hasta `clock.now_utc()` en nómina (`app/payroll/service.py`,
    `_worked_intervals`) y en el reparto de propinas por horas: la persona
    responsable de caja —que por regla NO puede marcar salida por el roster
    (`NOT_CASH_RESPONSIBLE`)— acumulaba cientos de horas extra por semana.
    Una pausa abierta también se cierra en `at`.
    """
    entries = db.execute(
        select(ShiftRoster).where(ShiftRoster.shift_id == shift.id, ShiftRoster.out_at.is_(None))
    ).scalars().all()
    for entry in entries:
        if entry.pauses and entry.pauses[-1].get("end") is None:
            pauses = list(entry.pauses)
            pauses[-1] = {**pauses[-1], "end": at.isoformat()}
            entry.pauses = pauses
        entry.out_at = max(at, entry.in_at)
        record_audit(
            db,
            actor=actor,
            organization_id=shift.organization_id,
            store_id=shift.store_id,
            entity="shift_roster",
            entity_id=entry.id,
            action="out_on_close",
            before=None,
            after={"employee_id": entry.employee_id, "action": "out_on_close", "at": entry.out_at.isoformat()},
        )
    db.flush()


def _reopen_roster_closed_by_close(db: Session, *, actor: Actor, shift: Shift) -> None:
    from app.audit.models import AuditLog

    closed_ids = {
        int(row.entity_id)
        for row in db.execute(
            select(AuditLog).where(
                AuditLog.entity == "shift_roster",
                AuditLog.action == "out_on_close",
                AuditLog.store_id == shift.store_id,
                AuditLog.at >= (shift.closed_at or shift.opened_at),
            )
        ).scalars()
        if row.entity_id is not None
    }
    if not closed_ids:
        return
    entries = db.execute(
        select(ShiftRoster).where(ShiftRoster.shift_id == shift.id, ShiftRoster.id.in_(closed_ids))
    ).scalars().all()
    for entry in entries:
        before_out = entry.out_at
        entry.out_at = None
        record_audit(
            db,
            actor=actor,
            organization_id=shift.organization_id,
            store_id=shift.store_id,
            entity="shift_roster",
            entity_id=entry.id,
            action="in_on_reopen",
            before={"out_at": before_out.isoformat() if before_out else None},
            after={"employee_id": entry.employee_id, "action": "in_on_reopen"},
        )
    db.flush()


def roster_action(db: Session, *, actor: Actor, shift: Shift, payload: RosterActionIn) -> ShiftRoster:
    _require_open(shift)
    employee = _get_org_employee(db, shift.organization_id, payload.employee_id)

    if not auth_service.verify_pin(db, employee, payload.pin):
        raise AppError("PIN_INVALID", "El PIN no es válido: volvé a intentarlo", status=400)

    if employee.role == "admin":
        # Decisión del dueño: en la tablet el administrador sólo autoriza.
        # No entra al turno, no suma horas ni propina.
        raise AppError(
            "ADMIN_NOT_IN_ROSTER",
            "El administrador autoriza, no entra al turno: no suma horas ni propina",
            status=400,
        )

    if payload.action == "out" and employee.id == shift.cash_responsible_id:
        raise AppError(
            "NOT_CASH_RESPONSIBLE",
            "El responsable de caja no sale por acá: hacé un relevo del turno antes de salir",
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
    # La salida y las pausas del roster son las de la jornada del día (0028).
    if payload.action != "in":
        attendance.mirror_roster_action(
            db, actor=actor, store_id=shift.store_id, employee=employee, action=payload.action, at=now
        )
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
        if new_responsible.id == shift.cash_responsible_id:
            raise AppError(
                "HANDOVER_SAME_RESPONSIBLE",
                f"{new_responsible.name} ya tiene la caja: elegí a otra persona para el relevo",
                status=400,
            )
        # Quien recibe confirma con su PIN, antes de escribir nada.
        if not payload.new_responsible_pin:
            raise AppError(
                "NEW_RESPONSIBLE_PIN_REQUIRED",
                f"{new_responsible.name} tiene que confirmar el relevo con su PIN",
                status=400,
            )
        if not auth_service.verify_pin(db, new_responsible, payload.new_responsible_pin):
            now = clock.now_utc()
            if new_responsible.pin_locked_until is not None and new_responsible.pin_locked_until > now:
                raise AppError(
                    "PIN_LOCKED",
                    f"El PIN de {new_responsible.name} está bloqueado por varios intentos fallidos; esperá unos minutos",
                    status=400,
                )
            raise AppError(
                "NEW_RESPONSIBLE_PIN_INVALID",
                f"El PIN de {new_responsible.name} no es correcto; que lo teclee de nuevo",
                status=400,
            )
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
        photo=photos_hooks.store_photo(db, payload.photo, organization_id=shift.organization_id, store_id=shift.store_id),
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


# Causas que produce SÓLO un camino del sistema y que nadie puede teclear a
# mano en `POST /shifts/{id}/cash-movements`. Si se pudieran, habría dos
# puertas hacia el mismo efectivo y el cajón cuadraría el doble: una
# liquidación de domicilios cargada a mano sumaría lo mismo que ya sumó la
# liquidación real, y nada lo detectaría hasta el conteo a ciegas.
#
# `supplier_payment` (2b) tiene exactamente el mismo problema y NO está en
# esta lista a propósito: agregarla cambiaría el comportamiento publicado de
# otro pedido sin su dueño presente. Queda declarado como observación en el
# entregable de este agente, no corregido en silencio.
_SYSTEM_ONLY_MOVEMENT_CAUSES = {"delivery_settlement"}


def create_cash_movement(
    db: Session, *, actor: Actor, shift: Shift, store: Store, payload: CashMovementIn
) -> CashMovement:
    _require_open(shift)

    if payload.cause in _SYSTEM_ONLY_MOVEMENT_CAUSES:
        raise AppError(
            "CAUSE_NOT_MANUAL",
            "La liquidación de domicilios no se carga como movimiento de caja: registrala en Domicilios "
            "y el ingreso al turno lo escribe el sistema",
            status=400,
            extra={"cause": payload.cause},
        )

    authorizer: Employee | None = None
    if payload.kind == "expense":
        settings = stores_service.get_cash_settings(db, store.id)
        if payload.amount > settings.petty_cash_limit:
            if not payload.authorizer_pin:
                raise AppError(
                    "PETTY_CASH_LIMIT",
                    f"El egreso supera el límite de caja menor ({format_cop(settings.petty_cash_limit)}): pedí el PIN de un administrador",
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
        receipt_photo=photos_hooks.store_photo(
            db, payload.receipt_photo, organization_id=shift.organization_id, store_id=shift.store_id
        ),
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
        photo=photos_hooks.store_photo(db, payload.photo, organization_id=shift.organization_id, store_id=shift.store_id),
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
    card_sales: int
    card_tips: int
    card_counted: int | None
    card_difference: int | None
    transfer_registered: int
    transfer_sales: int
    transfer_tips: int
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

    # Lo que tiene que marcar el lote del datáfono es lo que se le pasó a la
    # tarjeta: la venta MÁS la propina cobrada con tarjeta. Contra `sales.card`
    # solo, todo turno con propinas de tarjeta cerraba con una diferencia
    # igual, al peso, a esas propinas — y una diferencia que aparece todos los
    # días enseña a ignorar las diferencias, que es justo lo que el arqueo a
    # ciegas existe para evitar. El esperado del EFECTIVO no se toca: la
    # propina en efectivo se salda por `tips_cash_out`/`to_deposit`, como
    # siempre.
    card_registered = sales.card + sales.tips_card
    transfer_registered = sales.transfer + sales.tips_transfer
    card_difference = None if count.counted_card is None else count.counted_card - card_registered
    transfer_difference = (
        None if count.counted_transfer is None else count.counted_transfer - transfer_registered
    )

    return CloseEvaluation(
        breakdown=breakdown,
        expected=breakdown["expected"],
        counted=count.counted_cash_total,
        difference=difference,
        card_registered=card_registered,
        card_sales=sales.card,
        card_tips=sales.tips_card,
        card_counted=count.counted_card,
        card_difference=card_difference,
        transfer_registered=transfer_registered,
        transfer_sales=sales.transfer,
        transfer_tips=sales.tips_transfer,
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
        # Lo consignado desde el cajón (2026-09-24) sí es un sumando del
        # esperado: sin este renglón, los que se ven no llegaban al total.
        "deposits": ev.breakdown["deposits"],
        # Lo prestado por la base de respaldo (2026-09-26) también es un
        # sumando: el conteo no entra con préstamo abierto, así que casi
        # siempre vale 0, pero la ecuación publicada tiene que cerrar.
        "reserve_loan": ev.breakdown["reserve_loan"],
        "expected": ev.expected,
        # Pedido 2c: el paso 2 del cierre a ciegas es EL momento en que hay
        # que ver que el efectivo de domicilios no está en el cajón —
        # quien cuenta acaba de contar y le van a preguntar por una
        # diferencia—. Va como renglón propio, FUERA de `expected`: la
        # ecuación del esperado no cambió.
        "delivery_cash_pending": ev.breakdown["delivery_cash_pending"],
    }
    return {
        "count_id": count.id,
        "expected": ev.expected,
        "difference": ev.difference,
        # Lo contado, tal como se selló: al retomar el cierre en el paso 2
        # la pantalla ya no tiene lo tecleado.
        "counted": ev.counted,
        "counted_pieces": sum(int(d.get("count", 0)) for d in (count.counted_cash_denominations or [])),
        "equation": equation,
        "card": {
            "registered": ev.card_registered,
            "sales": ev.card_sales,
            "tips": ev.card_tips,
            "counted": ev.card_counted,
            "difference": ev.card_difference,
        },
        "transfer": {
            "registered": ev.transfer_registered,
            "sales": ev.transfer_sales,
            "tips": ev.transfer_tips,
            "counted": ev.transfer_counted,
            "difference": ev.transfer_difference,
        },
        "requires_cause": ev.requires_cause,
        "requires_identified_cause": ev.requires_identified_cause,
        "is_critical": ev.is_critical,
        "closes_day_suggested": not _has_other_open_shift_same_day(db, shift),
        "open_orders": _count_open_orders(db, shift.id),
    }


def _cop_or_dash(value: Any) -> str:
    """Plata de un texto de la cronología; sin dato es «—», nunca «$None»."""
    return format_cop(int(value)) if isinstance(value, int) else "—"


#: Cuántos cierres hacia atrás se miran para la racha (una racha más larga
#: que esto ya se reportó varias veces).
_STREAK_LOOKBACK = 60


def difference_streak_from(differences: list[int | None], tolerance: int) -> int:
    """Racha de cierres con diferencia de caja, del más reciente hacia
    atrás: cuenta los que se pasan de `tolerance` (en valor absoluto) y
    corta en el primero que queda dentro. Un cierre SIN CONTEO (`None`) no
    es dato: ni suma ni corta, se salta.

    Antes era `(difference or 0) != 0`: el `None` se leía como «cuadró en
    cero» y una diferencia de $50 contaba igual que una de $50.000 (informe
    científico #16). `tolerance` es `tolerance_unknown_cause` de la sede, la
    misma con la que el cierre exige una causa identificada."""
    streak = 0
    for difference in differences:
        if difference is None:
            continue
        if abs(difference) <= tolerance:
            break
        streak += 1
    return streak


def current_difference_streak(db: Session, *, store_id: int, employee_id: int) -> int:
    """La racha ACTUAL de una persona como responsable de caja en la sede
    (`difference_streak_from` sobre sus últimos cierres). Publicada en
    `app.shifts.hooks` para que el aviso de Hoy use la misma regla."""
    settings = stores_service.get_cash_settings(db, store_id)
    differences = list(
        db.execute(
            select(Shift.difference)
            .where(
                Shift.store_id == store_id,
                Shift.cash_responsible_id == employee_id,
                Shift.status == ShiftStatus.CLOSED,
                Shift.closed_without_count.is_(False),
            )
            .order_by(Shift.closed_at.desc(), Shift.id.desc())
            .limit(_STREAK_LOOKBACK)
        ).scalars()
    )
    return difference_streak_from(differences, settings.tolerance_unknown_cause)


def _check_difference_streak(db: Session, shift: Shift, store: Store) -> None:
    settings = stores_service.get_cash_settings(db, store.id)
    n = settings.streak_alert_shifts
    if not n or n <= 0:
        return
    streak = current_difference_streak(db, store_id=shift.store_id, employee_id=shift.cash_responsible_id)
    if streak >= n:
        notify(
            db,
            organization_id=shift.organization_id,
            store_id=shift.store_id,
            type="difference_streak",
            level="warning",
            title="Racha de diferencias de caja",
            body=(
                f"{shift.cash_responsible_name} cerró {streak} turnos seguidos con una diferencia de más de "
                f"{format_cop(settings.tolerance_unknown_cause)}."
            ),
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

    # Sólo la venta de este turno: la plata de días anteriores que sigue en el
    # cajón es saldo de sus turnos de origen (`carried_still_in_drawer`).
    # La base fija es la que el TURNO congeló al abrir (`opening_fixed_base`,
    # 0 con la regla de sobres), no la de la sede hoy. Y lo prestado por la
    # base de respaldo vuelve a la base, nunca al banco (`reserve_loan`; el
    # cierre contado no entra con préstamo abierto, así que acá vale 0, pero
    # la resta se escribe igual: es la misma cuenta que el cierre
    # administrativo, que sí puede encontrar un préstamo).
    to_deposit = (
        count.counted_cash_total
        - shift.opening_fixed_base
        - (count.tips_cash_out or 0)
        - carried_still_in_drawer(db, shift)
        - reserve.loan_outstanding(db, shift.id)
    )
    shift.to_deposit = to_deposit

    db.flush()
    _end_open_roster(db, actor=actor, shift=shift, at=now)

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
            body=f"El turno #{shift.id} cerró con una diferencia de {format_cop(ev.difference)}.",
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
            body=f"El turno #{shift.id} cerró con una diferencia crítica de {format_cop(ev.difference)}. El cierre sigue en pie.",
            payload={"shift_id": shift.id, "difference": ev.difference},
            dedupe_key=f"cash_difference_critical:{shift.id}",
        )

    _check_difference_streak(db, shift, store)

    return {"to_deposit": to_deposit, "closes_day": closes_day}


# ---------------------------------------------------------------------------
# Cierre a ciegas en tres pasos (cash.blind_close encendido)
# ---------------------------------------------------------------------------


def _reject_open_reserve_loan(db: Session, shift: Shift) -> None:
    """Decisión del dueño (2026-09-26): lo tomado de la base de respaldo se
    devuelve el mismo día, **antes** del conteo de cierre. Con préstamo
    abierto el cierre no se cuenta: el mensaje dice cuánto y dónde
    devolverlo. Se llama antes de escribir nada."""
    owed = reserve.loan_outstanding(db, shift.id)
    if owed > 0:
        raise AppError(
            "RESERVE_LOAN_OPEN",
            f"El cajón le debe {format_cop(owed)} a la base de respaldo: devolvelos en Turno › Devolver a la base "
            "antes de contar el cierre",
            status=400,
            extra={"owed": owed},
        )


def create_close_count(db: Session, *, actor: Actor, shift: Shift, store: Store, payload: CloseCountIn) -> ShiftCloseCount:
    _require_open(shift)
    _reject_open_reserve_loan(db, shift)
    _check_photo_required(db, store, payload.photo, setting_attr="photo_required_on_close")

    denominations = _to_denominations(payload.counted_cash.denominations)
    total = money.validate_denominations(denominations, payload.counted_cash.total)

    sales = hooks.get_sales_totals(db, shift.id)
    # `+ tips_*`: una cuenta de cortesía con propina de tarjeta deja venta 0 y
    # propina > 0. El lote del datáfono la muestra igual, así que hay que
    # pedir el total.
    if sales.card + sales.tips_card > 0 and payload.counted_card is None:
        raise AppError("CARD_TOTAL_REQUIRED", "Ingresá el total del datáfono: hubo ventas registradas con tarjeta", status=400)
    if sales.transfer + sales.tips_transfer > 0 and payload.counted_transfer is None:
        raise AppError(
            "TRANSFER_TOTAL_REQUIRED", "Ingresá el total de transferencias: hubo ventas registradas por transferencia", status=400
        )

    # Un conteo sellado que sigue activo: este conteo lo reemplaza. Se lee
    # acá (después de validar todo y antes de escribir nada).
    previous = _get_active_close_count(db, shift.id)
    previous_seen = previous is not None and _review_was_opened(db, previous.id)

    count = ShiftCloseCount(
        organization_id=shift.organization_id,
        store_id=shift.store_id,
        shift_id=shift.id,
        counted_cash_total=total,
        counted_cash_denominations=[d.model_dump() for d in payload.counted_cash.denominations],
        counted_card=payload.counted_card,
        counted_transfer=payload.counted_transfer,
        tips_cash_out=payload.tips_cash_out,
        photo=photos_hooks.store_photo(db, payload.photo, organization_id=shift.organization_id, store_id=shift.store_id),
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
    if previous is not None:
        # Volver a contar deja el conteo anterior superado (se conserva). Si
        # la persona ya había abierto el paso 2 —vio el esperado—, el conteo
        # nuevo queda marcado para el administrador: «recontado después de
        # ver el esperado». La marca vive en la auditoría del conteo (sin
        # columna nueva) y la leen la cronología y el listado del turno.
        previous.superseded = True
        db.flush()
        if previous_seen:
            record_audit(
                db,
                actor=actor,
                organization_id=shift.organization_id,
                store_id=shift.store_id,
                entity="shift_close_count",
                entity_id=count.id,
                action=RECOUNT_AFTER_REVIEW_ACTION,
                before={"count_id": previous.id, "counted_cash_total": previous.counted_cash_total},
                after={"count_id": count.id, "counted_cash_total": total},
            )
    return count


#: Acciones de auditoría del cierre a ciegas que el resto del módulo lee.
REVIEW_OPENED_ACTION = "review_opened"
RECOUNT_AFTER_REVIEW_ACTION = "recount_after_review"


def _audit_actions_of_counts(db: Session, count_ids: list[int], action: str) -> set[int]:
    from app.audit.models import AuditLog

    if not count_ids:
        return set()
    rows = db.execute(
        select(AuditLog.entity_id).where(
            AuditLog.entity == "shift_close_count",
            AuditLog.action == action,
            AuditLog.entity_id.in_([str(i) for i in count_ids]),
        )
    ).scalars()
    return {int(r) for r in rows}


def _review_was_opened(db: Session, count_id: int) -> bool:
    return bool(_audit_actions_of_counts(db, [count_id], REVIEW_OPENED_ACTION))


def mark_review_opened(db: Session, *, actor: Actor, shift: Shift, count: ShiftCloseCount) -> None:
    """El paso 2 se abrió para este conteo: la persona vio el esperado. Se
    anota una sola vez (auditoría), para poder decir después si un conteo
    nuevo es un «recontado después de ver el esperado»."""
    if _review_was_opened(db, count.id):
        return
    record_audit(
        db,
        actor=actor,
        organization_id=shift.organization_id,
        store_id=shift.store_id,
        entity="shift_close_count",
        entity_id=count.id,
        action=REVIEW_OPENED_ACTION,
        before=None,
        after=None,
    )


def recounted_count_ids(db: Session, shift_id: int) -> set[int]:
    """Los conteos de cierre de un turno que se hicieron después de ver el
    esperado de un conteo anterior."""
    ids = list(db.execute(select(ShiftCloseCount.id).where(ShiftCloseCount.shift_id == shift_id)).scalars())
    return _audit_actions_of_counts(db, ids, RECOUNT_AFTER_REVIEW_ACTION)


def close_precheck(db: Session, *, shift: Shift, store: Store) -> dict[str, Any]:
    """«Paso 0» del cierre: lo que el cierre va a exigir, ANTES de contar.

    Lee las mismas reglas que después aplican `create_close_count` y
    `confirm_close` (comandas abiertas, total del datáfono y de
    transferencias, foto) más el efectivo de domicilios sin liquidar, y
    **no publica ningún monto**: ni el esperado, ni sus sumandos, ni la
    venta por medio. Sólo conteos y sí/no. Si ya hay un conteo sellado y
    activo, lo dice, para que la pantalla retome en el paso 2 en vez de
    volver a contar."""
    _require_open(shift)
    sales = hooks.get_sales_totals(db, shift.id)
    open_orders = _count_open_orders(db, shift.id)
    photo_required = False
    if features.is_enabled(db, store.organization_id, store.id, "cash.photo_required"):
        photo_required = bool(stores_service.get_cash_settings(db, store.id).photo_required_on_close)
    card_required = sales.card + sales.tips_card > 0
    transfer_required = sales.transfer + sales.tips_transfer > 0
    reserve_loan_open = reserve.loan_outstanding(db, shift.id) > 0

    items: list[dict[str, Any]] = []
    if reserve_loan_open:
        # Sin monto, como todo el paso 0: sólo que hay un préstamo abierto.
        items.append(
            {
                "code": "RESERVE_LOAN_OPEN",
                "level": "blocking",
                "message": (
                    "Hay plata tomada de la base de respaldo sin devolver: devolvela en Turno › Devolver a la base "
                    "antes de contar el cierre"
                ),
            }
        )
    if open_orders:
        items.append(
            {
                "code": "OPEN_ORDERS",
                "level": "blocking",
                "message": (
                    f"Hay {open_orders} comanda{'s' if open_orders != 1 else ''} abierta{'s' if open_orders != 1 else ''}: "
                    "cobralas o anulalas desde Mesas o Mostrador, o trasladalas al turno siguiente al confirmar el cierre"
                ),
            }
        )
    if sales.delivery_pending_payments:
        n = sales.delivery_pending_payments
        couriers = sales.delivery_pending_couriers
        items.append(
            {
                "code": "DELIVERY_UNSETTLED",
                "level": "warning",
                "message": (
                    f"{n} cobro{'s' if n != 1 else ''} de domicilio sin liquidar "
                    f"({couriers} domiciliario{'s' if couriers != 1 else ''}): recibí esa plata en Turno › Domicilios "
                    "antes de contar, o queda fuera del cajón"
                ),
            }
        )
    if card_required:
        items.append(
            {
                "code": "CARD_TOTAL_REQUIRED",
                "level": "info",
                "message": "Hubo ventas con tarjeta: tené a mano el cierre del datáfono para escribir su total",
            }
        )
    if transfer_required:
        items.append(
            {
                "code": "TRANSFER_TOTAL_REQUIRED",
                "level": "info",
                "message": "Hubo ventas por transferencia: revisá el total recibido para escribirlo",
            }
        )
    if photo_required:
        items.append(
            {"code": "PHOTO_REQUIRED", "level": "info", "message": "Esta sede pide una foto del conteo de cierre"}
        )

    active = _get_active_close_count(db, shift.id)
    sealed = (
        {
            "count_id": active.id,
            "counted_at": active.created_at,
            "counted_by": active.created_by_employee_name,
        }
        if active is not None
        else None
    )
    return {
        "shift_id": shift.id,
        "open_orders": open_orders,
        "delivery_pending_payments": sales.delivery_pending_payments,
        "delivery_pending_couriers": sales.delivery_pending_couriers,
        "card_total_required": card_required,
        "transfer_total_required": transfer_required,
        "photo_required": photo_required,
        "reserve_loan_open": reserve_loan_open,
        "sealed_count": sealed,
        "items": items,
    }


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
    _reject_open_reserve_loan(db, shift)
    if count.superseded:
        raise AppError(
            "CLOSE_COUNT_SUPERSEDED",
            "Ese conteo ya se reemplazó por uno nuevo: volvé a abrir el cierre en la pantalla Turno",
            status=409,
        )
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
    _reject_open_reserve_loan(db, shift)
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
    shift.to_deposit = (
        breakdown["expected"]
        - shift.opening_fixed_base
        - carried_still_in_drawer(db, shift)
        - breakdown["reserve_loan"]
    )

    db.flush()
    # Un turno abandonado se rescata a veces días después: la jornada de quien
    # quedó adentro no puede estirarse hasta el rescate. Termina, como tarde,
    # cuando terminó su día operativo — ya es un tope generoso, y queda en la
    # auditoría para que el dueño la ajuste si sabe la hora real.
    fin_del_dia = end_of_business_day(db, shift, store)
    _end_open_roster(db, actor=actor, shift=shift, at=min(now, fin_del_dia) if fin_del_dia else now)
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

    # Quien quedó adentro cuando se cerró (el cierre le terminó la jornada,
    # `_end_open_roster`) vuelve a quedar adentro: el turno sigue siendo el
    # mismo. Se reconocen por la auditoría `out_on_close` de este cierre.
    _reopen_roster_closed_by_close(db, actor=actor, shift=shift)

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
    for model in (CashMovement, CashSwap, CashPickup, ShiftHandover, ShiftCloseCount, CashReserveMovement):
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
        active_count = _get_active_close_count(db, shift.id)
        tips_cash_out = active_count.tips_cash_out if active_count is not None else 0
        shift.to_deposit = (
            shift.counted_cash
            - shift.opening_fixed_base
            - tips_cash_out
            - carried_still_in_drawer(db, shift)
            - breakdown["reserve_loan"]
        )

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


def cash_summary(db: Session, *, store: Store, date_from: date | None, date_to: date | None) -> dict[str, Any]:
    """Resumen de caja del historial de turnos (Dinero › Historial, informe
    de visualización #10): ¿la caja cuadra?, en total, por día y por
    responsable. Sólo entran a las sumas los cierres CONTADOS (`difference`
    no nulo y no administrativos): un cierre sin conteo no cuadró ni dejó de
    cuadrar, así que se cuenta aparte (`uncounted_count`) y nunca como $0.

    `diff_total` es con signo (negativo = faltante). `beyond_tolerance_count`
    usa la misma tolerancia con la que el cierre exige una causa
    identificada."""
    settings = stores_service.get_cash_settings(db, store.id)
    tolerance = settings.tolerance_unknown_cause
    stmt = (
        select(Shift, BusinessDay.business_date)
        .join(BusinessDay, Shift.business_day_id == BusinessDay.id)
        .where(Shift.store_id == store.id, Shift.status == ShiftStatus.CLOSED)
    )
    if date_from is not None:
        stmt = stmt.where(BusinessDay.business_date >= date_from)
    if date_to is not None:
        stmt = stmt.where(BusinessDay.business_date <= date_to)
    rows = db.execute(stmt.order_by(BusinessDay.business_date, Shift.closed_at, Shift.id)).all()

    diff_total = shortage = overage = beyond = uncounted = 0
    shortage_total = overage_total = 0
    people: dict[int, dict[str, Any]] = {}
    days: dict[date, dict[str, Any]] = {}
    for shift, business_date in rows:
        if shift.closed_without_count or shift.difference is None:
            uncounted += 1
            continue
        d = shift.difference
        diff_total += d
        if d < 0:
            shortage += 1
            shortage_total += d
        elif d > 0:
            overage += 1
            overage_total += d
        if abs(d) > tolerance:
            beyond += 1
        person = people.setdefault(
            shift.cash_responsible_id,
            {
                "employee_id": shift.cash_responsible_id,
                "name": shift.cash_responsible_name,
                "closes": 0,
                "diff_total": 0,
                "shortage_count": 0,
                "overage_count": 0,
            },
        )
        person["name"] = shift.cash_responsible_name
        person["closes"] += 1
        person["diff_total"] += d
        person["shortage_count"] += 1 if d < 0 else 0
        person["overage_count"] += 1 if d > 0 else 0
        day = days.setdefault(business_date, {"business_date": business_date, "closes": 0, "diff_total": 0})
        day["closes"] += 1
        day["diff_total"] += d

    by_person = list(people.values())
    for person in by_person:
        person["current_streak"] = current_difference_streak(db, store_id=store.id, employee_id=person["employee_id"])
    # El faltante más grande primero: es lo que el dueño viene a buscar.
    by_person.sort(key=lambda p: (p["diff_total"], -p["shortage_count"], p["name"]))
    counted = len(rows) - uncounted
    return {
        "closed_count": len(rows),
        "counted_count": counted,
        "uncounted_count": uncounted,
        "diff_total": diff_total,
        "shortage_total": shortage_total,
        "overage_total": overage_total,
        "shortage_count": shortage,
        "overage_count": overage,
        "exact_count": counted - shortage - overage,
        "tolerance": tolerance,
        "beyond_tolerance_count": beyond,
        "by_person": by_person,
        "by_day": [days[k] for k in sorted(days)],
    }


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
    # Pedido 2c: el efectivo que entrega el domiciliario al liquidar (y, con
    # `kind=expense`, la salida al deshacer esa liquidación). `kind` ya
    # distingue ingreso de egreso: la etiqueta no repite "Ingreso"/"Egreso"
    # (misma lección que dejó `supplier_payment` en el recorrido de 2b).
    "delivery_settlement": "Liquidación de domicilios",
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
                "summary": f"{_movement_kind_label(m.kind)} ({_movement_cause_label(m.cause)}) por {format_cop(m.amount)}",
                "employee_name": m.employee_name,
                "data": {"id": m.id, "kind": m.kind, "cause": m.cause, "amount": m.amount},
            }
        )

    for s in db.execute(select(CashSwap).where(CashSwap.shift_id == shift.id)).scalars():
        events.append({"at": s.at, "kind": "swap", "summary": f"Cambio de denominaciones por {format_cop(s.amount)}", "employee_name": s.employee_name, "data": {"id": s.id, "amount": s.amount}})

    for p in db.execute(select(CashPickup).where(CashPickup.shift_id == shift.id)).scalars():
        events.append(
            {"at": p.at, "kind": "pickup", "summary": f"Retiro de {format_cop(p.amount)}", "employee_name": p.employee_name, "data": {"id": p.id, "amount": p.amount}}
        )
        if p.reversed_at is not None:
            events.append(
                {"at": p.reversed_at, "kind": "pickup_reverse", "summary": f"Reversa del retiro #{p.id}: {p.reversed_reason}", "employee_name": p.reversed_by_employee_name, "data": {"id": p.id}}
            )

    for h in db.execute(select(ShiftHandover).where(ShiftHandover.shift_id == shift.id)).scalars():
        label = "Relevo" if h.kind == "handover" else "Arqueo sorpresa"
        events.append(
            {"at": h.at, "kind": h.kind, "summary": f"{label} por {h.from_responsible_name} (diferencia {_cop_or_dash(h.breakdown.get('difference'))})", "employee_name": h.from_responsible_name, "data": {"id": h.id}}
        )

    for rm in reserve.list_movements(db, shift_id=shift.id):
        kind = rm.kind.value if hasattr(rm.kind, "value") else rm.kind
        verb = "Se tomó de" if kind == "take" else "Se devolvió a"
        events.append(
            {
                "at": rm.at,
                "kind": f"reserve_{kind}",
                "summary": f"{verb} la base de respaldo {format_cop(rm.amount)}",
                "employee_name": rm.employee_name,
                "data": {"id": rm.id, "amount": rm.amount, "authorized_by": rm.authorized_by_employee_name},
            }
        )
        if rm.reversed_at is not None:
            events.append(
                {
                    "at": rm.reversed_at,
                    "kind": "reserve_reverse",
                    "summary": f"Reversa del movimiento de la base #{rm.id}: {rm.reversed_reason}",
                    "employee_name": rm.reversed_by_employee_name,
                    "data": {"id": rm.id},
                }
            )

    opening_count = opening_count_of_shift(db, shift.id)
    if opening_count is not None:
        view = opening_count_view(opening_count)
        events.append(
            {
                "at": opening_count.created_at,
                "kind": "opening_count",
                "summary": (
                    f"Cuadre de apertura por sobres de {opening_count.counted_by_employee_name}: "
                    f"{len(view['envelopes'])} sobre(s), diferencia {format_cop(view['difference_total'])}"
                ),
                "employee_name": opening_count.counted_by_employee_name,
                "data": {"id": opening_count.id, "envelopes": view["envelopes"]},
            }
        )

    recounted = recounted_count_ids(db, shift.id)
    for c in db.execute(select(ShiftCloseCount).where(ShiftCloseCount.shift_id == shift.id)).scalars():
        flagged = c.id in recounted
        summary = f"Conteo de cierre por {c.created_by_employee_name}"
        if flagged:
            summary += " · recontado después de ver el esperado"
        events.append(
            {"at": c.created_at, "kind": "close_count", "summary": summary, "employee_name": c.created_by_employee_name, "data": {"id": c.id, "counted_cash_total": c.counted_cash_total, "superseded": c.superseded, "recounted_after_review": flagged}}
        )

    if shift.closed_at is not None:
        label = "Cierre administrativo" if shift.closed_without_count else "Cierre"
        events.append(
            {"at": shift.closed_at, "kind": "close", "summary": f"{label}: diferencia {_cop_or_dash(shift.difference)}", "employee_name": shift.closed_by_employee_name, "data": {"difference": shift.difference, "to_deposit": shift.to_deposit}}
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

    "Racha" acá es la cantidad de cierres consecutivos más recientes en los
    que esta persona fue responsable de caja y la diferencia se pasó de la
    tolerancia de la sede (`difference_streak_from`, la misma regla del
    aviso; sin sede en la consulta, tolerancia 0).
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
    tolerance = stores_service.get_cash_settings(db, store_id).tolerance_unknown_cause if store_id is not None else 0
    streak = difference_streak_from(
        [None if s.closed_without_count else s.difference for s in closed_as_responsible], tolerance
    )

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
