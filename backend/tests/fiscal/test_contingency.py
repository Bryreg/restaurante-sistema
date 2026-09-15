"""Documento en `contingency` se imprime con su leyenda; a las 48 h dispara
`fiscal_contingency_overdue` — con reloj simulado (`clock.advance`), nunca
`sleep` (SPEC-NEGOCIO §8.3, art. 616-1 ET; checklist del pedido).
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select

from app.fiscal import provider as fiscal_provider
from app.fiscal import service as fiscal_service
from app.notifications.models import Notification
from tests.payments.conftest import idem_headers

NO_TIP = {"asked": True, "accepted": False, "modified": False, "amount": 0}


def _pay_in_contingency(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any
) -> dict[str, Any]:
    fiscal_provider.set_provider_override(fiscal_provider.FakeProvider(outcome="contingency"))
    open_shift()
    identify(device_client, employees["cashier"])
    order_resp = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem_headers())
    order = order_resp.json()
    items_resp = device_client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={"expected_version": order["version"], "items": [{"product_id": drink_product.id, "qty": 1}]},
        headers=idem_headers(),
    )
    order = items_resp.json()
    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/payments",
        json={"pin": "1111", "tip": NO_TIP, "splits": [{"method": "cash", "amount": order["totals"]["total"]}]},
        headers=idem_headers(),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["document"]


def test_contingency_document_prints_with_its_legend(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any
) -> None:
    try:
        document = _pay_in_contingency(device_client, identify, employees, open_shift, drink_product)
        printed = device_client.get(f"/api/v1/documents/{document['id']}")
        assert printed.status_code == 200, printed.text
        assert "CONTINGENCIA" in printed.json()["legend"]
        assert printed.json()["fiscal"]["contingency"] is True
    finally:
        fiscal_provider.set_provider_override(None)


def test_sweep_does_not_fire_before_48_hours(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any, clock: Any, db: Any, store: Any
) -> None:
    try:
        document = _pay_in_contingency(device_client, identify, employees, open_shift, drink_product)
        clock.advance(hours=47)
        fired = fiscal_service.sweep_contingency_overdue(db, store_id=store.id)
        db.commit()
        assert fired == 0

        rows = db.execute(
            select(Notification).where(Notification.type == "fiscal_contingency_overdue")
        ).scalars().all()
        assert rows == []
    finally:
        fiscal_provider.set_provider_override(None)


def test_sweep_fires_fiscal_contingency_overdue_after_48_hours(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any, clock: Any, db: Any, store: Any
) -> None:
    try:
        document = _pay_in_contingency(device_client, identify, employees, open_shift, drink_product)
        clock.advance(hours=49)
        fired = fiscal_service.sweep_contingency_overdue(db, store_id=store.id)
        db.commit()
        assert fired == 1

        rows = db.execute(
            select(Notification).where(Notification.type == "fiscal_contingency_overdue")
        ).scalars().all()
        assert len(rows) == 1
        assert rows[0].payload["document_id"] == document["id"]
        assert rows[0].level == "critical"

        # Idempotente dentro del mismo día (Bogotá): un segundo barrido el
        # mismo día no duplica la notificación (`notify` dedup por
        # `dedupe_key` + fecha).
        fired_again = fiscal_service.sweep_contingency_overdue(db, store_id=store.id)
        db.commit()
        assert fired_again == 0
        rows_after = db.execute(
            select(Notification).where(Notification.type == "fiscal_contingency_overdue")
        ).scalars().all()
        assert len(rows_after) == 1
    finally:
        fiscal_provider.set_provider_override(None)


def test_admin_fiscal_documents_lists_contingency_overdue_flag(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any,
    admin_client: Any, store: Any, clock: Any,
) -> None:
    # `admin_client` (que loguea con un JWT `exp` calculado con `now_utc()`)
    # tiene que resolverse ANTES que `clock` empiece a mockear el reloj: si
    # no, el JWT nace con `exp` en el "pasado real" apenas `clock.advance()`
    # corre, y `admin_client` devuelve `401 NOT_AUTHENTICATED` (pytest arma
    # las fixtures independientes en el orden en que aparecen como
    # parámetro).
    try:
        document = _pay_in_contingency(device_client, identify, employees, open_shift, drink_product)
        clock.advance(hours=49)

        resp = admin_client.get(f"/api/v1/admin/fiscal/documents?store_id={store.id}&status=contingency")
        assert resp.status_code == 200, resp.text
        rows = resp.json()
        row = next(r for r in rows if r["id"] == document["id"])
        assert row["contingency"] is True
        assert row["contingency_overdue"] is True
    finally:
        fiscal_provider.set_provider_override(None)
