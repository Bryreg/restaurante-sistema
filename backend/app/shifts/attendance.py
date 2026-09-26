"""Asistencia del día, separada del turno de caja (`AttendanceEntry`, 0028).

**Qué es cada cosa, desde ahora**:

- La **asistencia** es la jornada de la persona en el día operativo: se
  marca con el primer PIN del día, con o sin caja abierta, y termina con
  «Marcar salida». Es lo que nómina suma como horas.
- El **roster** (`ShiftRoster`) es la proyección de la asistencia sobre la
  ventana del turno de caja: quién estuvo en ESE turno, que es lo que
  necesitan el reparto de propinas, los relevos y la línea de tiempo del
  turno. Al abrir la caja entra al roster todo el que ya tenía entrada
  (`sync_roster_on_shift_open`); al marcar salida, la persona sale también
  del roster del turno abierto.

**El administrador no tiene asistencia** (decisión del dueño): en la tablet
sólo autoriza, nunca opera, y no suma horas ni propina. Todas las puertas de
este módulo lo ignoran en silencio.

Este módulo no importa `app.shifts.service` ni `app.shifts.hooks` (los dos lo
importan a él).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.core import clock, tz
from app.core.errors import AppError, NotFoundError
from app.shifts.models import AttendanceEntry, Shift, ShiftRoster, ShiftStatus

ADMIN_ROLE = "admin"

# Estado publicado de una entrada: `open` (hoy, sin salida), `closed` o
# `review` (salida olvidada: quedó abierta en un día operativo que ya pasó).
STATUS_OPEN = "open"
STATUS_CLOSED = "closed"
STATUS_REVIEW = "review"


@dataclass(frozen=True)
class AttendanceMark:
    """Lo que pasó al identificarse: la entrada vigente de hoy (o `None` si
    la persona no lleva asistencia, como el administrador) y si se acaba de
    crear —«Entrada 7:02 a. m.»— o ya existía."""

    entry: AttendanceEntry | None
    created: bool


def _store(db: Session, store_id: int) -> Any:
    from app.stores.models import Store

    store = db.get(Store, store_id)
    if store is None:
        raise NotFoundError("La sede no existe")
    return store


def business_date_now(db: Session, store_id: int) -> date:
    store = _store(db, store_id)
    return tz.business_date_for(clock.now_utc(), store.cutoff_hour)


def entry_status(entry: AttendanceEntry, today: date) -> str:
    if entry.out_at is not None:
        return STATUS_CLOSED
    return STATUS_OPEN if entry.business_date >= today else STATUS_REVIEW


def open_entry(db: Session, *, store_id: int, employee_id: int, business_date: date) -> AttendanceEntry | None:
    return db.execute(
        select(AttendanceEntry)
        .where(
            AttendanceEntry.store_id == store_id,
            AttendanceEntry.employee_id == employee_id,
            AttendanceEntry.business_date == business_date,
            AttendanceEntry.out_at.is_(None),
        )
        .order_by(AttendanceEntry.in_at.desc())
    ).scalars().first()


def record_entry(db: Session, *, store_id: int, employee: Any, source: str) -> AttendanceMark:
    """Marca la entrada de hoy si la persona no tiene una abierta. Idempotente:
    el segundo PIN del día no crea otra. Después de «Marcar salida», el
    siguiente PIN abre una entrada nueva (volvió a trabajar: turno partido).

    Dos tablets que identifican a la misma persona en el mismo instante
    chocan contra `uq_attendance_entries_one_open`; la que pierde relee la
    fila de la que ganó en vez de responder un error."""

    if getattr(employee, "role", None) == ADMIN_ROLE:
        return AttendanceMark(entry=None, created=False)
    store = _store(db, store_id)
    now = clock.now_utc()
    today = tz.business_date_for(now, store.cutoff_hour)
    employee_id = int(getattr(employee, "id"))
    existing = open_entry(db, store_id=store_id, employee_id=employee_id, business_date=today)
    if existing is not None:
        return AttendanceMark(entry=existing, created=False)

    entry = AttendanceEntry(
        organization_id=store.organization_id,
        store_id=store_id,
        employee_id=employee_id,
        employee_name=getattr(employee, "name"),
        business_date=today,
        puesto=getattr(employee, "puesto", None),
        in_at=now,
        in_source=source,
        pauses=[],
        created_at=now,
    )
    try:
        with db.begin_nested():
            db.add(entry)
            db.flush()
    except IntegrityError:
        winner = open_entry(db, store_id=store_id, employee_id=employee_id, business_date=today)
        return AttendanceMark(entry=winner, created=False)
    return AttendanceMark(entry=entry, created=True)


def _close_open_pause(pauses: list | None, at: datetime) -> list:
    result = list(pauses or [])
    if result and result[-1].get("end") is None:
        result[-1] = {**result[-1], "end": at.isoformat()}
    return result


def _open_shift(db: Session, store_id: int) -> Shift | None:
    return db.execute(
        select(Shift).where(Shift.store_id == store_id, Shift.status == ShiftStatus.OPEN)
    ).scalar_one_or_none()


def mark_exit(
    db: Session,
    *,
    actor: Any,
    store_id: int,
    employee: Any,
    source: str,
    close_roster: bool = True,
) -> AttendanceEntry:
    """«Marcar salida»: cierra la entrada abierta de hoy y, si hay un turno
    de caja abierto, también la entrada de la persona en su roster (sin eso
    la jornada seguiría corriendo por el roster hasta el cierre de caja).

    El responsable de caja no sale mientras tenga el cajón: primero el relevo
    —la misma regla que el roster ya hacía cumplir (`NOT_CASH_RESPONSIBLE`)."""

    store = _store(db, store_id)
    now = clock.now_utc()
    today = tz.business_date_for(now, store.cutoff_hour)
    employee_id = int(getattr(employee, "id"))

    shift = _open_shift(db, store_id)
    if shift is not None and shift.cash_responsible_id == employee_id:
        raise AppError(
            "NOT_CASH_RESPONSIBLE",
            "El responsable de caja no sale por acá: hacé un relevo del turno antes de salir",
            status=400,
        )

    entry = open_entry(db, store_id=store_id, employee_id=employee_id, business_date=today)
    if entry is None:
        raise AppError(
            "ATTENDANCE_NOT_OPEN",
            f"{getattr(employee, 'name')} no tiene una entrada abierta hoy: no hay salida que marcar",
            status=400,
        )

    entry.out_at = max(now, entry.in_at)
    entry.pauses = _close_open_pause(entry.pauses, entry.out_at)
    entry.out_source = source
    entry.out_by_employee_id = getattr(actor, "employee_id", None)
    entry.out_by_employee_name = getattr(actor, "employee_name", None)

    if close_roster and shift is not None:
        for roster in db.execute(
            select(ShiftRoster).where(
                ShiftRoster.shift_id == shift.id,
                ShiftRoster.employee_id == employee_id,
                ShiftRoster.out_at.is_(None),
            )
        ).scalars():
            roster.pauses = _close_open_pause(roster.pauses, entry.out_at)
            roster.out_at = max(entry.out_at, roster.in_at)
    db.flush()

    record_audit(
        db,
        actor=actor,
        organization_id=entry.organization_id,
        store_id=entry.store_id,
        entity="attendance_entry",
        entity_id=entry.id,
        action=f"out.{source}",
        before=None,
        after={"employee_id": employee_id, "out_at": entry.out_at.isoformat()},
    )
    return entry


def mirror_roster_action(db: Session, *, actor: Any, store_id: int, employee: Any, action: str, at: datetime) -> None:
    """Lo que se marca en el roster del turno (`POST /shifts/{id}/roster`)
    se refleja en la asistencia del día: la salida del roster es la salida
    del día, y las pausas se descuentan de la jornada igual que antes. La
    entrada ya la marca `hooks.on_employee_identified`."""

    if getattr(employee, "role", None) == ADMIN_ROLE:
        return
    employee_id = int(getattr(employee, "id"))
    if action == "out":
        today = business_date_now(db, store_id)
        if open_entry(db, store_id=store_id, employee_id=employee_id, business_date=today) is None:
            return
        mark_exit(db, actor=actor, store_id=store_id, employee=employee, source="roster", close_roster=False)
        return
    mirror_pause(db, store_id=store_id, employee_id=employee_id, action=action, at=at)


def mirror_pause(db: Session, *, store_id: int, employee_id: int, action: str, at: datetime) -> None:
    """Refleja en la asistencia de hoy una pausa marcada en el roster, para
    que la jornada que suma nómina la descuente igual que antes."""

    today = business_date_now(db, store_id)
    entry = open_entry(db, store_id=store_id, employee_id=employee_id, business_date=today)
    if entry is None:
        return
    pauses = list(entry.pauses or [])
    if action == "pause_start":
        if pauses and pauses[-1].get("end") is None:
            return
        pauses.append({"start": at.isoformat(), "end": None})
    elif action == "pause_end":
        if not pauses or pauses[-1].get("end") is not None:
            return
        pauses[-1] = {**pauses[-1], "end": at.isoformat()}
    else:
        return
    entry.pauses = pauses
    db.flush()


def sync_roster_on_shift_open(db: Session, *, shift: Shift) -> None:
    """Al abrir la caja, entra al roster del turno todo el que ya marcó
    entrada hoy (el cocinero de las 7 a. m. participa del turno que abrió a
    las 11), con hora de entrada al roster = apertura del turno: el roster
    mide el turno de caja; la jornada completa la mide la asistencia."""

    store = _store(db, shift.store_id)
    today = tz.business_date_for(shift.opened_at, store.cutoff_hour)
    from app.auth.models import Employee

    rows = db.execute(
        select(AttendanceEntry, Employee.role)
        .join(Employee, Employee.id == AttendanceEntry.employee_id)
        .where(
            AttendanceEntry.store_id == shift.store_id,
            AttendanceEntry.business_date == today,
            AttendanceEntry.out_at.is_(None),
        )
    ).all()
    for entry, role in rows:
        if role == ADMIN_ROLE:
            continue
        already = db.execute(
            select(ShiftRoster.id).where(
                ShiftRoster.shift_id == shift.id,
                ShiftRoster.employee_id == entry.employee_id,
                ShiftRoster.out_at.is_(None),
            )
        ).first()
        if already is not None:
            continue
        db.add(
            ShiftRoster(
                organization_id=shift.organization_id,
                store_id=shift.store_id,
                shift_id=shift.id,
                employee_id=entry.employee_id,
                employee_name=entry.employee_name,
                in_at=max(shift.opened_at, entry.in_at),
                pauses=[],
            )
        )
    db.flush()


def list_entries(db: Session, *, store_id: int, date_from: date, date_to: date) -> list[AttendanceEntry]:
    return list(
        db.execute(
            select(AttendanceEntry)
            .where(
                AttendanceEntry.store_id == store_id,
                AttendanceEntry.business_date >= date_from,
                AttendanceEntry.business_date <= date_to,
            )
            .order_by(AttendanceEntry.business_date, AttendanceEntry.in_at)
        ).scalars()
    )


def list_pending_review(db: Session, *, store_id: int) -> list[AttendanceEntry]:
    """Salidas olvidadas: entradas abiertas de un día operativo que ya pasó."""

    today = business_date_now(db, store_id)
    return list(
        db.execute(
            select(AttendanceEntry)
            .where(
                AttendanceEntry.store_id == store_id,
                AttendanceEntry.out_at.is_(None),
                AttendanceEntry.business_date < today,
            )
            .order_by(AttendanceEntry.business_date, AttendanceEntry.in_at)
        ).scalars()
    )


def fix_forgotten_exit(
    db: Session, *, actor: Any, store_id: int, entry_id: int, out_at: datetime, reason: str
) -> AttendanceEntry:
    """El administrador corrige una salida olvidada: escribe la hora con su
    motivo. Sólo sobre una entrada todavía abierta —una salida ya marcada no
    se reescribe— y nunca antes de la entrada."""

    entry = db.get(AttendanceEntry, entry_id)
    if entry is None or entry.store_id != store_id:
        raise NotFoundError("Esa entrada de asistencia no existe en esta sede")
    if entry.out_at is not None:
        raise AppError(
            "ATTENDANCE_ALREADY_CLOSED",
            "Esa entrada ya tiene salida marcada; no se reescribe",
            status=400,
        )
    reason = reason.strip()
    if not reason:
        raise AppError("VALIDATION_ERROR", "reason: escribí por qué corregís la salida", status=400)
    if out_at < entry.in_at:
        raise AppError(
            "VALIDATION_ERROR",
            "out_at: la salida no puede ser antes de la entrada; revisá la hora",
            status=400,
        )
    if out_at > clock.now_utc():
        raise AppError("VALIDATION_ERROR", "out_at: la salida no puede estar en el futuro", status=400)

    entry.out_at = out_at
    entry.pauses = _close_open_pause(entry.pauses, out_at)
    entry.out_source = "admin_fix"
    entry.out_by_employee_id = getattr(actor, "employee_id", None)
    entry.out_by_employee_name = getattr(actor, "employee_name", None)
    entry.out_reason = reason
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=entry.organization_id,
        store_id=entry.store_id,
        entity="attendance_entry",
        entity_id=entry.id,
        action="out.admin_fix",
        before={"out_at": None},
        after={"employee_id": entry.employee_id, "out_at": out_at.isoformat()},
        reason=reason,
    )
    return entry
