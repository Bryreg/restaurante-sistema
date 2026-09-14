"""`notify`: respeta la regla apagada y deduplica por día (CONTRATO §2)."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import clock
from app.notifications.models import Notification, NotificationRule
from app.notifications.service import notify
from app.stores.models import Organization, Store


def test_notify_creates_a_row(db: Session, org: Organization, store: Store) -> None:
    row = notify(
        db,
        organization_id=org.id,
        store_id=store.id,
        type="shift_stale",
        level="warning",
        title="Turno abandonado",
        body="El turno de anoche sigue abierto",
    )
    assert row is not None
    db.flush()
    rows = db.execute(select(Notification).where(Notification.store_id == store.id)).scalars().all()
    assert len(rows) == 1


def test_notify_respects_disabled_rule(db: Session, org: Organization, store: Store) -> None:
    db.add(
        NotificationRule(
            organization_id=org.id, store_id=store.id, type="shift_stale", enabled=False, level="warning"
        )
    )
    db.flush()

    row = notify(
        db,
        organization_id=org.id,
        store_id=store.id,
        type="shift_stale",
        level="warning",
        title="Turno abandonado",
        body="...",
    )
    assert row is None
    rows = db.execute(select(Notification).where(Notification.store_id == store.id)).scalars().all()
    assert len(rows) == 0


def test_notify_dedupes_daily(db: Session, org: Organization, store: Store) -> None:
    first = notify(
        db,
        organization_id=org.id,
        store_id=store.id,
        type="pin_locked",
        level="warning",
        title="PIN bloqueado",
        body="Operador bloqueó su PIN",
        dedupe_key="pin_locked:42",
    )
    assert first is not None

    second = notify(
        db,
        organization_id=org.id,
        store_id=store.id,
        type="pin_locked",
        level="warning",
        title="PIN bloqueado otra vez",
        body="Operador bloqueó su PIN de nuevo el mismo día",
        dedupe_key="pin_locked:42",
    )
    assert second is None  # mismo día, mismo dedupe_key: no duplica

    rows = db.execute(select(Notification).where(Notification.store_id == store.id)).scalars().all()
    assert len(rows) == 1


def test_notify_dedupe_resets_next_day(db: Session, org: Organization, store: Store) -> None:
    from datetime import datetime, timedelta, timezone

    day_one = datetime(2026, 3, 10, 12, 0, tzinfo=timezone.utc)
    clock.set_clock(lambda: day_one)
    try:
        day1 = notify(
            db,
            organization_id=org.id,
            store_id=store.id,
            type="pin_locked",
            level="warning",
            title="PIN bloqueado",
            body="...",
            dedupe_key="pin_locked:99",
        )
        assert day1 is not None

        day_two = day_one + timedelta(days=1)
        clock.set_clock(lambda: day_two)
        day2 = notify(
            db,
            organization_id=org.id,
            store_id=store.id,
            type="pin_locked",
            level="warning",
            title="PIN bloqueado",
            body="...",
            dedupe_key="pin_locked:99",
        )
        assert day2 is not None  # otro día, se repite
    finally:
        clock.set_clock(None)


def test_pin_locked_notification_fires_on_fifth_failure(
    db: Session, org: Organization, store: Store
) -> None:
    from app.auth import service as auth_service
    from app.auth.models import Employee

    now = clock.now_utc()
    employee = Employee(
        organization_id=org.id,
        store_id=store.id,
        name="Con PIN a punto de bloquear",
        role="operator",
        pin_hash="$2b$04$" + "a" * 53,  # hash inválido a propósito: el PIN nunca va a matchear
        email=None,
        password_hash=None,
        can_charge=False,
        discount_limit_pct=None,
        document=None,
        active=True,
        failed_pin_attempts=4,
        pin_locked_until=None,
        created_at=now,
        updated_at=now,
    )
    db.add(employee)
    db.flush()

    ok = auth_service.verify_pin(db, employee, "0000")
    assert ok is False
    assert employee.pin_locked_until is not None

    rows = db.execute(
        select(Notification).where(Notification.store_id == store.id, Notification.type == "pin_locked")
    ).scalars().all()
    assert len(rows) == 1
