"""Campana del admin: notificaciones y sus reglas por sede."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.auth.deps import Actor, admin_store, current_admin
from app.core import clock
from app.core.csv import csv_response, wants_csv
from app.core.db import get_db
from app.core.errors import NotFoundError
from app.notifications.models import Notification, NotificationRule
from app.notifications.schemas import NotificationOut, NotificationRuleIn, NotificationRuleOut
from app.notifications.service import NOTIFICATION_TYPES

router = APIRouter()


def _notification_out(row: Notification) -> NotificationOut:
    return NotificationOut(
        id=row.id,
        type=row.type,
        level=row.level,
        title=row.title,
        body=row.body,
        payload=row.payload,
        read_at=row.read_at,
        created_at=row.created_at,
    )


@router.get("/admin/notifications")
def list_notifications(
    request: Request,
    store_id: int | None = None,
    unread_only: bool = False,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
) -> Any:
    stmt = select(Notification).where(Notification.organization_id == actor.organization_id)
    if store_id is not None:
        admin_store(db, actor, store_id)
        stmt = stmt.where(Notification.store_id == store_id)
    if unread_only:
        stmt = stmt.where(Notification.read_at.is_(None))
    stmt = stmt.order_by(Notification.created_at.desc())
    out = [_notification_out(n) for n in db.execute(stmt).scalars().all()]
    if wants_csv(request):
        return csv_response([o.model_dump() for o in out], "notifications.csv")
    return out


@router.post("/admin/notifications/{notification_id}/read")
def mark_read(
    notification_id: int, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> NotificationOut:
    row = db.get(Notification, notification_id)
    if row is None or row.organization_id != actor.organization_id:
        raise NotFoundError("La notificación no existe")
    if row.read_at is None:
        row.read_at = clock.now_utc()
        db.flush()
    return _notification_out(row)


@router.get("/admin/notification-rules")
def get_notification_rules(
    store_id: int, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> list[NotificationRuleOut]:
    admin_store(db, actor, store_id)
    existing = {
        r.type: r
        for r in db.execute(select(NotificationRule).where(NotificationRule.store_id == store_id)).scalars().all()
    }
    out: list[NotificationRuleOut] = []
    for t in NOTIFICATION_TYPES:
        row = existing.get(t)
        if row is not None:
            out.append(NotificationRuleOut(type=t, enabled=row.enabled, threshold=row.threshold, level=row.level))
        else:
            out.append(NotificationRuleOut(type=t, enabled=True, threshold=None, level="warning"))
    return out


@router.put("/admin/notification-rules")
def put_notification_rules(
    store_id: int,
    body: list[NotificationRuleIn],
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
) -> list[NotificationRuleOut]:
    admin_store(db, actor, store_id)
    existing = {
        r.type: r
        for r in db.execute(select(NotificationRule).where(NotificationRule.store_id == store_id)).scalars().all()
    }
    before = {
        t: {"enabled": r.enabled, "threshold": r.threshold, "level": r.level} for t, r in existing.items()
    }
    for entry in body:
        row = existing.get(entry.type)
        if row is None:
            db.add(
                NotificationRule(
                    organization_id=actor.organization_id,
                    store_id=store_id,
                    type=entry.type,
                    enabled=entry.enabled,
                    threshold=entry.threshold,
                    level=entry.level,
                )
            )
        else:
            row.enabled = entry.enabled
            row.threshold = entry.threshold
            row.level = entry.level
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=store_id,
        entity="notification_rule",
        entity_id=store_id,
        action="update",
        before=before,
        after={e.type: e.model_dump() for e in body},
    )
    return get_notification_rules(store_id, db, actor)
