"""Campana del admin: notificaciones y sus reglas por sede."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.auth.deps import Actor, admin_store, current_admin
from app.core import clock
from app.core.csv import csv_response, wants_csv
from app.core.db import get_db
from app.core.errors import NotFoundError
from app.core.features import require_feature
from app.notifications import push
from app.notifications.models import Notification, NotificationRule, PushSubscription
from app.notifications.schemas import (
    NotificationOut,
    NotificationRuleIn,
    NotificationRuleOut,
    PushDeviceOut,
    PushPublicKeyOut,
    PushSubscribeIn,
    PushTestOut,
    PushUnsubscribeIn,
    PushUnsubscribeOut,
)
from app.notifications.service import NOTIFICATION_TYPES, default_level

router = APIRouter()


def _notification_out(row: Notification) -> NotificationOut:
    return NotificationOut(
        id=row.id,
        store_id=row.store_id,
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
    # Deuda declarada en `outputs-2a/ENTREGA.md § 5` (pedido 2b): `format`
    # declarado en el contrato, no sólo leído de `request.query_params` dentro
    # de `wants_csv` — mismo patrón que `app.reports.router.get_sales`.
    format: str | None = Query(None, description='"csv" exporta como CSV'),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
) -> Any:
    del format  # declarado sólo para el OpenAPI; el valor real se lee de `wants_csv(request)`.
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


@router.get("/admin/notifications/{notification_id}")
def get_notification(
    notification_id: int, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> NotificationOut:
    """Un aviso solo: lo que abre la vista «Aviso desde la notificación»
    (`/admin/avisos/{id}`), que es a donde lleva tocar el aviso en el
    celular. De otra organización es `404`, igual que al marcarlo leído."""
    row = db.get(Notification, notification_id)
    if row is None or row.organization_id != actor.organization_id:
        raise NotFoundError("La notificación no existe")
    return _notification_out(row)


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
            out.append(NotificationRuleOut(type=t, enabled=True, threshold=None, level=default_level(t)))
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


# ---------------------------------------------------------------------------
# Avisos al celular (0031, `notifications.push`): la tarjeta «Avisos al
# celular» de Notificaciones. Cada persona maneja SUS celulares.
# ---------------------------------------------------------------------------

_push_gate = Depends(require_feature(push.FEATURE))


def _device_out(sub: PushSubscription) -> PushDeviceOut:
    return PushDeviceOut(
        id=sub.id,
        label=push.device_label(sub.user_agent),
        endpoint=sub.endpoint,
        created_at=sub.created_at,
        last_success_at=sub.last_success_at,
        last_error=sub.last_error,
    )


@router.get("/admin/push/public-key", dependencies=[_push_gate])
def get_push_public_key(db: Session = Depends(get_db), actor: Actor = Depends(current_admin)) -> PushPublicKeyOut:
    return PushPublicKeyOut(public_key=push.vapid_keys(db, actor.organization_id).public_key)


@router.get("/admin/push/devices", dependencies=[_push_gate])
def list_push_devices(db: Session = Depends(get_db), actor: Actor = Depends(current_admin)) -> list[PushDeviceOut]:
    return [_device_out(s) for s in push.list_devices(db, actor)]


@router.post("/admin/push/subscribe", dependencies=[_push_gate])
def subscribe_push(
    body: PushSubscribeIn,
    request: Request,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
) -> PushDeviceOut:
    sub = push.subscribe(
        db,
        actor,
        endpoint=body.endpoint,
        p256dh=body.keys.p256dh,
        auth=body.keys.auth,
        user_agent=request.headers.get("user-agent"),
    )
    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=None,
        entity="push_subscription",
        entity_id=sub.id,
        action="subscribe",
        before=None,
        after={"device": push.device_label(sub.user_agent)},
    )
    return _device_out(sub)


@router.post("/admin/push/unsubscribe", dependencies=[_push_gate])
def unsubscribe_push(
    body: PushUnsubscribeIn, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> PushUnsubscribeOut:
    sub = push.unsubscribe(db, actor, subscription_id=body.subscription_id, endpoint=body.endpoint)
    if sub is None:
        return PushUnsubscribeOut(removed=False)
    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=None,
        entity="push_subscription",
        entity_id=sub.id,
        action="revoke",
        before={"revoked_at": None},
        after={"revoked_reason": sub.revoked_reason},
    )
    return PushUnsubscribeOut(removed=True)


@router.post("/admin/push/test", dependencies=[_push_gate])
def send_push_test(db: Session = Depends(get_db), actor: Actor = Depends(current_admin)) -> PushTestOut:
    outcome = push.send_test(db, actor)
    return PushTestOut(sent=outcome.sent, failed=outcome.failed, removed=outcome.removed)
