"""Rutas de identidad: admin, dispositivo, persona activa, autorizaciones y
CRUD de empleados (SPEC-NEGOCIO §2)."""

from __future__ import annotations

import importlib
import importlib.util
from datetime import timedelta
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.auth import service as auth_service
from app.auth.deps import (
    Actor,
    _read_admin_actor,
    _read_device_session,
    current_actor,
    current_admin,
    current_device,
    current_device_session,
)
from app.auth.models import Authorization, DeviceSession, Employee
from app.auth.schemas import (
    AdminLoginIn,
    AdminLoginOut,
    AuthorizationOut,
    AuthorizeIn,
    AuthorizeOut,
    AuthorizerOut,
    DeviceActivateIn,
    DeviceActivateOut,
    DeviceEmployeeOut,
    DeviceIdentifyIn,
    DeviceIdentifyOut,
    EmployeeBriefOut,
    EmployeeCreateIn,
    EmployeeOut,
    EmployeeUpdateIn,
    MeOut,
    OrganizationOut,
    StoreBriefOut,
    UserOut,
)
from app.core import clock
from app.core.config import settings
from app.core.csv import csv_response, wants_csv
from app.core.db import get_db
from app.core.errors import AppError, NotFoundError, UnauthorizedError
from app.core.features import enabled_map
from app.core.security import (
    COOKIE_ADMIN,
    COOKIE_DEVICE,
    clear_session_cookie,
    hash_secret,
    make_token,
    set_session_cookie,
    verify_secret,
)
from app.stores.models import Organization, Store

router = APIRouter()


def _employee_brief(employee: Employee) -> EmployeeBriefOut:
    return EmployeeBriefOut(
        id=employee.id,
        name=employee.name,
        role=employee.role,
        can_charge=employee.can_charge,
        discount_limit_pct=(
            float(employee.discount_limit_pct) if employee.discount_limit_pct is not None else None
        ),
        puesto=employee.puesto,  # type: ignore[arg-type]
    )


def _employee_out(employee: Employee) -> EmployeeOut:
    return EmployeeOut(
        id=employee.id,
        name=employee.name,
        role=employee.role,
        store_id=employee.store_id,
        can_charge=employee.can_charge,
        puesto=employee.puesto,  # type: ignore[arg-type]
        discount_limit_pct=(
            float(employee.discount_limit_pct) if employee.discount_limit_pct is not None else None
        ),
        document=employee.document,
        email=employee.email,
        active=employee.active,
    )


def _employee_audit_view(employee: Employee) -> dict:
    """`before`/`after` de `record_audit(entity="employee")` (A-7, decisión
    resuelta por default en 1b-1): `document` y `email` son PII que no entra
    a la auditoría exportable, aunque `GET /admin/employees` los siga
    devolviendo al admin. Único punto que arma ese `dict` para que ningún
    llamador futuro los vuelva a colar."""

    data = _employee_out(employee).model_dump()
    data.pop("document", None)
    data.pop("email", None)
    return data


def _store_brief(store: Store) -> StoreBriefOut:
    return StoreBriefOut(
        id=store.id, name=store.name, cutoff_hour=store.cutoff_hour, active_channels=list(store.active_channels)
    )


# ---------------------------------------------------------------------------
# Admin: correo + contraseña, cookie httpOnly.
# ---------------------------------------------------------------------------


@router.post("/auth/admin/login")
def admin_login(body: AdminLoginIn, response: Response, db: Session = Depends(get_db)) -> AdminLoginOut:
    stmt = select(Employee).where(
        Employee.role == "admin", Employee.email == body.email, Employee.active.is_(True)
    )
    employee = db.execute(stmt).scalars().first()
    if employee is None or employee.password_hash is None or not verify_secret(
        body.password, employee.password_hash
    ):
        raise AppError(code="INVALID_CREDENTIALS", message="Correo o contraseña incorrectos")

    org = db.get(Organization, employee.organization_id)
    if org is None:
        raise NotFoundError("La organización no existe")

    token = make_token(
        {"employee_id": employee.id}, ttl=timedelta(hours=settings.ADMIN_SESSION_HOURS)
    )
    set_session_cookie(response, COOKIE_ADMIN, token, max_age=settings.ADMIN_SESSION_HOURS * 3600)

    return AdminLoginOut(
        user=UserOut(id=employee.id, name=employee.name, role=employee.role),
        organization=OrganizationOut(id=org.id, name=org.name),
    )


@router.post("/auth/logout")
def admin_logout(response: Response) -> dict[str, bool]:
    clear_session_cookie(response, COOKIE_ADMIN)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Dispositivo: PIN de sede, sesión larga. Prueba dónde, no quién.
