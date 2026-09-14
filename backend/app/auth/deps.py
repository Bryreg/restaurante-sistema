"""Quién está haciendo la request: dependencias FastAPI de sesión.

Dos identidades (SPEC-NEGOCIO §2.1): el **dispositivo** (activado con el PIN
de sede, sesión larga) y la **persona** (PIN de 4 dígitos, ligada al
dispositivo *en el servidor*, nunca en el token del cliente). `Actor` es lo
que reciben los servicios para atribuir cada escritura.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Literal

import jwt
from fastapi import Depends, Request
from sqlalchemy.orm import Session

from app.auth.models import DeviceSession, Employee
from app.core import clock
from app.core.config import settings
from app.core.db import get_db
from app.core.errors import NotFoundError, UnauthorizedError
from app.core.security import COOKIE_ADMIN, COOKIE_DEVICE, read_token
from app.stores.models import Store


@dataclass(frozen=True)
class Actor:
    kind: Literal["admin", "device"]
    organization_id: int
    store_id: int | None
    employee_id: int | None
    employee_name: str | None
    role: str | None


def _read_admin_actor(request: Request, db: Session) -> Actor | None:
    token = request.cookies.get(COOKIE_ADMIN)
    if not token:
        return None
    try:
        payload = read_token(token)
    except jwt.PyJWTError:
        return None
    employee_id = payload.get("employee_id")
    if employee_id is None:
        return None
    employee = db.get(Employee, employee_id)
    if employee is None or not employee.active or employee.role != "admin":
        return None
    return Actor(
        kind="admin",
        organization_id=employee.organization_id,
        store_id=None,
        employee_id=employee.id,
        employee_name=employee.name,
        role="admin",
    )


def _read_device_session(request: Request, db: Session) -> DeviceSession | None:
    token = request.cookies.get(COOKIE_DEVICE)
    if not token:
        return None
    try:
        payload = read_token(token)
    except jwt.PyJWTError:
        return None
    session_id = payload.get("session_id")
    if session_id is None:
        return None
    session = db.get(DeviceSession, session_id)
    if session is None or session.revoked_at is not None:
        return None
    return session


def current_admin(request: Request, db: Session = Depends(get_db)) -> Actor:
    actor = _read_admin_actor(request, db)
    if actor is None:
        raise UnauthorizedError("Iniciá sesión", code="NOT_AUTHENTICATED")
    return actor


def current_device(request: Request, db: Session = Depends(get_db)) -> Actor:
    session = _read_device_session(request, db)
    if session is None:
        raise UnauthorizedError(
            "Activá el dispositivo con el PIN de sede", code="DEVICE_NOT_ACTIVATED"
        )
    return Actor(
        kind="device",
        organization_id=session.organization_id,
        store_id=session.store_id,
        employee_id=None,
        employee_name=None,
        role=None,
    )


def current_operator(request: Request, db: Session = Depends(get_db)) -> Actor:
    session = _read_device_session(request, db)
    if session is None:
        raise UnauthorizedError(
            "Activá el dispositivo con el PIN de sede", code="DEVICE_NOT_ACTIVATED"
        )
    now = clock.now_utc()
    if (
        session.employee_id is None
        or session.employee_expires_at is None
        or session.employee_expires_at <= now
    ):
        raise UnauthorizedError("Identificate con tu PIN", code="IDENTIFY_REQUIRED")
    employee = db.get(Employee, session.employee_id)
    if employee is None or not employee.active:
        raise UnauthorizedError("Identificate con tu PIN", code="IDENTIFY_REQUIRED")
    # Expiración por inactividad, renovada en cada uso (sliding window).
    session.employee_expires_at = now + timedelta(minutes=settings.EMPLOYEE_SESSION_MINUTES)
    db.flush()
    return Actor(
        kind="device",
        organization_id=session.organization_id,
        store_id=session.store_id,
        employee_id=employee.id,
        employee_name=employee.name,
        role=employee.role,
    )


def current_device_session(request: Request, db: Session = Depends(get_db)) -> DeviceSession:
    """Como `current_device`, pero devuelve la fila (no el `Actor`) para que
    `identify`/`release`/`deactivate` la puedan mutar directamente."""
    session = _read_device_session(request, db)
    if session is None:
        raise UnauthorizedError(
            "Activá el dispositivo con el PIN de sede", code="DEVICE_NOT_ACTIVATED"
        )
    return session


def current_actor(request: Request, db: Session = Depends(get_db)) -> Actor:
    """Admin autenticado o dispositivo con una persona identificada — lo que
    necesita cualquier escritura que se atribuye a alguien."""
    admin_actor = _read_admin_actor(request, db)
    if admin_actor is not None:
        return admin_actor
    return current_operator(request, db)


def admin_store(db: Session, actor: Actor, store_id: int) -> Store:
    """Resuelve una sede validando que sea de la organización del actor.
    Un id de otra organización responde `404`, nunca `403` (no delata que existe)."""
    store = db.get(Store, store_id)
    if store is None or store.organization_id != actor.organization_id:
        raise NotFoundError("La sede no existe")
    return store
