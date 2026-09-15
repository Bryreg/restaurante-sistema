"""`notify`: la única puerta para crear una notificación.

Respeta la regla de la sede (si existe y está apagada, no crea nada) y
deduplica por día (hora de Bogotá) cuando el llamador manda `dedupe_key` — un
`shift_stale` no tiene que repetirse cada vez que alguien refresca la
pantalla.
"""

from __future__ import annotations

from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import clock, tz
from app.notifications.models import Notification, NotificationRule

NOTIFICATION_TYPES: list[str] = [
    "shift_stale",
    "cash_difference",
    "cash_difference_critical",
    "difference_streak",
    "cash_over_threshold",
    "pin_locked",
    "product_unavailable",
    # 1b-1 (CONTRATO-INTERNO-1b-1.md §2.3): "discount_rate_high" y
    # "courtesy_limit" ya emiten, desde `backend-comanda`; los otros tres
    # quedan declarados para que 1b-2 los use sin tocar este catálogo.
    "discount_rate_high",
    "courtesy_limit",
    "void_rate_high",
    "order_unsent_too_long",
    "order_unpaid_too_long",
    # 1b-2 (backend-clientes-dinero): documento fiscal (rechazo, contingencia
    # vencida, rango por agotarse — emitidos por `backend-fiscal`, territorio
    # ajeno; este catálogo sólo los declara) y devolución pendiente (emitido
    # por `app.refunds.hooks.settle_or_queue_refund`, este territorio).
    "fiscal_rejected",
    "fiscal_contingency_overdue",
    "fiscal_range_low",
    "pending_refund",
]


def _rule(db: Session, store_id: int, type: str) -> NotificationRule | None:
    stmt = select(NotificationRule).where(
        NotificationRule.store_id == store_id, NotificationRule.type == type
    )
    return db.execute(stmt).scalars().first()


def notify(
    db: Session,
    *,
    organization_id: int,
    store_id: int,
    type: str,
    level: Literal["info", "warning", "critical"],
    title: str,
    body: str,
    payload: dict[str, Any] | None = None,
    dedupe_key: str | None = None,
) -> Notification | None:
    rule = _rule(db, store_id, type)
    if rule is not None and not rule.enabled:
        return None

    now = clock.now_utc()
    if dedupe_key is not None:
        today = tz.to_bogota(now).date()
        stmt = (
            select(Notification)
            .where(
                Notification.organization_id == organization_id,
                Notification.store_id == store_id,
                Notification.type == type,
                Notification.dedupe_key == dedupe_key,
            )
            .order_by(Notification.created_at.desc())
            .limit(1)
        )
        existing = db.execute(stmt).scalars().first()
        if existing is not None and tz.to_bogota(existing.created_at).date() == today:
            return None

    row = Notification(
        organization_id=organization_id,
        store_id=store_id,
        type=type,
        level=rule.level if rule is not None else level,
        title=title,
        body=body,
        payload=payload,
        dedupe_key=dedupe_key,
        read_at=None,
        created_at=now,
    )
    db.add(row)
    db.flush()
    return row
