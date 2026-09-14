"""`record_audit`: la única función que escribe en `audit_logs`.

Corre en un SAVEPOINT propio: si falla, se registra en el log y la escritura
de negocio que la llamó sigue su curso (nunca se traga el error, pero
tampoco tumba la transacción entera por un problema de auditoría)."""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy.orm import Session

from app.audit.models import AuditLog
from app.auth.deps import Actor
from app.core import clock

logger = logging.getLogger("app.audit")


def record_audit(
    db: Session,
    *,
    actor: Actor | None,
    organization_id: int,
    store_id: int | None,
    entity: str,
    entity_id: int | str,
    action: str,
    before: dict[str, Any] | None,
    after: dict[str, Any] | None,
    reason: str | None = None,
) -> None:
    try:
        with db.begin_nested():
            row = AuditLog(
                organization_id=organization_id,
                store_id=store_id,
                entity=entity,
                entity_id=str(entity_id),
                action=action,
                before=before,
                after=after,
                reason=reason,
                actor_employee_id=actor.employee_id if actor else None,
                actor_employee_name=actor.employee_name if actor else None,
                actor_kind=actor.kind if actor else None,
                at=clock.now_utc(),
            )
            db.add(row)
            db.flush()
    except Exception:
        logger.exception(
            "No se pudo registrar auditoría: entity=%s entity_id=%s action=%s",
            entity,
            entity_id,
            action,
        )
