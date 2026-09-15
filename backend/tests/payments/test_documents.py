"""Forma de `DocumentPrintableOut`; leyenda y tipo según `fiscal.dee_pos`;
reimpresión contada; `GET /documents/last`; lista admin y `format=csv`; 404
cruzando sede/organización; ninguna respuesta de dispositivo con
`cost`/`margin`/`unit_cost`.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi.testclient import TestClient

from tests.payments.conftest import idem_headers

NO_TIP = {"asked": True, "accepted": False, "modified": False, "amount": 0}


def test_document_printable_shape_and_legend_pos_equivalent(
    device_client: TestClient, paid_order: Any
) -> None:
    payment = paid_order(tip=NO_TIP)
    document_id = payment["document"]["id"]

    resp = device_client.get(f"/api/v1/documents/{document_id}")
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["document_type"] == "pos_equivalent"
    assert body["dian_status"] == "pending"
    assert body["legend"] == "DOCUMENTO PENDIENTE DE TRANSMISIÓN A LA DIAN"
    assert body["full_number"].startswith("POS-")
    assert body["fiscal"] == {"range": None, "cude": None, "qr_url": None}
    assert body["customer"] == {"doc_type": "13", "doc_number": "222222222222", "name": "Consumidor final"}
    assert body["print_count"] == 1
    assert body["reprint_count"] == 0
    assert body["reprints"] == []
    assert isinstance(body["lines"], list) and len(body["lines"]) == 1
    assert body["order"]["charged_by"] == "Cashier"
    assert body["order"]["served_by"] == "Cashier"

    raw = json.dumps(body)
    for forbidden in ("\"cost\"", "\"margin\"", "\"unit_cost\""):
        assert forbidden not in raw


def test_document_type_and_legend_follow_fiscal_dee_pos_flag(
    device_client: TestClient, set_feature: Any, paid_order: Any
) -> None:
    set_feature("fiscal.dee_pos", False)
    payment = paid_order(tip=NO_TIP)
    document_id = payment["document"]["id"]

    resp = device_client.get(f"/api/v1/documents/{document_id}")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["document_type"] == "internal_receipt"
    assert body["dian_status"] is None
    assert body["legend"] == "COMPROBANTE INTERNO — no es factura ni documento equivalente"


def test_reprint_is_counted(device_client: TestClient, paid_order: Any) -> None:
    payment = paid_order(tip=NO_TIP)
    document_id = payment["document"]["id"]

    first = device_client.post(f"/api/v1/documents/{document_id}/reprint", headers=idem_headers())
    assert first.status_code == 200, first.text
    assert first.json()["reprint_count"] == 1
    assert len(first.json()["reprints"]) == 1
    assert first.json()["reprints"][0]["by"] == "Cashier"
    assert first.json()["print_count"] == 1  # nunca se toca: sólo cuenta reimpresiones

    second = device_client.post(f"/api/v1/documents/{document_id}/reprint", headers=idem_headers())
    assert second.status_code == 200, second.text
    assert second.json()["reprint_count"] == 2


def test_documents_last(device_client: TestClient, paid_order: Any) -> None:
    empty = device_client.get("/api/v1/documents/last")
    assert empty.status_code == 200, empty.text
    assert empty.json() is None

    payment = paid_order(tip=NO_TIP)
    last = device_client.get("/api/v1/documents/last")
    assert last.status_code == 200, last.text
    assert last.json()["id"] == payment["document"]["id"]


def test_admin_list_and_csv(admin_client: Any, store: Any, paid_order: Any) -> None:
    payment = paid_order(tip=NO_TIP)

    resp = admin_client.get(f"/api/v1/admin/documents?store_id={store.id}")
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert any(r["id"] == payment["document"]["id"] for r in rows)
    row = next(r for r in rows if r["id"] == payment["document"]["id"])
    assert row["full_number"] == payment["document"]["full_number"]
    assert row["charged_by"] == "Cashier"

    csv_resp = admin_client.get(f"/api/v1/admin/documents?store_id={store.id}&format=csv")
    assert csv_resp.status_code == 200, csv_resp.text
    assert csv_resp.headers["content-type"].startswith("text/csv")
    assert "full_number" in csv_resp.text


def test_document_404_across_stores(
    device_client: TestClient, admin_client: Any, paid_order: Any, store_b: Any, db: Any
) -> None:
    payment = paid_order(tip=NO_TIP)
    document_id = payment["document"]["id"]

    # Otro dispositivo, otra sede/organización: 404, nunca filtra por lista.
    from app.main import app

    other_device = TestClient(app)
    activate = other_device.post(
        "/api/v1/auth/device/activate", json={"store_id": store_b.id, "store_pin": "654321"}
    )
    assert activate.status_code == 200, activate.text
    resp = other_device.get(f"/api/v1/documents/{document_id}")
    assert resp.status_code == 404, resp.text
    assert resp.json()["error"]["code"] == "NOT_FOUND"


def test_openapi_device_responses_never_expose_cost_fields() -> None:
    from app.main import app

    schema = app.openapi()
    raw = json.dumps(schema)
    for forbidden in ("\"cost\"", "\"margin\"", "\"unit_cost\""):
        assert forbidden not in raw
