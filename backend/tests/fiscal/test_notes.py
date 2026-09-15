"""`POST /admin/documents/{id}/notes`: consecutivo propio de su propio rango;
el original queda `reversed`; `adjustment_note` sólo corrige `pos_equivalent`
(`credit_note`/`debit_note` sólo `invoice`) — el par equivocado es `400
NOTE_KIND_MISMATCH`; el gancho de devolución (`app.refunds.hooks
.settle_or_queue_refund`) se invoca cuando la nota trae `refund`. El test de
punta a punta del COMPORTAMIENTO del gancho (qué turno recibe el egreso,
cuándo queda pendiente) es de `app.refunds` — acá se prueba que nace con su
consecutivo, que el original queda `reversed` y que el gancho se llamó
(`refund_status` en la respuesta).
"""

from __future__ import annotations

from typing import Any

from tests.payments.conftest import idem_headers

NO_TIP = {"asked": True, "accepted": False, "modified": False, "amount": 0}

CONSENT = {"text_version": "v1", "channel": "pos"}


def _pay_pos_equivalent(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any
) -> dict[str, Any]:
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


def _pay_invoice(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, main_product: Any
) -> dict[str, Any]:
    open_shift()
    identify(device_client, employees["cashier"])
    order_resp = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem_headers())
    order = order_resp.json()
    items_resp = device_client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={"expected_version": order["version"], "items": [{"product_id": main_product.id, "qty": 1}]},
        headers=idem_headers(),
    )
    order = items_resp.json()
    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/payments",
        json={
            "pin": "1111",
            "tip": NO_TIP,
            "splits": [{"method": "cash", "amount": order["totals"]["total"]}],
            "requests_invoice": True,
            "customer": {
                "doc_type": "13",
                "doc_number": "1010101010",
                "name": "Cliente de prueba",
                "email": "cliente@test.local",
                "consent": CONSENT,
            },
        },
        headers=idem_headers(),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["document"]


def test_adjustment_note_on_pos_equivalent_reverses_original_and_gets_own_consecutive(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any, admin_client: Any, db: Any
) -> None:
    document = _pay_pos_equivalent(device_client, identify, employees, open_shift, drink_product)

    printable = device_client.get(f"/api/v1/documents/{document['id']}")
    item_id = printable.json()["lines"][0]["item_id"]

    resp = admin_client.post(
        f"/api/v1/admin/documents/{document['id']}/notes",
        json={
            "kind": "adjustment",
            "reason": "Precio mal cobrado",
            "lines": [{"item_id": item_id, "used": True}],
        },
        headers=idem_headers(),
    )
    assert resp.status_code == 201, resp.text
    note = resp.json()
    assert note["document_type"] == "adjustment_note"
    assert note["number"] == 1  # rango propio: NA, arranca en 1 aunque POS ya vaya por 1+
    assert note["reverses_document_id"] == document["id"]
    assert note["total"] == printable.json()["total"]
    assert note["refund_status"] is None  # sin `refund` en el body

    from app.fiscal.models import FiscalDocument

    original_row = db.get(FiscalDocument, document["id"])
    assert original_row.status == "reversed"


