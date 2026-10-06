"""Turnos planeados del equipo y su comparación con la asistencia
(auditoría e1, `StaffScheduleShift`, 0050).

El administrador planea, por persona y por día, de qué hora a qué hora
debería trabajar (Nómina › Planeación), y puede copiar la semana anterior
de un toque. La asistencia real (`AttendanceEntry`, la primera entrada del
día) se compara contra lo planeado:

- `on_time`: entró a más tardar `GRACE_MINUTES` después de la hora planeada.
- `late`: entró después; `late_minutes` son los minutos enteros (piso) desde
  la hora planeada.
- `excused`: no entró, y tiene una novedad de nómina vigente ese día
  (incapacidad, vacaciones…): no es una falta.
- `upcoming`: todavía no es la hora (más la gracia).
- `missing`: ya debería estar y no ha marcado; el turno sigue en curso.
- `no_show`: el turno planeado terminó sin ninguna entrada.
- `unplanned`: marcó entrada sin turno planeado ese día.

**Una sola cuenta**: `day_rows` es la comparación de un día; la semana de
Nómina, la tarjeta «Llegadas tarde» del celular (`app.reports.series`, vía
`app.payroll.hooks.late_arrivals`) y los tests la leen de acá.

Las horas viven en minutos desde la medianoche del día operativo, reloj de
Bogotá (`app.core.tz`): la zona la pone el servidor, nunca el navegador.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.auth.deps import Actor
from app.core import clock, tz
from app.core.errors import AppError, NotFoundError
from app.payroll.models import PayrollAbsence, StaffScheduleShift
from app.payroll.schemas import (
    PlannedShiftIn,
    PlannedShiftOut,
    ScheduleDayOut,
    SchedulePersonOut,
    ScheduleWeekOut,
)
from app.shifts.models import AttendanceEntry
from app.stores.models import Store

#: Tolerancia antes de llamar «tarde» a una entrada. Una decisión de
#: operación, declarada acá (no por archivo): cinco minutos.
GRACE_MINUTES = 5
DAY_MINUTES = 24 * 60
#: Roles que trabajan turnos. El administrador autoriza, no opera (no tiene
#: asistencia); el contador sólo lee.
_STAFF_ROLES = ("operator", "supervisor")


# ---------------------------------------------------------------------------
# Horas.
# ---------------------------------------------------------------------------


def _parse_hhmm(value: str) -> int:
    hours, minutes = value.split(":")
    return int(hours) * 60 + int(minutes)


def normalize_minutes(start: str, end: str, *, cutoff_hour: int) -> tuple[int, int]:
    """«07:00»–«15:00» → (420, 900). Una entrada antes de la hora de corte es
    de madrugada del mismo día operativo (+1440); una salida igual o anterior
    a la entrada es del día siguiente (+1440)."""
    start_minute = _parse_hhmm(start)
    if start_minute < cutoff_hour * 60:
        start_minute += DAY_MINUTES
    end_minute = _parse_hhmm(end)
    while end_minute <= start_minute:
        end_minute += DAY_MINUTES
    return start_minute, end_minute


def minute_label(minute: int) -> str:
    """Minutos desde la medianoche del día operativo → «HH:MM» de pared."""
    minute %= DAY_MINUTES
    return f"{minute // 60:02d}:{minute % 60:02d}"


def planned_instant(business_date: date, minute: int) -> datetime:
    """El instante UTC de un minuto del día operativo, reloj de Bogotá."""
    return tz.from_bogota_wall_clock(datetime.combine(business_date, time()) + timedelta(minutes=minute))


def shift_out(row: StaffScheduleShift) -> PlannedShiftOut:
    return PlannedShiftOut(
        id=row.id,
        employee_id=row.employee_id,
        employee_name=row.employee_name,
        business_date=row.business_date,
        start=minute_label(row.start_minute),
        end=minute_label(row.end_minute),
        start_minute=row.start_minute,
        end_minute=row.end_minute,
        planned_minutes=row.end_minute - row.start_minute,
        note=row.note,
        created_by_employee_name=row.created_by_employee_name,
    )


# ---------------------------------------------------------------------------
# Lectura.
# ---------------------------------------------------------------------------


def active_shifts(db: Session, *, store_id: int, date_from: date, date_to: date) -> list[StaffScheduleShift]:
    return list(
        db.execute(
            select(StaffScheduleShift)
            .where(
                StaffScheduleShift.store_id == store_id,
                StaffScheduleShift.business_date >= date_from,
                StaffScheduleShift.business_date <= date_to,
                StaffScheduleShift.voided_at.is_(None),
            )
            .order_by(StaffScheduleShift.business_date, StaffScheduleShift.start_minute, StaffScheduleShift.id)
        ).scalars()
    )


def _first_entries(db: Session, *, store_id: int, date_from: date, date_to: date) -> dict[tuple[int, date], AttendanceEntry]:
    """La primera entrada de cada persona en cada día operativo."""
    out: dict[tuple[int, date], AttendanceEntry] = {}
    rows = db.execute(
        select(AttendanceEntry)
        .where(
            AttendanceEntry.store_id == store_id,
            AttendanceEntry.business_date >= date_from,
            AttendanceEntry.business_date <= date_to,
        )
        .order_by(AttendanceEntry.in_at)
    ).scalars()
    for entry in rows:
        out.setdefault((entry.employee_id, entry.business_date), entry)
    return out


def _excused(db: Session, *, store_id: int, date_from: date, date_to: date) -> list[PayrollAbsence]:
    return list(
        db.execute(
            select(PayrollAbsence).where(
                PayrollAbsence.store_id == store_id,
                PayrollAbsence.voided_at.is_(None),
                PayrollAbsence.date_to >= date_from,
                PayrollAbsence.date_from <= date_to,
            )
        ).scalars()
    )


@dataclass(frozen=True)
class DayRow:
    """Una persona en un día: lo planeado (o nada) contra lo real."""

    employee_id: int
    employee_name: str
    business_date: date
    shift: StaffScheduleShift | None
    actual_in_at: datetime | None
    status: str
    late_minutes: int | None


def _status(
    shift: StaffScheduleShift, entry: AttendanceEntry | None, *, excused: bool, now: datetime
) -> tuple[str, int | None]:
    start_at = planned_instant(shift.business_date, shift.start_minute)
    grace_at = start_at + timedelta(minutes=GRACE_MINUTES)
    if entry is not None:
        if entry.in_at > grace_at:
            return "late", int((entry.in_at - start_at).total_seconds()) // 60
        return "on_time", None
    if excused:
        return "excused", None
    if now < grace_at:
        return "upcoming", None
    if now < planned_instant(shift.business_date, shift.end_minute):
        return "missing", None
    return "no_show", None


def rows_for_range(db: Session, *, store: Store, date_from: date, date_to: date, now: datetime) -> list[DayRow]:
    """La comparación planeado contra real de cada persona y día del rango:
    un renglón por turno planeado, más uno `unplanned` por cada entrada sin
    turno. Los administradores no están (no tienen asistencia)."""
    shifts = active_shifts(db, store_id=store.id, date_from=date_from, date_to=date_to)
    entries = _first_entries(db, store_id=store.id, date_from=date_from, date_to=date_to)
    absences = _excused(db, store_id=store.id, date_from=date_from, date_to=date_to)

    def is_excused(employee_id: int, day: date) -> bool:
        return any(a.employee_id == employee_id and a.date_from <= day <= a.date_to for a in absences)

    out: list[DayRow] = []
    planned_keys: set[tuple[int, date]] = set()
    for shift in shifts:
        key = (shift.employee_id, shift.business_date)
        planned_keys.add(key)
        entry = entries.get(key)
        status, late = _status(shift, entry, excused=is_excused(*key), now=now)
        out.append(
            DayRow(
                employee_id=shift.employee_id,
                employee_name=shift.employee_name,
                business_date=shift.business_date,
                shift=shift,
                actual_in_at=entry.in_at if entry is not None else None,
                status=status,
                late_minutes=late,
            )
        )
    for key, entry in entries.items():
        if key in planned_keys:
            continue
        out.append(
            DayRow(
                employee_id=entry.employee_id,
                employee_name=entry.employee_name,
                business_date=entry.business_date,
                shift=None,
                actual_in_at=entry.in_at,
                status="unplanned",
                late_minutes=None,
            )
        )
    out.sort(key=lambda r: (r.business_date, r.employee_name, r.employee_id))
    return out


def _staff(db: Session, store: Store) -> list[Any]:
    from app.auth.models import Employee

    return list(
        db.execute(
            select(Employee)
            .where(
                Employee.organization_id == store.organization_id,
                Employee.active.is_(True),
                Employee.role.in_(_STAFF_ROLES),
                (Employee.store_id == store.id) | (Employee.store_id.is_(None)),
            )
            .order_by(Employee.name, Employee.id)
        ).scalars()
    )


def week_start_of(day: date) -> date:
    return day - timedelta(days=day.weekday())


def week(db: Session, *, store: Store, week_of: date | None) -> ScheduleWeekOut:
    """La semana (lunes a domingo) de planeación: una fila por persona del
    equipo de la sede (más quien tenga turno o asistencia esa semana aunque
    ya no esté activo), siete días cada una, con su comparación."""
    now = clock.now_utc()
    today = tz.business_date_for(now, store.cutoff_hour)
    start = week_start_of(week_of or today)
    end = start + timedelta(days=6)
    rows = rows_for_range(db, store=store, date_from=start, date_to=end, now=now)

    names: dict[int, str] = {e.id: e.name for e in _staff(db, store)}
    for r in rows:
        names.setdefault(r.employee_id, r.employee_name)
    by_key = {(r.employee_id, r.business_date): r for r in rows}

    people: list[SchedulePersonOut] = []
    late_count = no_show_count = 0
    for employee_id, name in sorted(names.items(), key=lambda kv: (kv[1], kv[0])):
        days: list[ScheduleDayOut] = []
        planned_total = 0
        for i in range(7):
            day = start + timedelta(days=i)
            row = by_key.get((employee_id, day))
            if row is None:
                days.append(ScheduleDayOut(business_date=day, planned=None, actual_in_at=None, status=None, late_minutes=None))
                continue
            if row.shift is not None:
                planned_total += row.shift.end_minute - row.shift.start_minute
            late_count += row.status == "late"
            no_show_count += row.status == "no_show"
            days.append(
                ScheduleDayOut(
                    business_date=day,
                    planned=shift_out(row.shift) if row.shift is not None else None,
                    actual_in_at=row.actual_in_at,
                    status=row.status,  # type: ignore[arg-type]
                    late_minutes=row.late_minutes,
                )
            )
        people.append(SchedulePersonOut(employee_id=employee_id, employee_name=name, planned_minutes=planned_total, days=days))
    return ScheduleWeekOut(
        store_id=store.id,
        week_start=start,
        week_end=end,
        today=today,
        grace_minutes=GRACE_MINUTES,
        late_count=late_count,
        no_show_count=no_show_count,
        people=people,
    )


# ---------------------------------------------------------------------------
# Escritura.
# ---------------------------------------------------------------------------


def _employee_for(db: Session, store: Store, employee_id: int) -> Any:
    from app.auth.models import Employee

    employee = db.get(Employee, employee_id)
    if employee is None or employee.organization_id != store.organization_id:
        raise NotFoundError(f"El empleado {employee_id} no existe en esta organización")
    if employee.role not in _STAFF_ROLES:
        raise AppError(
            "SCHEDULE_ROLE_NOT_PLANNED",
            f"{employee.name} no trabaja turnos (el administrador autoriza y el contador sólo lee): "
            "planeá a meseros, cajeros y supervisores.",
        )
    if employee.store_id is not None and employee.store_id != store.id:
        raise AppError(
            "SCHEDULE_OTHER_STORE",
            f"{employee.name} trabaja en otra sede: planeale el turno desde esa sede en Nómina › Planeación.",
        )
    return employee


def _active_for(db: Session, *, store_id: int, employee_id: int, business_date: date) -> StaffScheduleShift | None:
    return db.execute(
        select(StaffScheduleShift).where(
            StaffScheduleShift.store_id == store_id,
            StaffScheduleShift.employee_id == employee_id,
            StaffScheduleShift.business_date == business_date,
            StaffScheduleShift.voided_at.is_(None),
        )
    ).scalars().first()


def _void(row: StaffScheduleShift, *, actor: Actor, reason: str | None, now: datetime) -> None:
    row.voided_at = now
    row.voided_by_employee_name = actor.employee_name
    row.void_reason = reason


def _insert(
    db: Session, *, actor: Actor, store: Store, employee: Any, business_date: date, start_minute: int, end_minute: int,
    note: str | None, now: datetime,
) -> StaffScheduleShift:
    row = StaffScheduleShift(
        organization_id=store.organization_id,
        store_id=store.id,
        employee_id=employee.id,
        employee_name=employee.name,
        business_date=business_date,
        start_minute=start_minute,
        end_minute=end_minute,
        note=note,
        created_at=now,
        created_by_employee_id=actor.employee_id,
        created_by_employee_name=actor.employee_name,
    )
    try:
        with db.begin_nested():
            db.add(row)
            db.flush()
    except IntegrityError:
        # Carrera: otra pestaña planeó el mismo día entre la lectura y la
        # escritura (`uq_staff_schedule_one_active`). Gana la que llegó
        # primero y se devuelve esa fila, como hace la asistencia: no se
        # rechaza después de haber escrito.
        winner = _active_for(db, store_id=store.id, employee_id=employee.id, business_date=business_date)
        if winner is None:
            raise
        return winner
    return row


def upsert_shift(db: Session, *, actor: Actor, store: Store, payload: PlannedShiftIn) -> StaffScheduleShift:
    """Planea (o cambia) el turno de una persona en un día. Cambiarlo anula
    la fila vigente y crea otra: el historial queda."""
    employee = _employee_for(db, store, payload.employee_id)
    start_minute, end_minute = normalize_minutes(payload.start, payload.end, cutoff_hour=store.cutoff_hour)
    note = (payload.note or "").strip() or None
    now = clock.now_utc()
    existing = _active_for(db, store_id=store.id, employee_id=employee.id, business_date=payload.business_date)
    if existing is not None:
        if (existing.start_minute, existing.end_minute, existing.note) == (start_minute, end_minute, note):
            return existing
        _void(existing, actor=actor, reason="Turno cambiado", now=now)
        db.flush()
    row = _insert(
        db, actor=actor, store=store, employee=employee, business_date=payload.business_date,
        start_minute=start_minute, end_minute=end_minute, note=note, now=now,
    )
    record_audit(
        db, actor=actor, organization_id=store.organization_id, store_id=store.id,
        entity="staff_schedule_shift", entity_id=row.id, action="update" if existing is not None else "create",
        before=shift_out(existing).model_dump(mode="json") if existing is not None else None,
        after=shift_out(row).model_dump(mode="json"),
    )
    return row


def void_shift(db: Session, *, actor: Actor, store: Store, shift_id: int, reason: str | None) -> StaffScheduleShift:
    row = db.get(StaffScheduleShift, shift_id)
    if row is None or row.store_id != store.id:
        raise NotFoundError("Ese turno planeado no existe en esta sede")
    if row.voided_at is not None:
        return row
    _void(row, actor=actor, reason=(reason or "").strip() or "Turno quitado", now=clock.now_utc())
    db.flush()
    record_audit(
        db, actor=actor, organization_id=store.organization_id, store_id=store.id,
        entity="staff_schedule_shift", entity_id=row.id, action="void",
        before=shift_out(row).model_dump(mode="json"), after=None, reason=row.void_reason,
    )
    return row


def copy_previous_week(db: Session, *, actor: Actor, store: Store, week_of: date) -> tuple[date, int, int]:
    """Copia los turnos de la semana anterior a la semana de `week_of`, día
    por día de la semana. Lo que ya está planeado en la semana destino no se
    pisa (`skipped`), ni se copia a quien ya no está activo o cambió de sede."""
    from app.auth.models import Employee

    target = week_start_of(week_of)
    source = target - timedelta(days=7)
    now = clock.now_utc()
    copied = skipped = 0
    for shift in active_shifts(db, store_id=store.id, date_from=source, date_to=source + timedelta(days=6)):
        day = shift.business_date + timedelta(days=7)
        employee = db.get(Employee, shift.employee_id)
        if (
            employee is None
            or not employee.active
            or employee.role not in _STAFF_ROLES
            or (employee.store_id is not None and employee.store_id != store.id)
            or _active_for(db, store_id=store.id, employee_id=shift.employee_id, business_date=day) is not None
        ):
            skipped += 1
            continue
        _insert(
            db, actor=actor, store=store, employee=employee, business_date=day,
            start_minute=shift.start_minute, end_minute=shift.end_minute, note=shift.note, now=now,
        )
        copied += 1
    record_audit(
        db, actor=actor, organization_id=store.organization_id, store_id=store.id,
        entity="staff_schedule_week", entity_id=target.isoformat(), action="copy_previous_week",
        before=None, after={"week_start": target.isoformat(), "copied": copied, "skipped": skipped},
    )
    return target, copied, skipped
