"""Cobro en tablet: atajos de lo recibido, propina por canal y el papel en
palabras.

- `GET /payments/tender-suggestions`: «Exacto» y los billetes redondos
  siguientes los calcula el servidor; la pantalla sólo los pinta.
- Mostrador sin `pos.tips_counter`: el cobro no exige `tip.asked`.
- El comprobante dice «Mesa»/«Mostrador» y «C.C.», no `dine_in` ni «13», y
  marca el adquirente genérico como consumidor final.
"""

from __future__ import annotations

from typing import Any

from app.payments.service import tender_suggestions


def test_suggestions_are_the_next_round_bills_without_the_exact() -> None:
    assert tender_suggestions(131_200) == [132_000, 135_000, 140_000, 150_000]
    # Ya redondo a mil: el siguiente de mil ES el exacto y no se repite.
    assert tender_suggestions(131_000) == [135_000, 140_000, 150_000, 200_000]
    # Sin repetidos (10.000 y 20.000 dan lo mismo acá).
    assert tender_suggestions(12_500) == [13_000, 15_000, 20_000, 50_000]
    assert tender_suggestions(100_000) == []
    assert tender_suggestions(0) == []


def test_suggestions_over_http_need_the_device(client: Any, device_client: Any) -> None:
    assert client.get("/api/v1/payments/tender-suggestions?amount=131200").status_code == 401
    resp = device_client.get("/api/v1/payments/tender-suggestions?amount=131200")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "amount": 131_200,
        "exact": 131_200,
        "suggestions": [132_000, 135_000, 140_000, 150_000],
    }


def test_counter_without_tips_counter_charges_without_asking(
    counter_order_with_items: Any, pay: Any, set_feature: Any
) -> None:
    set_feature("pos.tips", True)
    set_feature("pos.tips_counter", False)
    order = counter_order_with_items()
    assert order["tip"] is None
    resp = pay(order, splits=[{"method": "cash", "amount": order["totals"]["total"]}])
    assert resp.status_code == 201, resp.text
    assert resp.json()["tip_amount"] == 0


def test_counter_with_tips_counter_still_requires_the_question(
    counter_order_with_items: Any, pay: Any, set_feature: Any
) -> None:
    set_feature("pos.tips", True)
    set_feature("pos.tips_counter", True)
    order = counter_order_with_items()
    resp = pay(order, splits=[{"method": "cash", "amount": order["totals"]["total"]}])
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "TIP_NOT_ASKED"


def test_document_speaks_in_words(device_client: Any, paid_order: Any) -> None:
    payment = paid_order(tip={"asked": True, "accepted": False, "modified": False, "amount": 0})
    doc = device_client.get(f"/api/v1/documents/{payment['document']['id']}").json()
    assert doc["order"]["channel"] == "counter"
    assert doc["order"]["channel_label"] == "Mostrador"
    assert doc["customer"]["final_consumer"] is True
    assert doc["customer"]["doc_type_label"] == "C.C."
