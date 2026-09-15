"""División de cuenta al cobrar: «partes iguales» = un documento con N pagos;
«por ítems» = N sub-cuentas, cada una con su propio documento y consecutivos
seguidos, con Σ totales == total de la comanda (invariante §5.2 del contrato).
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.payments.conftest import idem_headers

NO_TIP = {"asked": True, "accepted": False, "modified": False, "amount": 0}


def test_equal_split_produces_one_document_with_n_payments(
    device_client: TestClient, counter_order_with_items: Any, pay: Any
) -> None:
    order = counter_order_with_items(qty=3)  # 3 x $5.000 = $15.000
    total = order["totals"]["total"]
    half = total // 2
    resp = pay(order, tip=NO_TIP, splits=[{"method": "cash", "amount": half}, {"method": "card", "amount": total - half}])
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["document"] is not None

    doc = device_client.get(f"/api/v1/documents/{body['document']['id']}")
    assert doc.status_code == 200, doc.text
    payments = doc.json()["payments"]
    assert len(payments) == 2
    assert {p["method"] for p in payments} == {"cash", "card"}
    assert sum(p["amount"] for p in payments) == total


def test_items_split_produces_n_sub_account_documents_with_sequential_numbers(
    device_client: TestClient,
    identify: Any,
    employees: Any,
    open_shift: Any,
    main_product: Any,
    drink_product: Any,
    pay: Any,
) -> None:
    open_shift()
    identify(device_client, employees["cashier"])
    order_resp = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem_headers())
    order = order_resp.json()
    items_resp = device_client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={
            "expected_version": order["version"],
            "items": [{"product_id": main_product.id, "qty": 1}, {"product_id": drink_product.id, "qty": 2}],
        },
        headers=idem_headers(),
    )
    order = items_resp.json()
    main_item = next(i for i in order["items"] if i["product_id"] == main_product.id)
    drink_item = next(i for i in order["items"] if i["product_id"] == drink_product.id)

    split_resp = device_client.post(
        f"/api/v1/orders/{order['id']}/bill/split",
        json={
            "expected_version": order["version"],
            "mode": "items",
            "groups": [
                {"label": "Persona 1", "item_ids": [main_item["id"]], "shared": [{"item_id": drink_item["id"], "portions": 1}]},
                {"label": "Persona 2", "item_ids": [], "shared": [{"item_id": drink_item["id"], "portions": 1}]},
            ],
        },
        headers=idem_headers(),
    )
    assert split_resp.status_code == 200, split_resp.text
    sub_accounts = split_resp.json()["sub_accounts"]
    assert len(sub_accounts) == 2

    order_total = device_client.get(f"/api/v1/orders/{order['id']}").json()["totals"]["total"]

    document_numbers: list[int] = []
    document_totals: list[int] = []
    for sub_account in sub_accounts:
        resp = pay(
            order,
            tip=NO_TIP,
            sub_account_id=sub_account["id"],
            splits=[{"method": "cash", "amount": sub_account["totals"]["total"]}],
        )
        assert resp.status_code == 201, resp.text
        document = resp.json()["document"]
        assert document is not None
        document_numbers.append(document["number"])
        document_totals.append(resp.json()["total"])

    assert sum(document_totals) == order_total  # invariante #2 del contrato
    assert document_numbers[1] == document_numbers[0] + 1  # consecutivos seguidos
    assert len(set(document_numbers)) == 2

    final_order = device_client.get(f"/api/v1/orders/{order['id']}").json()
    assert final_order["status"] == "paid"


def test_sub_account_required_when_order_is_split(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, main_product: Any, pay: Any
) -> None:
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
    main_item = order["items"][0]

    split_resp = device_client.post(
        f"/api/v1/orders/{order['id']}/bill/split",
        json={"expected_version": order["version"], "mode": "items", "groups": [{"item_ids": [main_item["id"]]}]},
        headers=idem_headers(),
    )
    assert split_resp.status_code == 200, split_resp.text

    resp = pay(order, tip=NO_TIP, splits=[{"method": "cash", "amount": order["totals"]["total"]}])
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "SUB_ACCOUNT_REQUIRED"


def test_sub_account_already_paid(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, main_product: Any, drink_product: Any, pay: Any
) -> None:
    open_shift()
    identify(device_client, employees["cashier"])
    order_resp = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem_headers())
    order = order_resp.json()
    items_resp = device_client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={
            "expected_version": order["version"],
            "items": [{"product_id": main_product.id, "qty": 1}, {"product_id": drink_product.id, "qty": 1}],
        },
        headers=idem_headers(),
    )
    order = items_resp.json()
    main_item = next(i for i in order["items"] if i["product_id"] == main_product.id)
    drink_item = next(i for i in order["items"] if i["product_id"] == drink_product.id)

    split_resp = device_client.post(
        f"/api/v1/orders/{order['id']}/bill/split",
        json={
            "expected_version": order["version"],
            "mode": "items",
            "groups": [{"item_ids": [main_item["id"]]}, {"item_ids": [drink_item["id"]]}],
        },
        headers=idem_headers(),
    )
    sub_account = split_resp.json()["sub_accounts"][0]

    first = pay(order, tip=NO_TIP, sub_account_id=sub_account["id"], splits=[{"method": "cash", "amount": sub_account["totals"]["total"]}])
    assert first.status_code == 201, first.text

    second = pay(order, tip=NO_TIP, sub_account_id=sub_account["id"], splits=[{"method": "cash", "amount": sub_account["totals"]["total"]}])
    assert second.status_code in (400, 409), second.text
    assert second.json()["error"]["code"] == "SUB_ACCOUNT_ALREADY_PAID"
