"""Factura electrónica automática por umbral UVT (SPEC-NEGOCIO §8.3);
`400 CUSTOMER_REQUIRED_FOR_INVOICE`; `fiscal.invoice` apagada probada
encendida y apagada; y A-10 (`amount_due` siempre sumado por el servidor,
`outputs-1b-1/auditor-venta.md §3`)."""

from __future__ import annotations

from typing import Any

from tests.payments.conftest import idem_headers

NO_TIP = {"asked": True, "accepted": False, "modified": False, "amount": 0}
CONSENT = {"text_version": "v1", "channel": "pos"}
CUSTOMER = {
    "doc_type": "13",
    "doc_number": "5050505050",
    "name": "Cliente identificado",
    "consent": CONSENT,
}


def _create_and_add_item(device_client: Any, product_id: int) -> dict[str, Any]:
    order_resp = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem_headers())
    order = order_resp.json()
    items_resp = device_client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={"expected_version": order["version"], "items": [{"product_id": product_id, "qty": 1}]},
        headers=idem_headers(),
    )
    return items_resp.json()


def _set_low_uvt_threshold(admin_client: Any, store: Any, year: int) -> None:
    settings = admin_client.get(f"/api/v1/admin/stores/{store.id}/sales-settings").json()
    settings["invoice_threshold_uvt"] = 1
    resp = admin_client.put(f"/api/v1/admin/stores/{store.id}/sales-settings", json=settings)
    assert resp.status_code == 200, resp.text

    uvt_resp = admin_client.put("/api/v1/admin/uvt", json=[{"year": year, "value": 1000}])
    assert uvt_resp.status_code == 200, uvt_resp.text


def test_invoice_issued_automatically_over_the_uvt_threshold_when_customer_identified(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, main_product: Any, admin_client: Any,
    store: Any, clock: Any,
) -> None:
    _set_low_uvt_threshold(admin_client, store, clock.now().year)
    open_shift()
    identify(device_client, employees["cashier"])
    order = _create_and_add_item(device_client, main_product.id)

    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/payments",
        json={
            "pin": "1111",
            "tip": NO_TIP,
            "splits": [{"method": "cash", "amount": order["totals"]["total"]}],
            "customer": CUSTOMER,
        },
        headers=idem_headers(),
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["document"]["document_type"] == "invoice"
    assert body["requires_invoice"] is True


def test_invoice_over_threshold_without_identified_customer_is_400(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, main_product: Any, admin_client: Any,
    store: Any, clock: Any,
) -> None:
    _set_low_uvt_threshold(admin_client, store, clock.now().year)
    open_shift()
    identify(device_client, employees["cashier"])
    order = _create_and_add_item(device_client, main_product.id)

    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/payments",
        json={"pin": "1111", "tip": NO_TIP, "splits": [{"method": "cash", "amount": order["totals"]["total"]}]},
        headers=idem_headers(),
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "CUSTOMER_REQUIRED_FOR_INVOICE"


def test_requests_invoice_creates_invoice_even_under_the_threshold(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any
) -> None:
    open_shift()
    identify(device_client, employees["cashier"])
    order = _create_and_add_item(device_client, drink_product.id)

    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/payments",
        json={
            "pin": "1111",
            "tip": NO_TIP,
            "splits": [{"method": "cash", "amount": order["totals"]["total"]}],
            "customer": CUSTOMER,
            "requests_invoice": True,
        },
        headers=idem_headers(),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["document"]["document_type"] == "invoice"


def test_fiscal_invoice_feature_disabled_blocks_the_explicit_request(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, drink_product: Any, set_feature: Any
) -> None:
    set_feature("fiscal.invoice", False)
    open_shift()
    identify(device_client, employees["cashier"])
    order = _create_and_add_item(device_client, drink_product.id)

    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/payments",
        json={
            "pin": "1111",
            "tip": NO_TIP,
            "splits": [{"method": "cash", "amount": order["totals"]["total"]}],
            "customer": CUSTOMER,
            "requests_invoice": True,
        },
        headers=idem_headers(),
    )
    assert resp.status_code == 400, resp.text
    body = resp.json()
    assert body["error"]["code"] == "FEATURE_DISABLED"
    assert body["error"]["feature"] == "fiscal.invoice"


def test_fiscal_invoice_feature_enabled_lets_the_threshold_apply(
    device_client: Any, identify: Any, employees: Any, open_shift: Any, main_product: Any, admin_client: Any,
    store: Any, clock: Any, set_feature: Any,
) -> None:
    set_feature("fiscal.invoice", True)
    _set_low_uvt_threshold(admin_client, store, clock.now().year)
    open_shift()
    identify(device_client, employees["cashier"])
    order = _create_and_add_item(device_client, main_product.id)

    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/payments",
        json={
            "pin": "1111",
            "tip": NO_TIP,
            "splits": [{"method": "cash", "amount": order["totals"]["total"]}],
            "customer": CUSTOMER,
        },
        headers=idem_headers(),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["document"]["document_type"] == "invoice"


def test_amount_due_is_always_present_and_summed_by_the_server(
    counter_order_with_items: Any, pay: Any
) -> None:
    order = counter_order_with_items(qty=1)  # total = 5000
    resp = pay(
        order,
        tip={"asked": True, "accepted": True, "modified": False, "amount": 700},
        splits=[{"method": "cash", "amount": 5700}],
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert "amount_due" in body
    assert body["amount_due"] == body["total"] + body["tip_amount"]
    assert body["amount_due"] == 5700


def test_amount_due_with_no_tip_equals_total(counter_order_with_items: Any, pay: Any) -> None:
    order = counter_order_with_items(qty=1)
    resp = pay(order, tip=NO_TIP, splits=[{"method": "cash", "amount": order["totals"]["total"]}])
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["amount_due"] == body["total"] == order["totals"]["total"]
