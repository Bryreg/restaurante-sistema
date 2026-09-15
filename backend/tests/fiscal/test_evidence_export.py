"""`GET /admin/fiscal/documents/{id}/evidence` (XML/referencia, respuesta
del proveedor, hashes, CUDE, QR); `GET /admin/fiscal/export?from&to`
(paquete de evidencia con manifiesto y hashes, conservación 5 años,
SPEC-NEGOCIO §8.3); `POST /admin/fiscal/documents/{id}/retry` idempotente.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from app.fiscal import provider as fiscal_provider
from tests.payments.conftest import idem_headers

NO_TIP = {"asked": True, "accepted": False, "modified": False, "amount": 0}


def _pay(device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any) -> dict[str, Any]:
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


def test_evidence_has_content_hash_and_range_reference(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any, admin_client: Any
) -> None:
    document = _pay(device_client, identify, employees, open_shift, drink_product)
    resp = admin_client.get(f"/api/v1/admin/fiscal/documents/{document['id']}/evidence")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["content_hash"]
    assert len(body["content_hash"]) == 64  # sha256 hex
    assert body["range"]["prefix"] == "POS"
    assert body["dian_status"] == "pending"


def test_export_bundle_has_manifest_hash_and_per_document_hash(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any, admin_client: Any,
    store: Any, clock: Any,
) -> None:
    document = _pay(device_client, identify, employees, open_shift, drink_product)
    today = clock.now().date()
    resp = admin_client.get(
        f"/api/v1/admin/fiscal/export?store_id={store.id}&from={today.isoformat()}&to={today.isoformat()}"
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["manifest_hash"]
    assert body["document_count"] >= 1
    assert any(d["id"] == document["id"] for d in body["documents"])
    entry = next(d for d in body["documents"] if d["id"] == document["id"])
    assert entry["hash"]


def test_retry_is_idempotent_and_reapplies_the_provider_outcome(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any, admin_client: Any
) -> None:
    document = _pay(device_client, identify, employees, open_shift, drink_product)
    try:
        fiscal_provider.set_provider_override(fiscal_provider.FakeProvider(outcome="validate"))
        key = idem_headers()
        first = admin_client.post(f"/api/v1/admin/fiscal/documents/{document['id']}/retry", headers=key)
        assert first.status_code == 200, first.text
        assert first.json()["dian_status"] == "validated"

        second = admin_client.post(f"/api/v1/admin/fiscal/documents/{document['id']}/retry", headers=key)
        assert second.status_code == 200, second.text
        assert first.json() == second.json()
    finally:
        fiscal_provider.set_provider_override(None)


def test_retry_on_internal_receipt_is_not_applicable(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any, admin_client: Any,
    set_feature: Any,
) -> None:
    set_feature("fiscal.dee_pos", False)
    document = _pay(device_client, identify, employees, open_shift, drink_product)
    assert document["document_type"] == "internal_receipt"

    resp = admin_client.post(f"/api/v1/admin/fiscal/documents/{document['id']}/retry", headers=idem_headers())
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FISCAL_RETRY_NOT_APPLICABLE"
