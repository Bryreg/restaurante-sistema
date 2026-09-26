"""Rutas de la asistencia del día (`app.shifts.attendance`, 0028).

Se cuelgan del router de `app.shifts` (`router.include_router` al final de
`app/shifts/router.py`), así que `create_app` las monta con el resto del
dominio sin tocar `app.main.DOMAINS`.

- `POST /attendance/out` — «Marcar salida» en la tablet: la persona
  identificada (un toque), o cualquiera con su propio PIN desde «Quién
  opera», o un supervisor que marca la salida de otro.
- `GET /attendance/today` — quién entró hoy en esta sede (nombres y horas;
  nada de plata ni costos).
- `GET /admin/attendance` y `POST /admin/attendance/{id}/exit` — el
  administrador ve las salidas olvidadas («a revisar») y las corrige con
  motivo. Nada se borra.
"""

from __future__ import annotations

from datetime import date, datetime

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth import service as auth_service
from app.auth.deps import Actor, admin_store, current_admin, current_device, current_operator
from app.auth.models import Employee
from app.core import tz
from app.core.db import get_db
from app.core.errors import AppError, NotFoundError
from app.shifts import attendance
from app.shifts.models import AttendanceEntry

router = APIRouter()

SUPERVISOR_ROLES = ("supervisor", "admin")


class AttendanceEntryOut(BaseModel):
    id: int
    employee_id: int
    employee_name: str
    business_date: date
    puesto: str | None = None
    in_at: datetime
    out_at: datetime | None = None
    # open | closed | review (salida olvidada de un día que ya pasó)
    status: str
    out_source: str | None = None
    out_by_employee_name: str | None = None
    out_reason: str | None = None


class AttendanceListOut(BaseModel):
    entries: list[AttendanceEntryOut]
    pending_review: int


class AttendanceOutIn(BaseModel):
    # Sin `employee_id`: la persona identificada marca su propia salida.
    employee_id: int | None = None
    # Con PIN: la persona marca su salida desde «Quién opera», sin
    # identificarse antes (un toque + su PIN).
    pin: str | None = Field(default=None, min_length=4, max_length=4, pattern=r"^\d{4}$")


class AttendanceFixIn(BaseModel):
    store_id: int
    # Hora de pared de Bogotá (`<input type="datetime-local">`); la zona la
    # pone el servidor.
    out_at: datetime
    reason: str = Field(min_length=1, max_length=300)


def _out(entry: AttendanceEntry, today: date) -> AttendanceEntryOut:
    return AttendanceEntryOut(
        id=entry.id,
        employee_id=entry.employee_id,
        employee_name=entry.employee_name,
        business_date=entry.business_date,
        puesto=entry.puesto,
        in_at=entry.in_at,
        out_at=entry.out_at,
        status=attendance.entry_status(entry, today),
        out_source=entry.out_source,
        out_by_employee_name=entry.out_by_employee_name,
        out_reason=entry.out_reason,
    )


def _store_employee(db: Session, actor: Actor, employee_id: int) -> Employee:
    employee = db.get(Employee, employee_id)
    if (
        employee is None
        or not employee.active
        or employee.organization_id != actor.organization_id
        or (employee.store_id is not None and employee.store_id != actor.store_id)
    ):
        raise NotFoundError("El empleado no existe en esta sede")
    return employee


@router.post("/attendance/out")
def post_attendance_out(
    payload: AttendanceOutIn,
    request: Request,
    db: Session = Depends(get_db),
    device: Actor = Depends(current_device),
) -> AttendanceEntryOut:
    assert device.store_id is not None
    if payload.pin is not None:
        if payload.employee_id is None:
            raise AppError("VALIDATION_ERROR", "employee_id: elegí quién marca la salida", status=400)
        employee = _store_employee(db, device, payload.employee_id)
        if not auth_service.verify_pin(db, employee, payload.pin):
            raise AppError("PIN_INVALID", "PIN incorrecto; intentá de nuevo", status=400)
        actor = Actor(
            kind="device",
            organization_id=device.organization_id,
            store_id=device.store_id,
            employee_id=employee.id,
            employee_name=employee.name,
            role=employee.role,
        )
        source = "self"
    else:
        actor = current_operator(request, db)
        target_id = payload.employee_id if payload.employee_id is not None else actor.employee_id
        assert target_id is not None
        employee = _store_employee(db, actor, target_id)
        if employee.id == actor.employee_id:
            source = "self"
        elif actor.role in SUPERVISOR_ROLES:
            source = "other"
        else:
            raise AppError(
                "EXIT_REQUIRES_SUPERVISOR",
                "Sólo un supervisor marca la salida de otra persona; que la marque ella con su PIN",
                status=403,
            )
    entry = attendance.mark_exit(db, actor=actor, store_id=device.store_id, employee=employee, source=source)
    return _out(entry, attendance.business_date_now(db, device.store_id))


@router.get("/attendance/today")
def get_attendance_today(
    db: Session = Depends(get_db), device: Actor = Depends(current_device)
) -> list[AttendanceEntryOut]:
    assert device.store_id is not None
    today = attendance.business_date_now(db, device.store_id)
    return [_out(e, today) for e in attendance.list_entries(db, store_id=device.store_id, date_from=today, date_to=today)]


@router.get("/admin/attendance")
def get_admin_attendance(
    store_id: int,
    from_: date | None = Query(default=None, alias="from"),
    to: date | None = None,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
) -> AttendanceListOut:
    """Asistencia del período más TODAS las salidas olvidadas de la sede,
    aunque caigan fuera del rango: una salida a revisar no se esconde porque
    el filtro de fechas no la alcanza."""

    store = admin_store(db, actor, store_id)
    today = attendance.business_date_now(db, store.id)
    date_from = from_ or today
    date_to = to or today
    if date_from > date_to:
        raise AppError("VALIDATION_ERROR", "from: tiene que ser anterior o igual a to", status=400)
    rows = attendance.list_entries(db, store_id=store.id, date_from=date_from, date_to=date_to)
    pending = attendance.list_pending_review(db, store_id=store.id)
    seen = {r.id for r in rows}
    merged = rows + [p for p in pending if p.id not in seen]
    merged.sort(key=lambda e: (e.business_date, e.in_at))
    return AttendanceListOut(entries=[_out(e, today) for e in merged], pending_review=len(pending))


@router.post("/admin/attendance/{entry_id}/exit")
def post_admin_attendance_exit(
    entry_id: int,
    payload: AttendanceFixIn,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
) -> AttendanceEntryOut:
    store = admin_store(db, actor, payload.store_id)
    entry = attendance.fix_forgotten_exit(
        db,
        actor=actor,
        store_id=store.id,
        entry_id=entry_id,
        out_at=tz.from_bogota_wall_clock(payload.out_at),
        reason=payload.reason,
    )
    return _out(entry, attendance.business_date_now(db, store.id))
