"""Leído ≠ resuelto (0042, hallazgo u7).

Abrir la campana marcaba los avisos leídos y «Requiere tu atención» de Hoy
filtraba por `read_at`: una comanda atascada desaparecía del riel con sólo
mirarla. Ahora `read_at` sólo apaga el «nuevo» de la campana; del riel sale
con «Resolver» (`POST /admin/notifications/resolve`) o cuando la condición
que lo disparó se apaga sola."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit.models import AuditLog
from app.notifications.models import Notification
from app.notifications.service import notify
from app.stores.models import Organization, Store


def _idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


def _pin_locked(db: Session, org: Organization, store: Store) -> Notification:
    row = notify(
        db,
        organization_id=org.id,
        store_id=store.id,
        type="pin_locked",
        level="warning",
        title="PIN bloqueado",
        body="Luz Marina erró el PIN cinco veces.",
    )
    assert row is not None
    db.commit()
    return row


def _rail(admin_client: TestClient, store: Store) -> list[dict[str, Any]]:
    resp = admin_client.get("/api/v1/admin/today", params={"store_id": store.id})
    assert resp.status_code == 200, resp.text
    return [a for a in resp.json()["alerts"] if a["type"] == "pin_locked"]


def test_reading_in_the_bell_keeps_the_alert_in_the_rail(
    admin_client: TestClient, db: Session, org: Organization, store: Store
) -> None:
    row = _pin_locked(db, org, store)
    rail = _rail(admin_client, store)
    assert len(rail) == 1
    assert rail[0]["notification_ids"] == [row.id]

    resp = admin_client.post(f"/api/v1/admin/notifications/{row.id}/read")
    assert resp.status_code == 200, resp.text
    assert resp.json()["read_at"] is not None
    assert resp.json()["resolved_at"] is None

    # Ya no cuenta como nuevo en la campana…
    unread = admin_client.get("/api/v1/admin/notifications", params={"store_id": store.id, "unread_only": True})
    assert [n["id"] for n in unread.json()] == []
    # …pero sigue pidiendo atención en Hoy.
    assert len(_rail(admin_client, store)) == 1


def test_resolve_takes_it_out_of_the_rail_with_who_and_when(
    admin_client: TestClient, db: Session, org: Organization, store: Store, employees: Any
) -> None:
    row = _pin_locked(db, org, store)

    resp = admin_client.post(
        "/api/v1/admin/notifications/resolve", json={"notification_ids": [row.id]}, headers=_idem()
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"resolved": 1}
    assert _rail(admin_client, store) == []

    detail = admin_client.get(f"/api/v1/admin/notifications/{row.id}").json()
    assert detail["resolved_at"] is not None
    assert detail["resolved_by_name"] == employees["admin"].name
    # Resolver también es haberlo visto.
    assert detail["read_at"] is not None

    db.expire_all()
    stored = db.get(Notification, row.id)
    assert stored is not None and stored.resolved_by_employee_id == employees["admin"].id
    audit = db.execute(
        select(AuditLog).where(AuditLog.entity == "notification", AuditLog.action == "resolve")
    ).scalars().all()
    assert len(audit) == 1

    # Resolver de nuevo no cambia nada (ni hora ni quién).
    again = admin_client.post(
        "/api/v1/admin/notifications/resolve", json={"notification_ids": [row.id]}, headers=_idem()
    )
    assert again.status_code == 200, again.text
    assert again.json() == {"resolved": 0}


def test_resolve_requires_idempotency_key_and_replays(
    admin_client: TestClient, db: Session, org: Organization, store: Store
) -> None:
    row = _pin_locked(db, org, store)
    missing = admin_client.post("/api/v1/admin/notifications/resolve", json={"notification_ids": [row.id]})
    assert missing.status_code == 400, missing.text
    assert missing.json()["error"]["code"] == "IDEMPOTENCY_KEY_REQUIRED"

    headers = _idem()
    first = admin_client.post("/api/v1/admin/notifications/resolve", json={"notification_ids": [row.id]}, headers=headers)
    replay = admin_client.post("/api/v1/admin/notifications/resolve", json={"notification_ids": [row.id]}, headers=headers)
    assert first.json() == replay.json() == {"resolved": 1}


def test_resolve_of_another_organization_is_404(
    admin_client: TestClient, db: Session, org: Organization, store: Store, org_b: Organization, store_b: Store
) -> None:
    mine = _pin_locked(db, org, store)
    theirs = notify(
        db, organization_id=org_b.id, store_id=store_b.id, type="pin_locked", level="warning", title="x", body="y"
    )
    assert theirs is not None
    db.commit()

    resp = admin_client.post(
        "/api/v1/admin/notifications/resolve", json={"notification_ids": [mine.id, theirs.id]}, headers=_idem()
    )
    assert resp.status_code == 404, resp.text
    db.expire_all()
    # Ninguno se resolvió: ni el propio.
    assert db.get(Notification, mine.id).resolved_at is None  # type: ignore[union-attr]
    assert db.get(Notification, theirs.id).resolved_at is None  # type: ignore[union-attr]


def test_unresolved_only_filter(admin_client: TestClient, db: Session, org: Organization, store: Store) -> None:
    a = _pin_locked(db, org, store)
    b = notify(db, organization_id=org.id, store_id=store.id, type="product_unavailable", level="info", title="t", body="b")
    assert b is not None
    db.commit()
    admin_client.post("/api/v1/admin/notifications/resolve", json={"notification_ids": [a.id]}, headers=_idem())
    resp = admin_client.get("/api/v1/admin/notifications", params={"store_id": store.id, "unresolved_only": True})
    assert [n["id"] for n in resp.json()] == [b.id]


def test_stale_order_alert_resolves_itself_when_the_order_is_gone(
    admin_client: TestClient, db: Session, org: Organization, store: Store
) -> None:
    """El barrido de Hoy vuelve a mirar las comandas abiertas: el aviso de
    una que ya no está atascada (se envió, se cobró, se cerró) se resuelve
    solo, firmado por el sistema, aunque nadie lo haya tocado."""
    row = notify(
        db,
        organization_id=org.id,
        store_id=store.id,
        type="order_unsent_too_long",
        level="warning",
        title="Comanda sin enviar a cocina",
        body="La comanda #999 lleva 40 min abierta sin enviarse a cocina.",
        payload={"order_id": 999, "minutes": 40},
        dedupe_key="order_unsent_too_long:999",
    )
    assert row is not None
    db.commit()

    resp = admin_client.get("/api/v1/admin/today", params={"store_id": store.id})
    assert resp.status_code == 200, resp.text
    assert all(a["type"] != "order_unsent_too_long" for a in resp.json()["alerts"])
    db.expire_all()
    stored = db.get(Notification, row.id)
    assert stored is not None
    assert stored.resolved_at is not None
    assert stored.resolved_by_name == "Sistema"
    assert stored.resolved_by_employee_id is None


def test_resolved_cash_difference_leaves_the_summary(
    admin_client: TestClient, db: Session, org: Organization, store: Store
) -> None:
    """El resumen de caja junta varias notificaciones y lee sólo las sin
    resolver: una resuelta ya no entra al cálculo."""
    row = notify(
        db, organization_id=org.id, store_id=store.id, type="cash_difference", level="warning",
        title="Diferencia", body="b", payload={"shift_id": 123456},
    )
    assert row is not None
    db.commit()
    admin_client.post("/api/v1/admin/notifications/resolve", json={"notification_ids": [row.id]}, headers=_idem())
    alerts = admin_client.get("/api/v1/admin/today", params={"store_id": store.id}).json()["alerts"]
    assert all(a["type"] != "cash_diff_summary" for a in alerts)
