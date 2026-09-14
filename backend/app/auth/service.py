"""Verificación de PIN y de autorizaciones (SPEC-NEGOCIO §2.2).

Un PIN compartido convierte la autorización en teatro: acá cada autorización
queda a nombre de quien la dio (`Authorization`), y el supervisor solo puede
autorizar lo que la matriz le permite — nunca retiros ni rescates.
"""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.deps import Actor
from app.auth.models import Authorization, Employee
from app.core import clock
from app.core.config import settings
from app.core.errors import AppError
from app.core.features import is_enabled
from app.core.security import verify_secret
from app.notifications.service import notify

SUPERVISOR_ACTIONS: set[str] = {"void_sent_item", "courtesy", "discount_over_limit"}


def verify_pin(db: Session, employee: Employee, pin: str) -> bool:
    """Verifica el PIN de una persona ya identificada por id. Lleva el
    contador de fallos y el bloqueo de 15 minutos tras 5 intentos (con
    notificación `pin_locked`); mientras está bloqueada, cualquier PIN
    devuelve `False` sin tocar el contador."""
    now = clock.now_utc()
    if employee.pin_locked_until is not None and employee.pin_locked_until > now:
        return False

    if verify_secret(pin, employee.pin_hash):
        employee.failed_pin_attempts = 0
        employee.pin_locked_until = None
        db.flush()
        return True

    employee.failed_pin_attempts += 1
    if employee.failed_pin_attempts >= settings.PIN_LOCK_ATTEMPTS:
        employee.pin_locked_until = now + timedelta(minutes=settings.PIN_LOCK_MINUTES)
        employee.failed_pin_attempts = 0
        db.flush()
        # Un admin (store_id None, ve toda la organización) no tiene una sede
        # a la que atarle la notificación; sólo se notifica cuando sí la hay.
        if employee.store_id is not None:
            notify(
                db,
                organization_id=employee.organization_id,
                store_id=employee.store_id,
                type="pin_locked",
                level="warning",
                title="PIN bloqueado",
                body=f"{employee.name} bloqueó su PIN tras {settings.PIN_LOCK_ATTEMPTS} intentos fallidos",
                payload={"employee_id": employee.id},
                dedupe_key=f"pin_locked:{employee.id}:{now.date().isoformat()}",
            )
    else:
        db.flush()
    return False


def verify_authorizer(
    db: Session,
    *,
    organization_id: int,
    store_id: int,
    pin: str | None,
    action: str,
    requested_by: Actor | None,
    reference: tuple[str, str] | None = None,
) -> Employee:
    """Busca, entre supervisores y administradores activos de la sede (o de
    toda la organización, en el caso del admin), a quién pertenece `pin`, y
    valida que su rol pueda autorizar `action`. Registra la autorización."""
    if pin is None:
        needs_admin_only = action not in SUPERVISOR_ACTIONS
        message = (
            "Pedí el PIN de un administrador"
            if needs_admin_only
            else "Pedí el PIN de un supervisor o administrador"
        )
        raise AppError(code="AUTHORIZATION_REQUIRED", message=message)

    supervisor_enabled = is_enabled(db, organization_id, store_id, "roles.supervisor")
    allowed_roles = {"admin"}
    if action in SUPERVISOR_ACTIONS and supervisor_enabled:
        allowed_roles.add("supervisor")

    candidates = (
        db.execute(
            select(Employee).where(
                Employee.organization_id == organization_id,
                Employee.active.is_(True),
                Employee.role.in_(["admin", "supervisor"]),
            )
        )
        .scalars()
        .all()
    )
    # Un admin ve toda la organización (store_id None); un supervisor es de una sede.
    in_scope = [e for e in candidates if e.store_id is None or e.store_id == store_id]

    matched: Employee | None = None
    for candidate in in_scope:
        if verify_secret(pin, candidate.pin_hash):
            matched = candidate
            break

    if matched is None:
        raise AppError(code="AUTHORIZATION_INVALID", message="PIN de autorización incorrecto")

    now = clock.now_utc()
    if matched.pin_locked_until is not None and matched.pin_locked_until > now:
        raise AppError(
            code="PIN_LOCKED",
            message=f"Ese PIN está bloqueado por {settings.PIN_LOCK_MINUTES} minutos tras varios intentos fallidos",
        )

    if matched.role not in allowed_roles:
        who = "Un supervisor" if matched.role == "supervisor" else "Ese rol"
        raise AppError(
            code="AUTHORIZATION_NOT_ALLOWED",
            message=f'{who} no puede autorizar "{action}"; pedí un administrador',
        )

    row = Authorization(
        organization_id=organization_id,
        store_id=store_id,
        authorizer_id=matched.id,
        authorizer_name=matched.name,
        action=action,
        requested_by_employee_id=requested_by.employee_id if requested_by else None,
        at=now,
        reference_type=reference[0] if reference else None,
        reference_id=reference[1] if reference else None,
    )
    db.add(row)
    db.flush()
    return matched
