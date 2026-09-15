"""`POST /orders/{id}/payments`: el flujo feliz (pendientes -> `sent_at_payment`,
comanda `paid`, mesas liberadas), efectivo con cambio, pago mixto con propina
por medio, `staff_meal` en cero, flags (`pos.tips`, `kitchen.view`) y los
códigos de error de §4 del contrato interno.

Dueño del test de punta a punta del hook `pay_order ->
orders.service.{assert_payable, compute_*_totals, auto_send_pending_for_payment,
claim_payment, business_date_for_sale}` (`CONTRATO-INTERNO-1b-1.md §2.5`):
este archivo.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.payments.conftest import idem_headers

# `pos.tips` está encendida por default (perfil "full" del `org` de
# `tests/conftest.py`): todo pago sobre un canal ≠ `staff_meal` exige
# `tip.asked` (`TIP_NOT_ASKED`, `CONTRATO-INTERNO-1b-1.md §2.4`). Los tests
# que no ejercitan la propina en sí mandan esta respuesta neutra (se preguntó,
# no se aceptó, monto 0).
NO_TIP = {"asked": True, "accepted": False, "modified": False, "amount": 0}


def test_pending_items_get_sent_at_payment_and_order_paid(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, main_product: Any, drink_product: Any
) -> None:
    open_shift()
    identify(device_client, employees["cashier"])
    order_resp = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem_headers())
    order = order_resp.json()
    items_resp = device_client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={
            "expected_version": order["version"],
            "items": [
                {"product_id": main_product.id, "qty": 1},  # con estación: queda `sent`
                {"product_id": drink_product.id, "qty": 1},  # sin estación: pasa directo a `served`
            ],
        },
        headers=idem_headers(),
    )
    order = items_resp.json()
    assert all(i["status"] == "pending" for i in order["items"])

    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/payments",
        json={"pin": "1111", "tip": NO_TIP, "splits": [{"method": "cash", "amount": order["totals"]["total"]}]},
        headers=idem_headers(),
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["order"]["status"] == "paid"
    assert body["order"]["paid_at"] is not None
    items_by_product = {i["product_id"]: i for i in body["order"]["items"]}
    assert items_by_product[main_product.id]["status"] == "sent"
    assert items_by_product[main_product.id]["sent_at_payment"] is True
    assert items_by_product[drink_product.id]["status"] == "served"
    assert items_by_product[drink_product.id]["sent_at_payment"] is True
    assert body["document"] is not None
    assert body["document"]["dian_status"] == "pending"
    assert body["change"] == 0


def test_dine_in_pay_releases_tables(dine_in_order_with_items: Any, pay: Any) -> None:
    # `pay` y `dine_in_order_with_items` comparten el mismo `device_client`
    # (fixture de alcance por test): la persona ya identificada por
    # `dine_in_order_with_items` sigue siendo la actora del cobro.
    order = dine_in_order_with_items()
    assert len(order["tables"]) == 1

    resp = pay(order, tip=NO_TIP, splits=[{"method": "cash", "amount": order["totals"]["total"]}])
    assert resp.status_code == 201, resp.text
    assert resp.json()["order"]["tables"] == []


def test_cash_with_change(counter_order_with_items: Any, pay: Any) -> None:
    order = counter_order_with_items(qty=1)  # total = 5000
    resp = pay(order, tip=NO_TIP, splits=[{"method": "cash", "amount": 5000, "tendered": 10000}])
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["change"] == 5000


def test_mixed_cash_card_with_tip_assigned_per_method(counter_order_with_items: Any, pay: Any) -> None:
    order = counter_order_with_items(qty=1)  # total = 5000
    resp = pay(
        order,
        tip={"asked": True, "accepted": True, "modified": False, "amount": 500},
        splits=[{"method": "cash", "amount": 3000}, {"method": "card", "amount": 2500}],
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["tip_amount"] == 500
    assert body["total"] == 5000
    # el detalle de qué medio cubrió cuánta propina vive en el documento
    # (`Payment.amount`/`Payment.tip_amount` por split); se revisa en
    # `tests/payments/test_documents.py`.


def test_total_zero_staff_meal_has_no_document(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, drink_product: Any
) -> None:
    open_shift()
    identify(device_client, employees["cashier"])
    order_resp = device_client.post(
        "/api/v1/orders",
        json={"channel": "staff_meal", "consumed_by_employee_id": employees["operator"].id},
        headers=idem_headers(),
    )
    assert order_resp.status_code == 201, order_resp.text
    order = order_resp.json()
    items_resp = device_client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={"expected_version": order["version"], "items": [{"product_id": drink_product.id, "qty": 1}]},
        headers=idem_headers(),
    )
    order = items_resp.json()
    assert order["totals"]["total"] == 0
    assert order["tip"] is None

    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/payments",
        json={"pin": "1111", "splits": []},
        headers=idem_headers(),
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["document"] is None
    assert body["total"] == 0
    assert body["tip_amount"] == 0
    assert body["order"]["status"] == "paid"


def test_pos_tips_disabled_does_not_require_tip(
    counter_order_with_items: Any, pay: Any, set_feature: Any
) -> None:
    set_feature("pos.tips", False)
    order = counter_order_with_items(qty=1)
    resp = pay(order, splits=[{"method": "cash", "amount": order["totals"]["total"]}])
    assert resp.status_code == 201, resp.text
    assert resp.json()["tip_amount"] == 0


def test_cannot_charge(counter_order_with_items: Any, pay: Any, employees: Any) -> None:
    order = counter_order_with_items(opened_by="operator")
    resp = pay(order, pin="2222", tip=NO_TIP, splits=[{"method": "cash", "amount": order["totals"]["total"]}])
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "CANNOT_CHARGE"


def test_pin_invalid(counter_order_with_items: Any, pay: Any) -> None:
    order = counter_order_with_items()
    resp = pay(order, pin="0000", tip=NO_TIP, splits=[{"method": "cash", "amount": order["totals"]["total"]}])
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "PIN_INVALID"


def test_splits_do_not_match(counter_order_with_items: Any, pay: Any) -> None:
    order = counter_order_with_items()
    resp = pay(order, tip=NO_TIP, splits=[{"method": "cash", "amount": 1}])
    assert resp.status_code == 400, resp.text
    body = resp.json()
    assert body["error"]["code"] == "SPLITS_DO_NOT_MATCH"
    assert body["error"]["expected"] == order["totals"]["total"]
    assert body["error"]["received"] == 1


def test_payment_method_invalid(counter_order_with_items: Any, pay: Any) -> None:
    order = counter_order_with_items()
    resp = pay(order, tip=NO_TIP, splits=[{"method": "bitcoin", "amount": order["totals"]["total"]}])
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "PAYMENT_METHOD_INVALID"


def test_payment_reference_required(counter_order_with_items: Any, pay: Any) -> None:
    order = counter_order_with_items()
    resp = pay(order, tip=NO_TIP, splits=[{"method": "transfer", "amount": order["totals"]["total"]}])
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "PAYMENT_REFERENCE_REQUIRED"

    resp2 = pay(
        order, tip=NO_TIP, splits=[{"method": "transfer", "amount": order["totals"]["total"], "reference": "ABC123"}]
    )
    assert resp2.status_code == 201, resp2.text


def test_change_only_on_cash(counter_order_with_items: Any, pay: Any) -> None:
    order = counter_order_with_items()
    resp = pay(
        order, tip=NO_TIP, splits=[{"method": "card", "amount": order["totals"]["total"], "tendered": 100000}]
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "CHANGE_ONLY_ON_CASH"


def test_tendered_too_low(counter_order_with_items: Any, pay: Any) -> None:
    order = counter_order_with_items()
    total = order["totals"]["total"]
    resp = pay(order, tip=NO_TIP, splits=[{"method": "cash", "amount": total, "tendered": total - 1}])
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "TENDERED_TOO_LOW"


def test_tip_not_asked(counter_order_with_items: Any, pay: Any) -> None:
    order = counter_order_with_items()
    resp = pay(order, splits=[{"method": "cash", "amount": order["totals"]["total"]}])
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "TIP_NOT_ASKED"


def test_kitchen_view_disabled_marks_items_served(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, main_product: Any
) -> None:
    set_feature("kitchen.view", False)  # apagar ANTES de crear la comanda: `kitchen_view_enabled` es snapshot
    open_shift()
    identify(device_client, employees["cashier"])
    order_resp = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem_headers())
    order = order_resp.json()
    assert order["kitchen_view_enabled"] is False
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
        },
        headers=idem_headers(),
    )
    assert resp.status_code == 201, resp.text
    item = resp.json()["order"]["items"][0]
    assert item["status"] == "served"
    assert item["sent_at_payment"] is True
