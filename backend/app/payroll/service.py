"""Reglas de negocio de `payroll` — jornada, recargos con vigencia,
liquidación de nómina y la PROPUESTA del reparto de propinas (SPEC-NEGOCIO
§6.2 y §7; `features/fase-3-dinero-control/spec.md § 2`, T3).

**LA LLAVE ANTI DOBLE CONTEO DE ESTE TERRITORIO** (diseñada acá, antes de la
primera ruta, como pide §6.1/§3 de la spec del pedido): **propina vs
venta**. El monto a repartir de un turno **siempre** sale de
`app.shifts.tips.get_shift_tips(db, shift=shift)` — la única función que ya
separa la propina de la venta y del impuesto (Ley 1935 de 2018) y que ya
resuelve H-2/H-8 (propina de mostrador vs propina de domicilio, liquidada o
no). Este dominio **nunca** vuelve a sumar `Payment.tip_amount` ni
`Payment.amount` por su cuenta: hacerlo sería, letra por letra, la "segunda
matemática" que `docs/CONTEXTO-AGENTES.md §8` prohíbe, y el mismo billete
podría aparecer una vez como propina a repartir y otra vez como venta del
turno. `compute_tip_proposal` (más abajo) es el único punto de esta regla;
cualquier función nueva que necesite "cuánta propina generó este turno"
llama a esa, nunca relee `Payment`.

**Lo que este dominio LEE y nunca reescribe** (`app.shifts.models`):
`Shift` (para validar que un `shift_id` pedido existe en esta sede) y
`ShiftRoster` (`in_at`/`out_at`/`pauses` — la jornada ya capturada, nunca
vuelta a pedir). `app.shifts.tips.register_tip_payout` — la única puerta de
ESCRITURA del reparto — no se llama desde acá: el "confirmar" es
`POST /admin/tips/payouts`, publicado por `app.shifts`, y el frontend lo
llama directo con las filas que esta propuesta calculó. Este servicio no
importa `register_tip_payout` porque no lo necesita — no escribe nada.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.auth.deps import Actor
from app.core import clock, tz
from app.core import hours as hours_mod
from app.core.errors import AppError, ConflictError, NotFoundError
from app.orders.money import prorate
from app.payroll.models import (
    PayrollAreaAssignment,
    PayrollHoliday,
    PayrollRun,
    PayrollRunLine,
    PayrollWageRate,
    SurchargeTable,
    TipDistributionMethod,
    TipDistributionSettings,
)
from app.shifts.models import BusinessDay, Shift, ShiftRoster, ShiftStatus
from app.shifts.tips import get_shift_tips
from app.stores.models import Store

BP_DENOMINATOR = 10_000


def _validate_range(date_from: date, date_to: date) -> None:
    if date_from > date_to:
        raise AppError("VALIDATION_ERROR", "from: tiene que ser anterior o igual a to", status=400)


def _actor_identity(actor: Actor) -> tuple[int | None, str | None]:
    return actor.employee_id, actor.employee_name


# ---------------------------------------------------------------------------
# Tablas de recargos con vigencia (§7). Rige la de mayor `valid_from` <= la
# fecha CONSULTADA (mismo patrón que `app.stores.models.StoreFiscalConfig`).
# ---------------------------------------------------------------------------


def list_surcharge_tables(db: Session, *, store_id: int) -> list[SurchargeTable]:
    stmt = (
        select(SurchargeTable)
        .where(SurchargeTable.store_id == store_id)
        .order_by(SurchargeTable.valid_from.asc())
    )
    return list(db.execute(stmt).scalars())


def _table_for(tables_sorted: list[SurchargeTable], on_date: date) -> SurchargeTable | None:
    """`tables_sorted` ascendente por `valid_from`. La vigente es la ÚLTIMA
    cuyo `valid_from` sea `<= on_date`."""
    current: SurchargeTable | None = None
    for t in tables_sorted:
        if t.valid_from <= on_date:
            current = t
        else:
            break
    return current


def create_surcharge_table(
    db: Session, *, actor: Actor, store: Store, payload: Any
) -> SurchargeTable:
    if payload.night_start_hour == payload.night_end_hour:
        raise AppError(
            "VALIDATION_ERROR",
            "night_start_hour y night_end_hour no pueden ser iguales: la ventana nocturna quedaría vacía",
        )
    existing = db.execute(
        select(SurchargeTable).where(
            SurchargeTable.store_id == store.id, SurchargeTable.valid_from == payload.valid_from
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise ConflictError(
            f"Ya existe una tabla de recargos vigente desde {payload.valid_from} en esta sede",
            code="SURCHARGE_TABLE_DUPLICATE",
        )
    employee_id, employee_name = _actor_identity(actor)
    row = SurchargeTable(
        organization_id=store.organization_id,
        store_id=store.id,
        valid_from=payload.valid_from,
        night_start_hour=payload.night_start_hour,
        night_end_hour=payload.night_end_hour,
        night_surcharge_bp=payload.night_surcharge_bp,
        sunday_holiday_surcharge_bp=payload.sunday_holiday_surcharge_bp,
        overtime_surcharge_bp=payload.overtime_surcharge_bp,
        weekly_ordinary_hours=payload.weekly_ordinary_hours,
        created_at=clock.now_utc(),
        created_by_employee_id=employee_id,
        created_by_employee_name=employee_name,
    )
    db.add(row)
    try:
        db.flush()
    except IntegrityError as exc:
        raise ConflictError(
            f"Ya existe una tabla de recargos vigente desde {payload.valid_from} en esta sede",
            code="SURCHARGE_TABLE_DUPLICATE",
        ) from exc
    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="payroll_surcharge_table",
        entity_id=row.id,
        action="create",
        before=None,
        after={"valid_from": str(row.valid_from)},
    )
    return row


# ---------------------------------------------------------------------------
# Festivos (agregado, fuera del contrato mínimo — ver el entregable § 3).
# ---------------------------------------------------------------------------


def list_holidays(db: Session, *, store_id: int) -> list[PayrollHoliday]:
    stmt = select(PayrollHoliday).where(PayrollHoliday.store_id == store_id).order_by(PayrollHoliday.holiday_date.asc())
    return list(db.execute(stmt).scalars())


def _holiday_dates(db: Session, *, store_id: int) -> set[date]:
    return {row.holiday_date for row in list_holidays(db, store_id=store_id)}


def create_holiday(db: Session, *, actor: Actor, store: Store, payload: Any) -> PayrollHoliday:
    existing = db.execute(
        select(PayrollHoliday).where(
            PayrollHoliday.store_id == store.id, PayrollHoliday.holiday_date == payload.holiday_date
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise ConflictError(f"{payload.holiday_date} ya está declarado como festivo", code="HOLIDAY_DUPLICATE")
    row = PayrollHoliday(
        organization_id=store.organization_id,
        store_id=store.id,
        holiday_date=payload.holiday_date,
        name=payload.name,
        created_at=clock.now_utc(),
    )
    db.add(row)
    try:
        db.flush()
    except IntegrityError as exc:
        raise ConflictError(f"{payload.holiday_date} ya está declarado como festivo", code="HOLIDAY_DUPLICATE") from exc
    return row


# ---------------------------------------------------------------------------
# Tarifa por hora, CON vigencia (agregado, fuera del contrato mínimo).
# ---------------------------------------------------------------------------


def list_wage_rates(db: Session, *, store_id: int, employee_id: int | None = None) -> list[PayrollWageRate]:
    stmt = select(PayrollWageRate).where(PayrollWageRate.store_id == store_id)
    if employee_id is not None:
        stmt = stmt.where(PayrollWageRate.employee_id == employee_id)
    stmt = stmt.order_by(PayrollWageRate.employee_id.asc(), PayrollWageRate.valid_from.asc())
    return list(db.execute(stmt).scalars())


def _wage_for(rates_sorted: list[PayrollWageRate], on_date: date) -> PayrollWageRate | None:
    current: PayrollWageRate | None = None
    for r in rates_sorted:
        if r.valid_from <= on_date:
            current = r
        else:
            break
    return current


def create_wage_rate(db: Session, *, actor: Actor, store: Store, payload: Any) -> PayrollWageRate:
    from app.auth.models import Employee

    employee = db.get(Employee, payload.employee_id)
    if employee is None or employee.organization_id != store.organization_id:
        raise NotFoundError(f"El empleado {payload.employee_id} no existe en esta organización")
    existing = db.execute(
        select(PayrollWageRate).where(
            PayrollWageRate.store_id == store.id,
            PayrollWageRate.employee_id == payload.employee_id,
            PayrollWageRate.valid_from == payload.valid_from,
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise ConflictError(
            f"Ya existe una tarifa vigente desde {payload.valid_from} para este empleado",
            code="WAGE_RATE_DUPLICATE",
        )
    creator_id, creator_name = _actor_identity(actor)
    row = PayrollWageRate(
        organization_id=store.organization_id,
        store_id=store.id,
        employee_id=employee.id,
        employee_name=employee.name,
        hourly_wage_pesos=payload.hourly_wage_pesos,
        valid_from=payload.valid_from,
        created_at=clock.now_utc(),
        created_by_employee_id=creator_id,
        created_by_employee_name=creator_name,
    )
    db.add(row)
    try:
        db.flush()
    except IntegrityError as exc:
        raise ConflictError(
            f"Ya existe una tarifa vigente desde {payload.valid_from} para este empleado",
            code="WAGE_RATE_DUPLICATE",
        ) from exc
    return row


# ---------------------------------------------------------------------------
# Área (agregado, fuera del contrato mínimo) — para el reparto `by_area`.
# ---------------------------------------------------------------------------


def list_area_assignments(db: Session, *, store_id: int) -> list[PayrollAreaAssignment]:
    stmt = select(PayrollAreaAssignment).where(PayrollAreaAssignment.store_id == store_id)
    return list(db.execute(stmt).scalars())


def set_employee_area(db: Session, *, actor: Actor, store: Store, payload: Any) -> PayrollAreaAssignment:
    from app.auth.models import Employee

    employee = db.get(Employee, payload.employee_id)
    if employee is None or employee.organization_id != store.organization_id:
        raise NotFoundError(f"El empleado {payload.employee_id} no existe en esta organización")
    row = db.execute(
        select(PayrollAreaAssignment).where(
            PayrollAreaAssignment.store_id == store.id, PayrollAreaAssignment.employee_id == employee.id
        )
    ).scalar_one_or_none()
    before = {"area": row.area} if row is not None else None
    updater_id, _ = _actor_identity(actor)
    if row is None:
        row = PayrollAreaAssignment(
            organization_id=store.organization_id,
            store_id=store.id,
            employee_id=employee.id,
            employee_name=employee.name,
            area=payload.area,
            updated_at=clock.now_utc(),
            updated_by_employee_id=updater_id,
        )
        db.add(row)
    else:
        row.area = payload.area
        row.updated_at = clock.now_utc()
        row.updated_by_employee_id = updater_id
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="payroll_area_assignment",
        entity_id=row.id,
        action="set",
        before=before,
        after={"area": row.area},
    )
    return row


# ---------------------------------------------------------------------------
# Configuración del reparto de propinas — D-3.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TipSettingsResult:
    store_id: int
    method: TipDistributionMethod
    updated_at: datetime | None


def get_tip_settings(db: Session, *, store_id: int) -> TipSettingsResult:
    row = db.get(TipDistributionSettings, store_id)
    if row is None:
        # Nunca configurada todavía: el default de D-3 es `by_hours`, sin
        # necesitar una fila creada de antemano (evita que sembrar una fila
        # por sede sea responsabilidad de una migración de otro dominio).
        return TipSettingsResult(store_id=store_id, method=TipDistributionMethod.BY_HOURS, updated_at=None)
    return TipSettingsResult(store_id=store_id, method=row.method, updated_at=row.updated_at)


def update_tip_settings(db: Session, *, actor: Actor, store: Store, method: str) -> TipSettingsResult:
    parsed_method = TipDistributionMethod(method)
    row = db.get(TipDistributionSettings, store.id)
    before = {"method": row.method.value} if row is not None else {"method": TipDistributionMethod.BY_HOURS.value}
    updater_id, _ = _actor_identity(actor)
    if row is None:
        row = TipDistributionSettings(
            store_id=store.id, method=parsed_method, updated_at=clock.now_utc(), updated_by_employee_id=updater_id
        )
        db.add(row)
    else:
        row.method = parsed_method
        row.updated_at = clock.now_utc()
        row.updated_by_employee_id = updater_id
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="payroll_tip_settings",
        entity_id=store.id,
        action="update",
        before=before,
        after={"method": row.method.value},
    )
    return TipSettingsResult(store_id=store.id, method=row.method, updated_at=row.updated_at)


# ---------------------------------------------------------------------------
# El motor de jornada: parte el roster (`in_at`/`out_at`/`pauses`) en piezas
# que no cruzan ni la hora de corte de la sede (día de negocio) ni la
# medianoche (día calendario, que es el que manda para domingo/festivo/
# ventana nocturna) ni el borde de la ventana nocturna vigente en cada
# fecha. Cada pieza queda así clasificable sin ambigüedad.
# ---------------------------------------------------------------------------


@dataclass
class _Piece:
    employee_id: int
    employee_name: str
    start: datetime
    minutes: int
    business_date: date
    calendar_date: date
    is_night: bool
    is_sunday: bool
    is_holiday: bool
    table: SurchargeTable | None
    ordinary_minutes: int = field(default=0)
    overtime_minutes: int = field(default=0)


def _subtract_interval(
    intervals: list[tuple[datetime, datetime]], sub_start: datetime, sub_end: datetime
) -> list[tuple[datetime, datetime]]:
    result: list[tuple[datetime, datetime]] = []
    for s, e in intervals:
        if sub_end <= s or sub_start >= e:
            result.append((s, e))
            continue
        if sub_start > s:
            result.append((s, sub_start))
        if sub_end < e:
            result.append((sub_end, e))
    return result


def _worked_intervals(roster: ShiftRoster, *, until: datetime) -> list[tuple[datetime, datetime]]:
    """Intervalos trabajados de una entrada de roster, restando las pausas
    (`ShiftRoster.pauses`, forma `[{"start": iso, "end": iso|None}]`). Una
    pausa sin cerrar, o una entrada sin `out_at` (todavía en curso), se
    corta en `until` (normalmente `clock.now_utc()`)."""
    end = roster.out_at or until
    if end <= roster.in_at:
        return []
    intervals: list[tuple[datetime, datetime]] = [(roster.in_at, end)]
    for pause in roster.pauses or []:
        start_raw = pause.get("start")
        if not start_raw:
            continue
        pause_start = datetime.fromisoformat(start_raw)
        end_raw = pause.get("end")
        pause_end = datetime.fromisoformat(end_raw) if end_raw else end
        intervals = _subtract_interval(intervals, pause_start, pause_end)
    return intervals


def _next_wall_clock_boundary(instant: datetime, hour_marks: set[int]) -> datetime:
    """El próximo instante (estrictamente posterior a `instant`) en el que
    el reloj de pared de Bogotá marca alguna de las horas de `hour_marks`
    (cada una, 0-23)."""
    local = tz.to_bogota(instant)
    best: datetime | None = None
    for h in hour_marks:
        candidate = local.replace(hour=h, minute=0, second=0, microsecond=0)
        if candidate <= local:
            candidate = candidate + timedelta(days=1)
        if best is None or candidate < best:
            best = candidate
    assert best is not None
    return best.astimezone(timezone.utc)


def _split_by_hour_boundaries(
    start: datetime, end: datetime, hour_marks: set[int]
) -> list[tuple[datetime, datetime]]:
    """Parte `[start, end)` en piezas que no cruzan ninguna hora de
    `hour_marks` (hora local de Bogotá, recurrente cada día). Con
    `hour_marks = {0, cutoff_hour}` esto es exactamente "los turnos que
    cruzan medianoche se parten en dos días de negocio" del pedido —
    generalizado para partir también por el borde de la ventana nocturna."""
    pieces: list[tuple[datetime, datetime]] = []
    cur = start
    while cur < end:
        nxt = min(end, _next_wall_clock_boundary(cur, hour_marks))
        pieces.append((cur, nxt))
        cur = nxt
    return pieces


def _in_night_window(local_hour: int, night_start: int, night_end: int) -> bool:
    if night_start < night_end:
        return night_start <= local_hour < night_end
    if night_start > night_end:
        # Cruza medianoche (el caso real: 19 -> 6).
        return local_hour >= night_start or local_hour < night_end
    return False  # ventana vacía, ya rechazada en create_surcharge_table


def _query_roster(
    db: Session, *, store_id: int, date_from: date, date_to: date, employee_id: int | None
) -> list[ShiftRoster]:
    # Ventana generosa en UTC (Bogotá es UTC-5, y hay que cubrir la hora de
    # corte además de la medianoche): un roster que arranca o termina cerca
    # del borde del período no se pierde por un filtro demasiado ajustado.
    lower = datetime.combine(date_from, datetime.min.time(), tzinfo=timezone.utc) - timedelta(days=2)
    upper = datetime.combine(date_to, datetime.min.time(), tzinfo=timezone.utc) + timedelta(days=3)
    stmt = select(ShiftRoster).where(
        ShiftRoster.store_id == store_id,
        ShiftRoster.in_at < upper,
        (ShiftRoster.out_at.is_(None)) | (ShiftRoster.out_at > lower),
    )
    if employee_id is not None:
        stmt = stmt.where(ShiftRoster.employee_id == employee_id)
    return list(db.execute(stmt).scalars())


def _employee_pieces(
    db: Session,
    *,
    store: Store,
    date_from: date,
    date_to: date,
    employee_id: int | None,
    until: datetime,
) -> tuple[dict[int, list[_Piece]], list[SurchargeTable]]:
    """Devuelve, por `employee_id`, la lista de piezas de jornada dentro del
    período `[date_from, date_to]` (fecha de NEGOCIO — la hora de corte de
    la sede, `app.core.tz`), más las tablas de recargos que resultaron
    vigentes en algún día del período (para `tables_used`)."""
    tables_sorted = list_surcharge_tables(db, store_id=store.id)
    holidays = _holiday_dates(db, store_id=store.id)
    roster_rows = _query_roster(db, store_id=store.id, date_from=date_from, date_to=date_to, employee_id=employee_id)

    by_employee: dict[int, list[_Piece]] = {}
    used_tables: dict[int, SurchargeTable] = {}

    for row in roster_rows:
        for w_start, w_end in _worked_intervals(row, until=until):
            hour_marks = {0, store.cutoff_hour}
            cursor_date = tz.to_bogota(w_start).date()
            end_date = tz.to_bogota(w_end).date()
            while cursor_date <= end_date:
                table = _table_for(tables_sorted, cursor_date)
                if table is not None:
                    hour_marks.add(table.night_start_hour)
                    hour_marks.add(table.night_end_hour)
                cursor_date += timedelta(days=1)

            for p_start, p_end in _split_by_hour_boundaries(w_start, w_end, hour_marks):
                minutes = hours_mod.minutes_between(p_start, p_end)
                if minutes <= 0:
                    continue
                business_date = tz.business_date_for(p_start, store.cutoff_hour)
                if business_date < date_from or business_date > date_to:
                    continue
                calendar_date = tz.to_bogota(p_start).date()
                table = _table_for(tables_sorted, calendar_date)
                if table is not None:
                    used_tables[table.id] = table
                    local_hour = tz.to_bogota(p_start).hour
                    is_night = _in_night_window(local_hour, table.night_start_hour, table.night_end_hour)
                else:
                    is_night = False
                is_holiday = calendar_date in holidays
                is_sunday = (not is_holiday) and calendar_date.weekday() == 6
                piece = _Piece(
                    employee_id=row.employee_id,
                    employee_name=row.employee_name,
                    start=p_start,
                    minutes=minutes,
                    business_date=business_date,
                    calendar_date=calendar_date,
                    is_night=is_night,
                    is_sunday=is_sunday,
                    is_holiday=is_holiday,
                    table=table,
                )
                by_employee.setdefault(row.employee_id, []).append(piece)

    for pieces in by_employee.values():
        _split_ordinary_overtime(pieces)

    tables_used = sorted(used_tables.values(), key=lambda t: t.valid_from)
    return by_employee, tables_used


def _split_ordinary_overtime(pieces: list[_Piece]) -> None:
    """Ordinarias vs extras: jornada ordinaria semanal vigente en la fecha
    de cada pieza (`SurchargeTable.weekly_ordinary_hours`), por semana ISO
    (lunes a domingo), cronológico. **Simplificación declarada en el
    entregable**: el umbral se mide sólo con las horas de la pieza que caen
    DENTRO del período consultado, no con la semana completa si el período
    empieza o termina a mitad de una semana ISO."""
    ordered = sorted(pieces, key=lambda p: p.start)
    week_totals: dict[tuple[int, int], int] = {}
    for piece in ordered:
        iso_year, iso_week, _ = piece.calendar_date.isocalendar()
        key = (iso_year, iso_week)
        used = week_totals.get(key, 0)
        threshold_minutes = (piece.table.weekly_ordinary_hours * 60) if piece.table is not None else 10**9
        remaining = max(threshold_minutes - used, 0)
        if piece.minutes <= remaining:
            piece.ordinary_minutes = piece.minutes
            piece.overtime_minutes = 0
        else:
            piece.ordinary_minutes = remaining
            piece.overtime_minutes = piece.minutes - remaining
        week_totals[key] = used + piece.minutes


@dataclass(frozen=True)
class EmployeeHours:
    employee_id: int
    employee_name: str
    ordinary_minutes: int
    night_minutes: int
    sunday_minutes: int
    holiday_minutes: int
    overtime_minutes: int


@dataclass(frozen=True)
class HoursResult:
    rows: list[EmployeeHours]
    available: bool
    reason: str | None


def get_hours(
    db: Session, *, store: Store, date_from: date, date_to: date, employee_id: int | None = None
) -> HoursResult:
    _validate_range(date_from, date_to)
    tables_sorted = list_surcharge_tables(db, store_id=store.id)
    if not tables_sorted:
        return HoursResult(
            rows=[],
            available=False,
            reason=(
                "No hay ninguna tabla de recargos configurada en esta sede; "
                "cargá una en POST /admin/payroll/surcharge-tables antes de consultar la jornada."
            ),
        )
    by_employee, _ = _employee_pieces(
        db, store=store, date_from=date_from, date_to=date_to, employee_id=employee_id, until=clock.now_utc()
    )
    rows: list[EmployeeHours] = []
    for emp_id, pieces in sorted(by_employee.items(), key=lambda kv: kv[1][0].employee_name):
        rows.append(
            EmployeeHours(
                employee_id=emp_id,
                employee_name=pieces[0].employee_name,
                ordinary_minutes=sum(p.ordinary_minutes for p in pieces),
                night_minutes=sum(p.minutes for p in pieces if p.is_night),
                sunday_minutes=sum(p.minutes for p in pieces if p.is_sunday),
                holiday_minutes=sum(p.minutes for p in pieces if p.is_holiday),
                overtime_minutes=sum(p.overtime_minutes for p in pieces),
            )
        )
    return HoursResult(rows=rows, available=True, reason=None)


# ---------------------------------------------------------------------------
# Liquidación de nómina del período.
# ---------------------------------------------------------------------------


def _round_half_up(numerator: int, denominator: int) -> int:
    if numerator >= 0:
        return (numerator + denominator // 2) // denominator
    return -((-numerator + denominator // 2) // denominator)


def _table_snapshot(table: SurchargeTable) -> dict[str, Any]:
    return {
        "valid_from": table.valid_from.isoformat(),
        "night_start_hour": table.night_start_hour,
        "night_end_hour": table.night_end_hour,
        "night_surcharge_bp": table.night_surcharge_bp,
        "sunday_holiday_surcharge_bp": table.sunday_holiday_surcharge_bp,
        "overtime_surcharge_bp": table.overtime_surcharge_bp,
        "weekly_ordinary_hours": table.weekly_ordinary_hours,
    }


@dataclass(frozen=True)
class _EmployeePay:
    ordinary_minutes: int
    night_minutes: int
    sunday_minutes: int
    holiday_minutes: int
    overtime_minutes: int
    base_pay: int | None
    night_surcharge: int | None
    sunday_holiday_surcharge: int | None
    overtime_pay: int | None
    total: int | None
    pay_reason: str | None


def _compute_employee_pay(pieces: list[_Piece], rates_sorted: list[PayrollWageRate]) -> _EmployeePay:
    """La liquidación de UNA persona a partir de sus piezas de jornada —
    llamada tanto por `create_run` (que persiste el resultado en
    `PayrollRunLine`) como por `app.payroll.hooks.period_payroll_cost` (que
    sólo necesita el total): la misma función, nunca dos matemáticas para la
    misma pregunta."""
    ordinary_minutes = sum(p.ordinary_minutes for p in pieces)
    night_minutes = sum(p.minutes for p in pieces if p.is_night)
    sunday_minutes = sum(p.minutes for p in pieces if p.is_sunday)
    holiday_minutes = sum(p.minutes for p in pieces if p.is_holiday)
    overtime_minutes = sum(p.overtime_minutes for p in pieces)

    base_raw = 0
    overtime_raw = 0
    night_raw = 0
    sunday_holiday_raw = 0
    wage_missing = False
    for piece in pieces:
        wage = _wage_for(rates_sorted, piece.calendar_date)
        if wage is None:
            wage_missing = True
            continue
        hourly = wage.hourly_wage_pesos
        base_raw += hours_mod.wage_minutes(piece.minutes, hourly)
        if piece.table is not None:
            overtime_raw += hours_mod.wage_minutes(piece.overtime_minutes, hourly) * piece.table.overtime_surcharge_bp
            if piece.is_night:
                night_raw += hours_mod.wage_minutes(piece.minutes, hourly) * piece.table.night_surcharge_bp
            if piece.is_sunday or piece.is_holiday:
                sunday_holiday_raw += (
                    hours_mod.wage_minutes(piece.minutes, hourly) * piece.table.sunday_holiday_surcharge_bp
                )

    if wage_missing:
        return _EmployeePay(
            ordinary_minutes=ordinary_minutes,
            night_minutes=night_minutes,
            sunday_minutes=sunday_minutes,
            holiday_minutes=holiday_minutes,
            overtime_minutes=overtime_minutes,
            base_pay=None,
            night_surcharge=None,
            sunday_holiday_surcharge=None,
            overtime_pay=None,
            total=None,
            pay_reason=(
                "Sin tarifa por hora configurada (POST /admin/payroll/wages) para parte o todo el período."
            ),
        )

    base_pay = hours_mod.minutes_pay_to_pesos(base_raw)
    overtime_pay = _round_half_up(overtime_raw, hours_mod.HOURS_SCALE * BP_DENOMINATOR)
    night_surcharge = _round_half_up(night_raw, hours_mod.HOURS_SCALE * BP_DENOMINATOR)
    sunday_holiday_surcharge = _round_half_up(sunday_holiday_raw, hours_mod.HOURS_SCALE * BP_DENOMINATOR)
    return _EmployeePay(
        ordinary_minutes=ordinary_minutes,
        night_minutes=night_minutes,
        sunday_minutes=sunday_minutes,
        holiday_minutes=holiday_minutes,
        overtime_minutes=overtime_minutes,
        base_pay=base_pay,
        night_surcharge=night_surcharge,
        sunday_holiday_surcharge=sunday_holiday_surcharge,
        overtime_pay=overtime_pay,
        total=base_pay + overtime_pay + night_surcharge + sunday_holiday_surcharge,
        pay_reason=None,
    )


def _wage_rates_by_employee(db: Session, *, store_id: int) -> dict[int, list[PayrollWageRate]]:
    result: dict[int, list[PayrollWageRate]] = {}
    for row in list_wage_rates(db, store_id=store_id):
        result.setdefault(row.employee_id, []).append(row)
    for rates in result.values():
        rates.sort(key=lambda r: r.valid_from)
    return result


def create_run(db: Session, *, actor: Actor, store: Store, date_from: date, date_to: date) -> PayrollRun:
    _validate_range(date_from, date_to)
    tables_sorted = list_surcharge_tables(db, store_id=store.id)
    if not tables_sorted:
        raise AppError(
            "SURCHARGE_TABLE_MISSING",
            "No hay ninguna tabla de recargos configurada en esta sede; "
            "cargá una en POST /admin/payroll/surcharge-tables antes de liquidar.",
        )

    by_employee, tables_used = _employee_pieces(
        db, store=store, date_from=date_from, date_to=date_to, employee_id=None, until=clock.now_utc()
    )
    wage_rates_by_employee = _wage_rates_by_employee(db, store_id=store.id)

    computed_id, computed_name = _actor_identity(actor)
    run = PayrollRun(
        organization_id=store.organization_id,
        store_id=store.id,
        date_from=date_from,
        date_to=date_to,
        tables_used=[_table_snapshot(t) for t in tables_used],
        total_amount=None,
        all_available=True,
        reason=None,
        computed_at=clock.now_utc(),
        computed_by_employee_id=computed_id,
        computed_by_employee_name=computed_name,
    )
    db.add(run)
    db.flush()

    total_amount = 0
    all_available = True
    missing_wage_for: list[str] = []

    for emp_id, pieces in sorted(by_employee.items(), key=lambda kv: kv[1][0].employee_name):
        rates_sorted = wage_rates_by_employee.get(emp_id, [])
        pay = _compute_employee_pay(pieces, rates_sorted)
        if pay.total is None:
            all_available = False
            missing_wage_for.append(pieces[0].employee_name)
        else:
            total_amount += pay.total
        db.add(
            PayrollRunLine(
                run_id=run.id,
                employee_id=emp_id,
                employee_name=pieces[0].employee_name,
                ordinary_minutes=pay.ordinary_minutes,
                night_minutes=pay.night_minutes,
                sunday_minutes=pay.sunday_minutes,
                holiday_minutes=pay.holiday_minutes,
                overtime_minutes=pay.overtime_minutes,
                base_pay=pay.base_pay,
                night_surcharge=pay.night_surcharge,
                sunday_holiday_surcharge=pay.sunday_holiday_surcharge,
                overtime_pay=pay.overtime_pay,
                total=pay.total,
                pay_reason=pay.pay_reason,
            )
        )

    if all_available:
        run.total_amount = total_amount
        run.all_available = True
        run.reason = None
    else:
        run.total_amount = None
        run.all_available = False
        run.reason = "Sin tarifa por hora para: " + ", ".join(sorted(set(missing_wage_for)))
    db.flush()

    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="payroll_run",
        entity_id=run.id,
        action="create",
        before=None,
        after={"date_from": str(date_from), "date_to": str(date_to), "total_amount": run.total_amount},
    )
    return run


def list_runs(db: Session, *, store_id: int) -> list[PayrollRun]:
    stmt = select(PayrollRun).where(PayrollRun.store_id == store_id).order_by(PayrollRun.computed_at.desc())
    return list(db.execute(stmt).scalars())


def get_run(db: Session, *, store_id: int, run_id: int) -> PayrollRun:
    run = db.get(PayrollRun, run_id)
    if run is None or run.store_id != store_id:
        raise NotFoundError(f"La liquidación {run_id} no existe en esta sede")
    return run


def run_lines(db: Session, *, run_id: int) -> list[PayrollRunLine]:
    stmt = select(PayrollRunLine).where(PayrollRunLine.run_id == run_id).order_by(PayrollRunLine.employee_name.asc())
    return list(db.execute(stmt).scalars())


# ---------------------------------------------------------------------------
# Propuesta del reparto de propinas (D-3). NUNCA escribe nada — ni un
# `TipPayout`, ni un `CashMovement`, ni ninguna fila propia. El "confirmar"
# es `POST /admin/tips/payouts`, publicado por `app.shifts` desde 1b-2; el
# frontend lo llama directo con las filas que esta función devolvió.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TipProposalRow:
    employee_id: int
    employee_name: str
    basis: str
    amount: int


@dataclass(frozen=True)
class TipProposalResult:
    method: TipDistributionMethod
    rows: list[TipProposalRow]
    total: int
    available: bool
    reason: str | None


def _shift_tip_total(db: Session, *, store: Store, shift_ids: list[int]) -> int:
    """Suma la propina de los turnos pedidos, leyendo SIEMPRE
    `app.shifts.tips.get_shift_tips` (la llave anti doble conteo de este
    dominio — ver el docstring del módulo). `delivery_tips` entra COMPLETA
    (liquidada o no): la Ley 1935 la debe 100 % a quien la generó desde que
    se cobra, no desde que el domiciliario la entrega."""
    total = 0
    for shift_id in shift_ids:
        shift = db.get(Shift, shift_id)
        if shift is None or shift.organization_id != store.organization_id or shift.store_id != store.id:
            raise NotFoundError(f"El turno {shift_id} no existe en esta sede")
        shift_tips = get_shift_tips(db, shift=shift)
        total += (
            shift_tips.by_method.cash
            + shift_tips.by_method.card
            + shift_tips.by_method.transfer
            + shift_tips.by_method.other
            + shift_tips.delivery_tips
        )
    return total


def _participants(db: Session, *, store: Store, shift_ids: list[int]) -> dict[int, str]:
    """Personas con una entrada de roster en alguno de los turnos pedidos —
    "trabajó el turno", no "cobró el turno" (eso es otra pregunta, la que ya
    responde `by_employee` de `get_shift_tips`; ver el docstring del
    módulo)."""
    stmt = select(ShiftRoster.employee_id, ShiftRoster.employee_name).where(ShiftRoster.shift_id.in_(shift_ids))
    result: dict[int, str] = {}
    for employee_id, employee_name in db.execute(stmt).all():
        result[employee_id] = employee_name
    return result


def resolve_period_shift_ids(db: Session, *, store: Store, date_from: date, date_to: date) -> list[int]:
    """Turnos **CERRADOS** de `store` cuya `BusinessDay` cae en
    `[date_from, date_to]` (fecha de negocio — nunca timestamp UTC; un turno
    que cruza medianoche ya quedó partido en dos `BusinessDay` por
    `app.shifts.service`, así que este join no necesita saberlo). Mismo
    patrón de join que `app.banking.service.pending_deposits` (`Shift` ×
    `BusinessDay` por `business_day_id`), orden determinístico.

    Iteración 2 (C2/H-2): antes de esto, `GET
    /admin/tips/distribution/proposal` sólo aceptaba `shift_id` explícitos y
    la pantalla, que manda `store_id`/`from`/`to`, recibía `422` siempre.
    """
    stmt = (
        select(Shift.id)
        .join(BusinessDay, BusinessDay.id == Shift.business_day_id)
        .where(
            Shift.organization_id == store.organization_id,
            Shift.store_id == store.id,
            Shift.status == ShiftStatus.CLOSED,
            BusinessDay.business_date >= date_from,
            BusinessDay.business_date <= date_to,
        )
        .order_by(BusinessDay.business_date, Shift.id)
    )
    return [row[0] for row in db.execute(stmt).all()]


def get_tip_proposal_for_period(
    db: Session,
    *,
    store: Store,
    date_from: date | None,
    date_to: date | None,
    shift_ids: list[int] | None,
    method: str | None,
) -> tuple[list[int], TipProposalResult]:
    """Envoltorio de `compute_tip_proposal` para
    `GET /admin/tips/distribution/proposal`: si vino un override explícito
    de `shift_ids` (detalle de un turno puntual) lo usa tal cual; si no,
    resuelve `date_from`/`date_to` a turnos cerrados con
    `resolve_period_shift_ids`. Un rango sin ningún turno cerrado devuelve
    `available=False` con motivo en palabras — nunca `422`, y nunca
    `rows: []` con `available=True` (eso se lee en pantalla como "no hubo
    propina" cuando lo cierto es "no hay con qué calcular", la regla de
    null-con-motivo de la fase). No es una segunda matemática de reparto:
    delega TODO el cálculo a `compute_tip_proposal`, la única.

    Devuelve `(shift_ids_usados, TipProposalResult)` — el primero es el que
    la respuesta HTTP tiene que nombrar (`TipProposalOut.shift_ids`), porque
    el cliente los reusa para el "confirmar" (`POST /admin/tips/payouts`).
    """
    if shift_ids:
        # Override explícito: el período ni se mira. R-4 del cierre: por eso
        # `from`/`to` son opcionales cuando viene `shift_id` — pedir un rango
        # que después se ignora no es un override, es un formulario mentiroso.
        resolved_ids = list(shift_ids)
    else:
        assert date_from is not None and date_to is not None, (
            "el router garantiza que sin `shift_id` vienen `from` y `to` "
            "(`PERIOD_OR_SHIFT_REQUIRED`)"
        )
        resolved_ids = resolve_period_shift_ids(db, store=store, date_from=date_from, date_to=date_to)
    if not resolved_ids:
        resolved_method = (
            TipDistributionMethod(method) if method is not None else get_tip_settings(db, store_id=store.id).method
        )
        return [], TipProposalResult(
            method=resolved_method,
            rows=[],
            total=0,
            available=False,
            reason="No hay turnos cerrados en ese rango para esta sede.",
        )
    result = compute_tip_proposal(db, store=store, shift_ids=resolved_ids, method=method)
    return resolved_ids, result


def compute_tip_proposal(
    db: Session, *, store: Store, shift_ids: list[int], method: str | None
) -> TipProposalResult:
    resolved_method = TipDistributionMethod(method) if method is not None else get_tip_settings(db, store_id=store.id).method

    total = _shift_tip_total(db, store=store, shift_ids=shift_ids)
    participants = _participants(db, store=store, shift_ids=shift_ids)

    if not participants:
        return TipProposalResult(
            method=resolved_method,
            rows=[],
            total=total,
            available=False,
            reason="Nadie tiene jornada registrada (ShiftRoster) en estos turnos; no hay entre quién repartir.",
        )
    if total <= 0:
        return TipProposalResult(
            method=resolved_method, rows=[], total=total, available=False, reason="Estos turnos no generaron propina."
        )

    ordered_ids = sorted(participants.keys(), key=lambda eid: participants[eid])

    if resolved_method is TipDistributionMethod.EQUAL_SHARES:
        shares = prorate(total, [1] * len(ordered_ids))
        rows = [
            TipProposalRow(
                employee_id=eid,
                employee_name=participants[eid],
                basis=f"partes iguales entre {len(ordered_ids)} personas",
                amount=shares[i],
            )
            for i, eid in enumerate(ordered_ids)
        ]
        return TipProposalResult(method=resolved_method, rows=rows, total=total, available=True, reason=None)

    if resolved_method is TipDistributionMethod.BY_HOURS:
        until = clock.now_utc()
        minutes_by_employee: dict[int, int] = {eid: 0 for eid in ordered_ids}
        stmt = select(ShiftRoster).where(ShiftRoster.shift_id.in_(shift_ids))
        for roster in db.execute(stmt).scalars():
            worked = sum(hours_mod.minutes_between(s, e) for s, e in _worked_intervals(roster, until=until))
            minutes_by_employee[roster.employee_id] = minutes_by_employee.get(roster.employee_id, 0) + worked
        weights = [minutes_by_employee.get(eid, 0) for eid in ordered_ids]
        if sum(weights) <= 0:
            return TipProposalResult(
                method=resolved_method,
                rows=[],
                total=total,
                available=False,
                reason="Nadie tiene horas registradas en estos turnos; no se puede repartir por horas.",
            )
        shares = prorate(total, weights)
        rows = [
            TipProposalRow(
                employee_id=eid,
                employee_name=participants[eid],
                basis=f"{hours_mod.format_hours(weights[i])} h trabajadas",
                amount=shares[i],
            )
            for i, eid in enumerate(ordered_ids)
        ]
        return TipProposalResult(method=resolved_method, rows=rows, total=total, available=True, reason=None)

    # BY_AREA: reparte el total en partes iguales entre las ÁREAS presentes
    # (quien no tiene área asignada cae en "sin área", un área más — así
    # nadie queda afuera del reparto por falta de configuración), y dentro
    # de cada área, en partes iguales entre sus personas. Elección declarada
    # como supuesto en el entregable: la spec no fija el sub-algoritmo.
    assignments = {row.employee_id: row.area for row in list_area_assignments(db, store_id=store.id)}
    area_of: dict[int, str] = {eid: assignments.get(eid, "sin área") for eid in ordered_ids}
    areas_ordered = sorted(set(area_of.values()))
    area_totals = prorate(total, [1] * len(areas_ordered))
    rows = []
    for area, area_amount in zip(areas_ordered, area_totals):
        members = [eid for eid in ordered_ids if area_of[eid] == area]
        member_shares = prorate(area_amount, [1] * len(members))
        for eid, share in zip(members, member_shares):
            rows.append(
                TipProposalRow(
                    employee_id=eid,
                    employee_name=participants[eid],
                    basis=f"área: {area} ({len(members)} personas)",
                    amount=share,
                )
            )
    return TipProposalResult(method=resolved_method, rows=rows, total=total, available=True, reason=None)
