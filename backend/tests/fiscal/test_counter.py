"""`fiscal.service.reserve_next_number`: consecutivo sin huecos dentro de un
rango vigente (100 reservas directas); sin rango vigente, `400
NO_FISCAL_RANGE`; rango agotado, `400 FISCAL_RANGE_EXHAUSTED`; un cobro
rechazado (`400` de validación) no consume número; `internal_receipt` sigue
con `FiscalCounter` (sin exigir rango). Checklist del pedido: «Consecutivo
por tipo y sede sin huecos tras 100 ventas, 3 notas y 2 rechazos del
`FakeProvider`; un rechazo no libera el número» se cierra acá (unitario, 100
reservas) y en `test_provider.py`/`test_notes.py` (el circuito HTTP
completo, con rechazos de verdad).
"""

from __future__ import annotations

from datetime import date
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core import clock as clock_module
from app.fiscal import service as fiscal_service
from app.fiscal.models import FiscalCounter, FiscalDocumentType
from tests.payments.conftest import idem_headers

NO_TIP = {"asked": True, "accepted": False, "modified": False, "amount": 0}


def test_reserve_next_number_no_gaps_after_100_reservations(db: Any, store: Any) -> None:
    business_date = date(2026, 6, 1)
    numbers = [
        fiscal_service.reserve_next_number(
            db,
            organization_id=store.organization_id,
            store_id=store.id,
            document_type=FiscalDocumentType.POS_EQUIVALENT,
            business_date=business_date,
        )[1]
        for _ in range(100)
    ]
    db.commit()
    assert numbers == list(range(1, 101))


def test_internal_receipt_keeps_the_simple_counter_without_a_range(db: Any, store: Any) -> None:
    """`internal_receipt` (sede no obligada) nunca exige `fiscal_ranges`:
    sigue con `FiscalCounter`, como en 1b-1."""
    n1 = fiscal_service._reserve_internal_receipt_number(db, store_id=store.id, prefix="POS")
    n2 = fiscal_service._reserve_internal_receipt_number(db, store_id=store.id, prefix="POS")
    db.commit()
    assert (n1, n2) == (1, 2)

    row = db.execute(
        select(FiscalCounter).where(
            FiscalCounter.store_id == store.id,
            FiscalCounter.document_type == FiscalDocumentType.INTERNAL_RECEIPT,
            FiscalCounter.prefix == "POS",
        )
    ).scalar_one()
    assert row.next_number == 3


def test_no_fiscal_range_blocks_the_sale_with_400_and_correction_action(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, drink_product: Any, db: Any, store: Any
) -> None:
    """Sin `default_fiscal_range` (fixture autouse de este árbol): un cobro
    sobre un tipo DIAN-trazable sin rango vigente falla con `400
    NO_FISCAL_RANGE` y un mensaje que nombra la acción correctiva — nunca un
    `500`. Se borra el rango que la fixture ya cargó para simular la sede
    real que todavía no configuró nada."""
    from app.fiscal.models import FiscalRange

    db.execute(FiscalRange.__table__.delete().where(FiscalRange.store_id == store.id))
    db.commit()

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
        json={
            "pin": "1111",
            "tip": NO_TIP,
            "splits": [{"method": "cash", "amount": order["totals"]["total"]}],
        },
        headers=idem_headers(),
    )
    assert resp.status_code == 400, resp.text
    body = resp.json()
    assert body["error"]["code"] == "NO_FISCAL_RANGE"
    assert "Admin" in body["error"]["message"] and "rango" in body["error"]["message"].lower()

    # La comanda queda intacta: no se cobró nada, se puede reintentar tras
    # cargar el rango.
    still_open = device_client.get(f"/api/v1/orders/{order['id']}").json()
    assert still_open["status"] in ("open", "to_pay")


def test_fiscal_range_exhausted_blocks_the_sale(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, drink_product: Any, db: Any, store: Any
) -> None:
    """Un rango vigente pero sin números libres → `400
    FISCAL_RANGE_EXHAUSTED` (no `NO_FISCAL_RANGE`: la distinción importa
    para que el admin sepa si tiene que cargar el primer rango o uno
    nuevo)."""
    from app.fiscal.models import FiscalRange

    db.execute(FiscalRange.__table__.delete().where(FiscalRange.store_id == store.id))
    db.commit()
    fiscal_service.create_range(
        db,
        organization_id=store.organization_id,
        store_id=store.id,
        document_type=FiscalDocumentType.POS_EQUIVALENT,
        prefix="POS",
        from_number=1,
        to_number=1,
        resolution_number="18760000002",
        resolution_date=date(2020, 1, 1),
        valid_from=date(2020, 1, 1),
        valid_until=date(2099, 12, 31),
        technical_key=None,
        now=__import__("app.core.clock", fromlist=["now_utc"]).now_utc(),
    )
    db.commit()

    open_shift()
    identify(device_client, employees["cashier"])

    def _pay_one() -> Any:
        order_resp = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem_headers())
        order = order_resp.json()
        items_resp = device_client.post(
            f"/api/v1/orders/{order['id']}/items",
            json={"expected_version": order["version"], "items": [{"product_id": drink_product.id, "qty": 1}]},
            headers=idem_headers(),
        )
        order = items_resp.json()
        return device_client.post(
            f"/api/v1/orders/{order['id']}/payments",
            json={"pin": "1111", "tip": NO_TIP, "splits": [{"method": "cash", "amount": order["totals"]["total"]}]},
            headers=idem_headers(),
        )

    first = _pay_one()
    assert first.status_code == 201, first.text
    assert first.json()["document"]["number"] == 1

    second = _pay_one()
    assert second.status_code == 400, second.text
    assert second.json()["error"]["code"] == "FISCAL_RANGE_EXHAUSTED"


def test_rejected_payment_does_not_consume_a_validation_number(
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


def test_dian_status_starts_pending_and_evidence_null_before_the_provider_answers(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, drink_product: Any, db: Any
) -> None:
    """`PendingTransmissionProvider` (el proveedor real de esta fase) deja el
    documento `pending`, sin CUDE ni QR: nadie transmite nada todavía
    (SPEC-NEGOCIO §8.3)."""
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
    assert row.fiscal_range_id is not None  # 1b-2: ahora SÍ hay rango detrás
    assert row.validated_at is None