# ---------------------------------------------------------------------------


@router.post("/auth/device/activate")
def device_activate(
    body: DeviceActivateIn, response: Response, db: Session = Depends(get_db)
) -> DeviceActivateOut:
    store = db.get(Store, body.store_id)
    if store is None or not store.active or not verify_secret(body.store_pin, store.store_pin_hash):
        raise AppError(code="STORE_PIN_INVALID", message="PIN de sede incorrecto")

    now = clock.now_utc()
    session = DeviceSession(
        id=str(uuid4()),
        organization_id=store.organization_id,
        store_id=store.id,
        device_name=None,
        employee_id=None,
        employee_bound_at=None,
        employee_expires_at=None,
        created_at=now,
        revoked_at=None,
    )
    db.add(session)
    db.flush()

    token = make_token({"session_id": session.id}, ttl=timedelta(days=settings.DEVICE_SESSION_DAYS))
    set_session_cookie(
        response, COOKIE_DEVICE, token, max_age=settings.DEVICE_SESSION_DAYS * 86400
    )
    # Un navegador opera con un solo rol a la vez. `/auth/me` le da prioridad
    # a la cookie de administrador, así que activar el POS en un navegador
    # donde el dueño tenía el admin abierto respondía 200 y la pantalla
    # volvía a «Activar dispositivo» en bucle, sin mensaje. Activar cierra
    # la sesión de administrador en ESTE navegador (la pantalla lo avisa).
    clear_session_cookie(response, COOKIE_ADMIN)

    return DeviceActivateOut(store=_store_brief(store))


@router.post("/auth/device/identify")
def device_identify(
    body: DeviceIdentifyIn,
    db: Session = Depends(get_db),
    session: DeviceSession = Depends(current_device_session),
) -> DeviceIdentifyOut:
    employee = db.get(Employee, body.employee_id)
    if (
        employee is None
        or not employee.active
        or employee.organization_id != session.organization_id
        or (employee.store_id is not None and employee.store_id != session.store_id)
    ):
        raise NotFoundError("El empleado no existe en esta sede")

    ok = auth_service.verify_pin(db, employee, body.pin)
    if not ok:
        now = clock.now_utc()
        if employee.pin_locked_until is not None and employee.pin_locked_until > now:
            raise AppError(
                code="PIN_LOCKED",
                message=f"PIN bloqueado por {settings.PIN_LOCK_MINUTES} minutos tras varios intentos fallidos",
            )
        raise AppError(code="PIN_INVALID", message="PIN incorrecto; intentá de nuevo")

    now = clock.now_utc()
    session.employee_id = employee.id
    session.last_employee_id = employee.id
    session.employee_bound_at = now
    session.employee_expires_at = now + timedelta(minutes=settings.EMPLOYEE_SESSION_MINUTES)
    db.flush()

    # Hook cruzado: si el dominio de turnos ya existe, suma al roster.
    # La función vive en app/shifts/hooks.py (no en service.py, que solo lo
    # importa): buscarla en el módulo equivocado dejaba el hook sin correr
    # jamás desde HTTP (defecto D-1 de la entrega del pedido 1a).
    if importlib.util.find_spec("app.shifts.hooks") is not None:
        shifts_hooks = importlib.import_module("app.shifts.hooks")
        on_identified = getattr(shifts_hooks, "on_employee_identified", None)
        if callable(on_identified):
            on_identified(db, store_id=session.store_id, employee=employee)

    return DeviceIdentifyOut(employee=_employee_brief(employee))


@router.post("/auth/device/release")
def device_release(
    db: Session = Depends(get_db), session: DeviceSession = Depends(current_device_session)
) -> dict[str, bool]:
    session.employee_id = None
    session.employee_bound_at = None
    session.employee_expires_at = None
    db.flush()
    return {"ok": True}


@router.post("/auth/device/deactivate")
def device_deactivate(
    response: Response,
    db: Session = Depends(get_db),
    session: DeviceSession = Depends(current_device_session),
) -> dict[str, bool]:
    session.revoked_at = clock.now_utc()
    session.employee_id = None
    session.employee_expires_at = None
    db.flush()
    clear_session_cookie(response, COOKIE_DEVICE)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Personal del dispositivo: «Quién opera» (SPEC-NEGOCIO §9.1, A-9 de 1a).
# ---------------------------------------------------------------------------


