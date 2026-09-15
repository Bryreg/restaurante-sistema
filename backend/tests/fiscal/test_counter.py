"""`fiscal.service.reserve_next_number`/`issue_document`: consecutivo sin
huecos tras 100 reservas, un cobro rechazado con 400 no consume número,
`internal_receipt` vs `pos_equivalent`, y `dian_status`/`cude` siempre
`pending`/`NULL` en 1b-1 (nada se transmite).
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.fiscal import service as fiscal_service
from app.fiscal.models import FiscalCounter, FiscalDocumentType
from tests.payments.conftest import idem_headers

NO_TIP = {"asked": True, "accepted": False, "modified": False, "amount": 0}


def test_reserve_next_number_no_gaps_after_100_reservations(db: Any, store: Any) -> None:
    numbers = [
        fiscal_service.reserve_next_number(
            db, store_id=store.id, document_type=FiscalDocumentType.POS_EQUIVALENT.value, prefix="POS"
        )
        for _ in range(100)
    ]
    db.commit()
    assert numbers == list(range(1, 101))

    row = db.execute(
        select(FiscalCounter).where(
            FiscalCounter.store_id == store.id,
            FiscalCounter.document_type == FiscalDocumentType.POS_EQUIVALENT,
            FiscalCounter.prefix == "POS",
        )
    ).scalar_one()
    assert row.next_number == 101


def test_internal_receipt_and_pos_equivalent_have_independent_counters(db: Any, store: Any) -> None:
    n1 = fiscal_service.reserve_next_number(
        db, store_id=store.id, document_type=FiscalDocumentType.POS_EQUIVALENT.value, prefix="POS"
    )
    n2 = fiscal_service.reserve_next_number(
        db, store_id=store.id, document_type=FiscalDocumentType.INTERNAL_RECEIPT.value, prefix="POS"
    )
    db.commit()
    assert n1 == 1
    assert n2 == 1  # consecutivo propio por (store, document_type, prefix)


def test_rejected_payment_does_not_consume_a_number(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, drink_product: Any, db: Any, store: Any
) -> None:
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

    # Rechazado por `SPLITS_DO_NOT_MATCH` (400): valida antes de escribir,
    # nunca llega a `reserve_next_number`.
    rejected = device_client.post(
        f"/api/v1/orders/{order['id']}/payments",
        json={"pin": "1111", "tip": NO_TIP, "splits": [{"method": "cash", "amount": 1}]},
        headers=idem_headers(),
    )
    assert rejected.status_code == 400, rejected.text

    accepted = device_client.post(
        f"/api/v1/orders/{order['id']}/payments",
        json={"pin": "1111", "tip": NO_TIP, "splits": [{"method": "cash", "amount": order["totals"]["total"]}]},
        headers=idem_headers(),
    )
    assert accepted.status_code == 201, accepted.text
    assert accepted.json()["document"]["number"] == 1  # el rechazo previo no quemó el 1


def test_dian_status_and_cude_always_pending_and_null(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, drink_product: Any, db: Any
) -> None:
    """1b-1 nunca transmite ni valida (rangos DIAN, `FiscalProvider`, CUDE y
    QR son 1b-2): sea `pos_equivalent` o `internal_receipt`, la evidencia
    fiscal queda siempre `NULL` y el estado, `pending` o `NULL`."""
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
    document_id = resp.json()["document"]["id"]

    from app.fiscal.models import FiscalDocument

    row = db.get(FiscalDocument, document_id)
    assert row.dian_status.value == "pending"
    assert row.cude is None
    assert row.qr_url is None
    assert row.xml_ref is None
    assert row.provider_response is None
    assert row.fiscal_range_id is None
    assert row.validated_at is None
