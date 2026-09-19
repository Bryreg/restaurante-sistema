"""El contrato que `app/purchases/hooks.py` publica hacia `reports`
(`overdue_payables`, `pending_review_payables_count`,
`reception_invoice_ratio`) — probado directo, sin pasar por `find_spec_safe`
(eso lo ejercita `reports`, territorio ajeno; acá sólo se prueba que las
funciones hacen lo que dicen)."""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.stores.models import Store


def _idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


def _confirm_reception(admin_client: TestClient, store: Store, supplier_id: int, ingredient_id: int, *, no_invoice: bool, invoice_date: str) -> dict[str, Any]:
    payload = {
        "supplier_id": supplier_id,
        "invoice_number": None if no_invoice else "FE-77",
        "invoice_date": invoice_date,
        "no_invoice": no_invoice,
        "received_by_pin": "2222",
        "lines": [
            {
                "ingredient_id": ingredient_id,
                "qty_received": "1000",
                "qty_invoiced": "1000",
                "purchase_unit_price": "14500",
                "tax_base": 0,
                "tax_rate": 0,
                "tax_amount": 0,
                "lot_code": "L-Z",
                "expires_at": "2026-12-01",
            }
        ],
    }
    resp = admin_client.post(f"/api/v1/receptions?store_id={store.id}", json=payload, headers=_idem())
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_pending_review_payables_count(admin_client: TestClient, store: Store, create_supplier: Any, ingredient_seeded: Any, db: Session) -> None:
    from app.purchases.hooks import pending_review_payables_count

    supplier = create_supplier(invoices_required=False)
    assert pending_review_payables_count(db, store_id=store.id) == 0
    _confirm_reception(admin_client, store, supplier["id"], ingredient_seeded.id, no_invoice=True, invoice_date="2026-01-05")
    assert pending_review_payables_count(db, store_id=store.id) == 1


def test_reception_invoice_ratio(admin_client: TestClient, store: Store, create_supplier: Any, ingredient_seeded: Any, db: Session, clock: Any) -> None:
    from datetime import datetime, timezone

    from app.purchases.hooks import reception_invoice_ratio

    # `Reception.business_date` se sella con el instante REAL de la
    # confirmación, no con `invoice_date` — se fija el reloj dentro del rango
    # que se consulta abajo.
    clock.set(datetime(2026, 1, 10, 12, 0, tzinfo=timezone.utc))
    supplier = create_supplier(invoices_required=False)
    _confirm_reception(admin_client, store, supplier["id"], ingredient_seeded.id, no_invoice=False, invoice_date="2026-01-05")
    _confirm_reception(admin_client, store, supplier["id"], ingredient_seeded.id, no_invoice=True, invoice_date="2026-01-06")
    with_invoice, total = reception_invoice_ratio(db, store_id=store.id, date_from=date(2026, 1, 1), date_to=date(2026, 1, 31))
    assert (with_invoice, total) == (1, 2)


def test_overdue_payables(admin_client: TestClient, store: Store, create_supplier: Any, ingredient_seeded: Any, db: Session) -> None:
    from app.purchases.hooks import overdue_payables

    supplier = create_supplier(invoices_required=False, payment_term_days=0)
    old_date = (date.today() - timedelta(days=60)).isoformat()
    body = _confirm_reception(admin_client, store, supplier["id"], ingredient_seeded.id, no_invoice=True, invoice_date=old_date)
    rows = overdue_payables(db, store_id=store.id)
    assert any(r["payable_id"] == body["payable_id"] for r in rows)
    row = next(r for r in rows if r["payable_id"] == body["payable_id"])
    assert row["balance"] > 0
    assert row["days_overdue"] >= 59
    assert row["supplier_name"] == supplier["name"]
