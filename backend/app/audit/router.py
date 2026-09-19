"""`GET /admin/audit`: quién cambió qué, con antes y después."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit.models import AuditLog
from app.audit.schemas import AuditRowOut
from app.auth.deps import Actor, current_admin
from app.core.csv import csv_response, wants_csv
from app.core.db import get_db

router = APIRouter()


def _row_out(row: AuditLog) -> AuditRowOut:
    return AuditRowOut(
        id=row.id,
        entity=row.entity,
        entity_id=row.entity_id,
        action=row.action,
        before=row.before,
        after=row.after,
        reason=row.reason,
        actor_employee_id=row.actor_employee_id,
        actor_employee_name=row.actor_employee_name,
        actor_kind=row.actor_kind,
        at=row.at,
    )


@router.get("/admin/audit")
def list_audit(
    request: Request,
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = None,
    entity: str | None = None,
    employee_id: int | None = None,
    # Deuda declarada en `outputs-2a/ENTREGA.md § 5` (pedido 2b, `backend-lectura-contrato`):
    # `wants_csv` ya leía `format` de `request.query_params` sin declararlo en la
    # firma, así que el OpenAPI no lo publicaba. Mismo patrón que
    # `app.reports.router.get_sales`: declarado sólo para el contrato, el chequeo
    # real sigue siendo `wants_csv(request)`.
    format: str | None = Query(None, description='"csv" exporta como CSV'),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
) -> Any:
    del format  # declarado sólo para el OpenAPI; el valor real se lee de `wants_csv(request)`.
    stmt = select(AuditLog).where(AuditLog.organization_id == actor.organization_id)
    if entity is not None:
        stmt = stmt.where(AuditLog.entity == entity)
    if employee_id is not None:
        stmt = stmt.where(AuditLog.actor_employee_id == employee_id)
    if from_ is not None:
        stmt = stmt.where(AuditLog.at >= from_)
    if to is not None:
        stmt = stmt.where(AuditLog.at <= to)
    stmt = stmt.order_by(AuditLog.at.desc())
    out = [_row_out(r) for r in db.execute(stmt).scalars().all()]
    if wants_csv(request):
        return csv_response([o.model_dump() for o in out], "audit.csv")
    return out
