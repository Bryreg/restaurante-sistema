"""Los umbrales de «comanda sin enviar / sin cobrar» salen de la regla de la
sede (Notificaciones › Reglas, `NotificationRule.threshold`): antes el campo
se editaba y nadie lo leía (15 y 20 minutos fijos)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.notifications.models import Notification, NotificationRule
from tests.reports.conftest import idem_headers


def test_rule_threshold_moves_the_unsent_and_unpaid_flags(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any,
    main_product: Any, drink_product: Any, clock: Any, db: Any, org: Any, store: Any,
) -> None:
    for type_ in ("order_unsent_too_long", "order_unpaid_too_long"):
        db.add(NotificationRule(organization_id=org.id, store_id=store.id, type=type_, enabled=True, threshold=60, level="warning"))
    db.commit()
    set_feature("pos.pre_bill", True)
    clock.set(datetime(2026, 3, 1, 15, 0, tzinfo=timezone.utc))
    open_shift()
    identify(device_client, employees["operator"])

    unsent = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem_headers()).json()
    resp = device_client.post(
        f"/api/v1/orders/{unsent['id']}/items",
        json={"expected_version": unsent["version"], "items": [{"product_id": main_product.id, "qty": 1}]},
        headers=idem_headers(),
    )
    assert resp.status_code == 200, resp.text

    # 25 minutos: con los defaults (15/20) ya estaría marcada; con 60, no.
    clock.advance(minutes=25)
    body = admin_client.get("/api/v1/admin/today", params={"store_id": store.id}).json()
    assert body["unsent_count"] == 0
    assert {r["id"]: r for r in body["open_orders"]}[unsent["id"]]["unsent_flag"] is False

    clock.advance(minutes=40)  # 65 minutos: ahora sí
    body = admin_client.get("/api/v1/admin/today", params={"store_id": store.id}).json()
    assert body["unsent_count"] == 1
    assert {r["id"]: r for r in body["open_orders"]}[unsent["id"]]["unsent_flag"] is True
    rows = db.execute(select(Notification).where(Notification.type == "order_unsent_too_long")).scalars().all()
    assert len(rows) == 1
