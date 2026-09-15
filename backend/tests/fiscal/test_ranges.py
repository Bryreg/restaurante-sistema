"""`GET/POST /admin/fiscal/ranges`: creación, listado, `format=csv`, y
alertas `fiscal_range_low` al 80 % consumido o a menos de 30 días de vencer.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from sqlalchemy import select

from app.core import clock as clock_module
from app.notifications.models import Notification


def _range_payload(store_id: int, **overrides: Any) -> dict[str, Any]:
    body = {
        "store_id": store_id,
        "document_type": "invoice",
        "prefix": "FE2",
        "from_number": 1,
        "to_number": 100,
        "resolution_number": "18760000099",
        "resolution_date": "2026-01-01",
        "valid_from": "2026-01-01",
        "valid_until": "2027-01-01",
        "technical_key": "abc123",
    }
    body.update(overrides)
    return body


def test_post_range_and_get_lists_it(admin_client: Any, store: Any) -> None:
    resp = admin_client.post("/api/v1/admin/fiscal/ranges", json=_range_payload(store.id))
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["prefix"] == "FE2"
    assert body["from_number"] == 1
    assert body["to_number"] == 100
    assert body["consumed"] == 0

    listed = admin_client.get(f"/api/v1/admin/fiscal/ranges?store_id={store.id}")
    assert listed.status_code == 200, listed.text
    rows = listed.json()
    # el POS_EQUIVALENT/INVOICE/... de `default_fiscal_range` + el nuevo FE2
    assert any(r["prefix"] == "FE2" for r in rows)


def test_range_csv_uses_from_to_headers(admin_client: Any, store: Any) -> None:
    admin_client.post("/api/v1/admin/fiscal/ranges", json=_range_payload(store.id, prefix="FE3"))
    resp = admin_client.get(f"/api/v1/admin/fiscal/ranges?store_id={store.id}&format=csv")
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/csv")
    header_line = resp.text.splitlines()[0]
    assert "from" in header_line and "to" in header_line


def test_range_invalid_to_before_from_is_400(admin_client: Any, store: Any) -> None:
    resp = admin_client.post(
        "/api/v1/admin/fiscal/ranges", json=_range_payload(store.id, prefix="FE4", from_number=50, to_number=10)
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FISCAL_RANGE_INVALID"


def test_alert_fires_at_80_percent_consumed(db: Any, store: Any, org: Any) -> None:
    now = clock_module.now_utc()

    from app.fiscal import service as fiscal_service
    from app.fiscal.models import FiscalDocumentType

    fiscal_service.create_range(
        db,
        organization_id=org.id,
        store_id=store.id,
        document_type=FiscalDocumentType.CREDIT_NOTE,
        prefix="NC9",
        from_number=1,
        to_number=10,
        resolution_number="18760000010",
        resolution_date=date(2020, 1, 1),
        valid_from=date(2020, 1, 1),
        valid_until=date(2099, 1, 1),
        technical_key=None,
        now=now,
    )
    db.commit()

    business_date = date(2026, 6, 1)
    for _ in range(8):  # 8/10 == 80%
        fiscal_service.reserve_next_number(
            db, organization_id=org.id, store_id=store.id, document_type=FiscalDocumentType.CREDIT_NOTE,
            business_date=business_date,
        )
    db.commit()

    rows = db.execute(select(Notification).where(Notification.type == "fiscal_range_low")).scalars().all()
    assert any(r.store_id == store.id for r in rows)


def test_alert_fires_when_less_than_30_days_to_expire(db: Any, store: Any, org: Any) -> None:
    from app.fiscal import service as fiscal_service
    from app.fiscal.models import FiscalDocumentType

    now = clock_module.now_utc()
    business_date = date(2026, 6, 1)
    fiscal_service.create_range(
        db,
        organization_id=org.id,
        store_id=store.id,
        document_type=FiscalDocumentType.DEBIT_NOTE,
        prefix="ND9",
        from_number=1,
        to_number=100_000,
        resolution_number="18760000011",
        resolution_date=date(2020, 1, 1),
        valid_from=date(2020, 1, 1),
        valid_until=business_date + timedelta(days=10),
        technical_key=None,
        now=now,
    )
    db.commit()

    fiscal_service.reserve_next_number(
        db, organization_id=org.id, store_id=store.id, document_type=FiscalDocumentType.DEBIT_NOTE,
        business_date=business_date,
    )
    db.commit()

    rows = db.execute(select(Notification).where(Notification.type == "fiscal_range_low")).scalars().all()
    assert any(r.store_id == store.id for r in rows)