@router.get("/device/employees")
def list_device_employees(
    actor: Actor = Depends(current_device), db: Session = Depends(get_db)
) -> list[DeviceEmployeeOut]:
    """Personal activo que puede identificarse en este dispositivo: el de la
    sede del dispositivo, más los admins de toda la organización (`store_id
    IS NULL`, tienen PIN de POS). **Nunca** `document`, `email`,
    `discount_limit_pct`, `can_charge` ni hashes (CONTRATO-INTERNO-1b-1.md
    §2.4): el esquema `DeviceEmployeeOut` sólo tiene `id`, `name`, `role`."""

    stmt = (
        select(Employee)
        .where(
            Employee.organization_id == actor.organization_id,
            Employee.active.is_(True),
            or_(Employee.store_id == actor.store_id, Employee.store_id.is_(None)),
        )
        .order_by(Employee.name)
    )
    rows = db.execute(stmt).scalars().all()
    return [DeviceEmployeeOut(id=e.id, name=e.name, role=e.role) for e in rows]


# ---------------------------------------------------------------------------
# Sesión actual y autorizaciones puntuales.
# ---------------------------------------------------------------------------


@router.get("/auth/me")
def me(request: Request, db: Session = Depends(get_db)) -> MeOut:
    admin_actor = _read_admin_actor(request, db)
    if admin_actor is not None:
        employee = db.get(Employee, admin_actor.employee_id)
        org = db.get(Organization, admin_actor.organization_id)
        if employee is None or org is None:
            raise UnauthorizedError("Iniciá sesión", code="NOT_AUTHENTICATED")
        features = enabled_map(db, org.id, None)
        return MeOut(
            kind="admin",
            user=UserOut(id=employee.id, name=employee.name, role=employee.role),
            organization=OrganizationOut(id=org.id, name=org.name),
            features=features,
        )

    session = _read_device_session(request, db)
    if session is None:
        raise UnauthorizedError(
            "Activá el dispositivo con el PIN de sede", code="DEVICE_NOT_ACTIVATED"
        )

    store = db.get(Store, session.store_id)
    org = db.get(Organization, session.organization_id)
    if store is None or org is None:
        raise UnauthorizedError(
            "Activá el dispositivo con el PIN de sede", code="DEVICE_NOT_ACTIVATED"
        )

    employee_out = None
    employee_expires_at = None
    now = clock.now_utc()
    if (
        session.employee_id is not None
        and session.employee_expires_at is not None
        and session.employee_expires_at > now
    ):
        employee = db.get(Employee, session.employee_id)
        if employee is not None and employee.active:
            employee_out = _employee_brief(employee)
            employee_expires_at = session.employee_expires_at

    features = enabled_map(db, session.organization_id, session.store_id)

    return MeOut(
        kind="device",
        store=_store_brief(store),
        employee=employee_out,
        employee_expires_at=employee_expires_at,
        last_employee_id=session.last_employee_id,
        organization=OrganizationOut(id=org.id, name=org.name),
        features=features,
    )


@router.post("/auth/authorize")
def authorize(
    body: AuthorizeIn,
    request: Request,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_actor),
) -> AuthorizeOut:
    store_id = actor.store_id
    if store_id is None:
        raw = request.query_params.get("store_id")
        store_id = int(raw) if raw is not None else None
    if store_id is None:
        raise AppError(
            code="VALIDATION_ERROR", message="store_id: es obligatorio para autorizar desde admin"
        )

    employee = auth_service.verify_authorizer(
        db,
        organization_id=actor.organization_id,
        store_id=store_id,
        pin=body.pin,
        action=body.action,
        requested_by=actor,
    )
    return AuthorizeOut(authorizer=AuthorizerOut(id=employee.id, name=employee.name, role=employee.role))


# ---------------------------------------------------------------------------
# Admin: CRUD de empleados y reporte de autorizaciones.
# ---------------------------------------------------------------------------


@router.get("/admin/employees")
def list_employees(
    request: Request,
    store_id: int | None = None,
    active: bool | None = None,
    # Deuda declarada en `outputs-2a/ENTREGA.md § 5` (pedido 2b): `format`
    # declarado en el contrato, no sólo leído de `request.query_params` dentro
    # de `wants_csv` — mismo patrón que `app.reports.router.get_sales`.
    format: str | None = Query(None, description='"csv" exporta como CSV'),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
) -> Any:
    del format  # declarado sólo para el OpenAPI; el valor real se lee de `wants_csv(request)`.
    stmt = select(Employee).where(Employee.organization_id == actor.organization_id)
    if store_id is not None:
        stmt = stmt.where(Employee.store_id == store_id)
    if active is not None:
        stmt = stmt.where(Employee.active.is_(active))
    stmt = stmt.order_by(Employee.name)
    employees = db.execute(stmt).scalars().all()

    if wants_csv(request):
        rows = [_employee_out(e).model_dump() for e in employees]
        return csv_response(rows, "employees.csv")
    return [_employee_out(e) for e in employees]