def test_note_kind_mismatch_adjustment_on_invoice_is_400(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, main_product: Any, admin_client: Any,
    set_feature: Any,
) -> None:
    set_feature("fiscal.invoice", True)
    document = _pay_invoice(device_client, identify, employees, open_shift, main_product)
    resp = admin_client.post(
        f"/api/v1/admin/documents/{document['id']}/notes",
        json={"kind": "adjustment", "reason": "no aplica", "lines": [{"item_id": 1, "used": True}]},
        headers=idem_headers(),
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "NOTE_KIND_MISMATCH"


def test_note_kind_mismatch_credit_on_pos_equivalent_is_400(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any, admin_client: Any
) -> None:
    document = _pay_pos_equivalent(device_client, identify, employees, open_shift, drink_product)
    resp = admin_client.post(
        f"/api/v1/admin/documents/{document['id']}/notes",
        json={"kind": "credit", "reason": "no aplica", "lines": [{"item_id": 1, "used": True}]},
        headers=idem_headers(),
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "NOTE_KIND_MISMATCH"


def test_credit_note_on_invoice_has_its_own_range_and_reverses_original(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, main_product: Any, admin_client: Any,
    set_feature: Any, db: Any,
) -> None:
    set_feature("fiscal.invoice", True)
    document = _pay_invoice(device_client, identify, employees, open_shift, main_product)
    assert document["document_type"] == "invoice"

    printable = device_client.get(f"/api/v1/documents/{document['id']}")
    item_id = printable.json()["lines"][0]["item_id"]

    resp = admin_client.post(
        f"/api/v1/admin/documents/{document['id']}/notes",
        json={"kind": "credit", "reason": "Devolución del cliente", "lines": [{"item_id": item_id, "used": True}]},
        headers=idem_headers(),
    )
    assert resp.status_code == 201, resp.text
    note = resp.json()
    assert note["document_type"] == "credit_note"
    assert note["prefix"] != document["prefix"]

    from app.fiscal.models import FiscalDocument

    assert db.get(FiscalDocument, document["id"]).status == "reversed"


def test_note_twice_on_the_same_document_is_400(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any, admin_client: Any
) -> None:
    document = _pay_pos_equivalent(device_client, identify, employees, open_shift, drink_product)
    printable = device_client.get(f"/api/v1/documents/{document['id']}")
    item_id = printable.json()["lines"][0]["item_id"]
    body = {"kind": "adjustment", "reason": "primera", "lines": [{"item_id": item_id, "used": True}]}

    first = admin_client.post(
        f"/api/v1/admin/documents/{document['id']}/notes", json=body, headers=idem_headers()
    )
    assert first.status_code == 201, first.text

    second = admin_client.post(
        f"/api/v1/admin/documents/{document['id']}/notes",
        json={**body, "reason": "segunda"},
        headers=idem_headers(),
    )
    assert second.status_code == 400, second.text
    assert second.json()["error"]["code"] == "DOCUMENT_ALREADY_REVERSED"


def test_note_with_refund_settles_in_the_open_shift(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any, admin_client: Any
) -> None:
    """El turno que abrió `_pay_pos_equivalent` sigue abierto: el egreso
    `refund` de `app.refunds.hooks.settle_or_queue_refund` se crea ahí
    (`RefundOutcome.status == "settled_in_shift"`) — se prueba que el gancho
    SE LLAMÓ con los datos de la nota; el comportamiento fino es de su
    dueño."""
    document = _pay_pos_equivalent(device_client, identify, employees, open_shift, drink_product)
    printable = device_client.get(f"/api/v1/documents/{document['id']}")
    item_id = printable.json()["lines"][0]["item_id"]

    resp = admin_client.post(
        f"/api/v1/admin/documents/{document['id']}/notes",
        json={
            "kind": "adjustment",
            "reason": "Devolución en efectivo",
            "lines": [{"item_id": item_id, "used": True}],
            "refund": {"method": "cash", "amount": printable.json()["total"]},
        },
        headers=idem_headers(),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["refund_status"] == "settled_in_shift"


def test_admin_notes_listing_and_csv(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any, admin_client: Any, store: Any
) -> None:
    document = _pay_pos_equivalent(device_client, identify, employees, open_shift, drink_product)
    printable = device_client.get(f"/api/v1/documents/{document['id']}")
    item_id = printable.json()["lines"][0]["item_id"]
    admin_client.post(
        f"/api/v1/admin/documents/{document['id']}/notes",
        json={"kind": "adjustment", "reason": "listado", "lines": [{"item_id": item_id, "used": True}]},
        headers=idem_headers(),
    )

    resp = admin_client.get(f"/api/v1/admin/notes?store_id={store.id}")
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert any(r["reverses_document_id"] == document["id"] for r in rows)

    csv_resp = admin_client.get(f"/api/v1/admin/notes?store_id={store.id}&format=csv")
    assert csv_resp.status_code == 200, csv_resp.text
    assert csv_resp.headers["content-type"].startswith("text/csv")


def test_note_idempotency_key_replays_same_response(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any, admin_client: Any
) -> None:
    document = _pay_pos_equivalent(device_client, identify, employees, open_shift, drink_product)
    printable = device_client.get(f"/api/v1/documents/{document['id']}")
    item_id = printable.json()["lines"][0]["item_id"]
    body = {"kind": "adjustment", "reason": "idempotente", "lines": [{"item_id": item_id, "used": True}]}
    headers = idem_headers()

    first = admin_client.post(f"/api/v1/admin/documents/{document['id']}/notes", json=body, headers=headers)
    assert first.status_code == 201, first.text
    second = admin_client.post(f"/api/v1/admin/documents/{document['id']}/notes", json=body, headers=headers)
    assert second.status_code == 201, second.text
    assert first.json() == second.json()