@router.post("/admin/employees")
def create_employee(
    body: EmployeeCreateIn, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> EmployeeOut:
    if body.store_id is not None:
        store = db.get(Store, body.store_id)
        if store is None or store.organization_id != actor.organization_id:
            raise NotFoundError("La sede no existe")

    if body.email is not None:
        existing = db.execute(
            select(Employee).where(Employee.email == body.email)
        ).scalars().first()
        if existing is not None:
            raise AppError(code="EMAIL_TAKEN", message="Ese correo ya está en uso por otro usuario")

    now = clock.now_utc()
    employee = Employee(
        organization_id=actor.organization_id,
        store_id=body.store_id,
        name=body.name,
        role=body.role,
        pin_hash=hash_secret(body.pin),
        email=body.email,
        password_hash=hash_secret(body.password) if body.password else None,
        can_charge=body.can_charge,
        puesto=body.puesto,
        discount_limit_pct=body.discount_limit_pct,
        document=body.document,
        active=True,
        failed_pin_attempts=0,
        pin_locked_until=None,
        created_at=now,
        updated_at=now,
    )
    db.add(employee)
    db.flush()

    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=employee.store_id,
        entity="employee",
        entity_id=employee.id,
        action="create",
        before=None,
        after=_employee_audit_view(employee),
    )
    return _employee_out(employee)


@router.patch("/admin/employees/{employee_id}")
def update_employee(
    employee_id: int,
    body: EmployeeUpdateIn,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
) -> EmployeeOut:
    employee = db.get(Employee, employee_id)
    if employee is None or employee.organization_id != actor.organization_id:
        raise NotFoundError("El empleado no existe")

    before = _employee_audit_view(employee)

    if body.store_id is not None:
        store = db.get(Store, body.store_id)
        if store is None or store.organization_id != actor.organization_id:
            raise NotFoundError("La sede no existe")

    if body.email is not None and body.email != employee.email:
        existing = db.execute(
            select(Employee).where(Employee.email == body.email, Employee.id != employee.id)
        ).scalars().first()
        if existing is not None:
            raise AppError(code="EMAIL_TAKEN", message="Ese correo ya está en uso por otro usuario")

    data = body.model_dump(exclude_unset=True)
    if "pin" in data and data["pin"] is not None:
        employee.pin_hash = hash_secret(data["pin"])
    if "password" in data and data["password"] is not None:
        employee.password_hash = hash_secret(data["password"])
    for field in ("name", "role", "store_id", "can_charge", "puesto", "discount_limit_pct", "document", "email", "active"):
        if field in data:
            setattr(employee, field, data[field])
    employee.updated_at = clock.now_utc()
    db.flush()

    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=employee.store_id,
        entity="employee",
        entity_id=employee.id,
        action="update",
        before=before,
        after=_employee_audit_view(employee),
    )
    return _employee_out(employee)


@router.get("/admin/authorizations")
def list_authorizations(
    request: Request,
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = None,
    authorizer_id: int | None = None,
    # Deuda declarada en `outputs-2a/ENTREGA.md § 5` (pedido 2b): ver
    # `list_employees` arriba, mismo motivo.
    format: str | None = Query(None, description='"csv" exporta como CSV'),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
) -> Any:
    del format  # declarado sólo para el OpenAPI; el valor real se lee de `wants_csv(request)`.
    stmt = select(Authorization).where(Authorization.organization_id == actor.organization_id)
    if authorizer_id is not None:
        stmt = stmt.where(Authorization.authorizer_id == authorizer_id)
    if from_ is not None:
        stmt = stmt.where(Authorization.at >= from_)
    if to is not None:
        stmt = stmt.where(Authorization.at <= to)
    stmt = stmt.order_by(Authorization.at.desc())
    rows = db.execute(stmt).scalars().all()

    out = [
        AuthorizationOut(
            id=a.id,
            authorizer_id=a.authorizer_id,
            authorizer_name=a.authorizer_name,
            action=a.action,
            requested_by_employee_id=a.requested_by_employee_id,
            at=a.at,
            reference_type=a.reference_type,
            reference_id=a.reference_id,
        )
        for a in rows
    ]
    if wants_csv(request):
        return csv_response([o.model_dump() for o in out], "authorizations.csv")
    return out
