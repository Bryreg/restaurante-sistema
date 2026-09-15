"""`GET /shifts/{id}/tips` y `POST /admin/tips/payouts` (SPEC-NEGOCIO §6.2,
Ley 1935 de 2018)."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.stores.models import Store


def idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid.uuid4())}


def _make_product(db: Session, store: Store, *, price: int = 5000) -> int:
    from app.catalog.models import Category, Product
    from app.core import clock as clock_module

    now = clock_module.now_utc()
    category = Category(
        organization_id=store.organization_id, store_id=store.id, name="Bebidas", sort_order=0,
        default_course="beverage", default_station=None, active=True,
    )
    db.add(category)
    db.flush()
    product = Product(
        organization_id=store.organization_id, store_id=store.id, category_id=category.id, name="Gaseosa",
        description=None, station=None, default_course="beverage", price_dine_in=price, price_takeout=None,
        price_delivery=None, price_platform=None, tax_code="inc_8", active=True, available=True, daily_count=None,
        daily_remaining=None, unavailable_by_employee_id=None, unavailable_by_employee_name=None,
        unavailable_at=None, created_at=now, updated_at=now,
    )
    db.add(product)
    db.commit()
    db.refresh(product)
    return product.id


def _pay_with_tip(device_client: TestClient, product_id: int, *, method: str, tip_amount: int) -> Any:
    order = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem()).json()
    order = device_client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={"expected_version": order["version"], "items": [{"product_id": product_id, "qty": 1}]},
        headers=idem(),
    ).json()
    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/payments",
        json={
            "pin": "1111",
            "tip": {"asked": True, "accepted": tip_amount > 0, "modified": False, "amount": tip_amount},
            "splits": [{"method": method, "amount": order["totals"]["total"] + tip_amount}],
        },
        headers=idem(),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_shift_tips_by_method_by_employee_cash_out_and_electronic_liability(
    admin_client: TestClient,
    device_client: TestClient,
    identify: Any,
    employees: dict,
    open_shift: Any,
    db: Session,
    store: Store,
    set_feature: Any,
) -> None:
    set_feature("fiscal.dee_pos", False)  # evita depender de un FiscalRange vigente (territorio ajeno)
    product_id = _make_product(db, store)
    cashier = employees["cashier"]
    shift = open_shift(cash_responsible=cashier)
    identify(device_client, cashier)

    _pay_with_tip(device_client, product_id, method="cash", tip_amount=1000)
    _pay_with_tip(device_client, product_id, method="card", tip_amount=2000)

    resp = admin_client.get(f"/api/v1/shifts/{shift['id']}/tips")
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["by_method"]["cash"] == 1000
    assert body["by_method"]["card"] == 2000
    assert body["cash_out"] == 1000
    assert body["electronic_liability"] == 2000

    assert len(body["by_employee"]) == 1
    entry = body["by_employee"][0]
    assert entry["employee_id"] == cashier.id
    assert entry["cash"] == 1000
    assert entry["card"] == 2000
    assert entry["total"] == 3000


def test_tip_payout_registers_the_distribution(
    admin_client: TestClient,
    device_client: TestClient,
    identify: Any,
    employees: dict,
    open_shift: Any,
    db: Session,
    store: Store,
    set_feature: Any,
) -> None:
    set_feature("fiscal.dee_pos", False)
    product_id = _make_product(db, store)
    cashier = employees["cashier"]
    operator = employees["operator"]
    shift = open_shift(cash_responsible=cashier)
    identify(device_client, cashier)
    _pay_with_tip(device_client, product_id, method="cash", tip_amount=4000)

    resp = admin_client.post(
        f"/api/v1/admin/tips/payouts?store_id={store.id}",
        json={
            "shift_ids": [shift["id"]],
            "distribution": [{"employee_id": cashier.id, "amount": 2500}, {"employee_id": operator.id, "amount": 1500}],
            "paid_at": "2026-01-15T20:00:00Z",
            "method": "cash",
        },
        headers=idem(),
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["total_amount"] == 4000
    assert body["shift_ids"] == [shift["id"]]
    assert {d["employee_id"] for d in body["distribution"]} == {cashier.id, operator.id}


def test_tip_payout_with_unknown_employee_returns_404(
    admin_client: TestClient, open_shift: Any, employees: dict, store: Store
) -> None:
    shift = open_shift(cash_responsible=employees["cashier"])
    resp = admin_client.post(
        f"/api/v1/admin/tips/payouts?store_id={store.id}",
        json={
            "shift_ids": [shift["id"]],
            "distribution": [{"employee_id": 999999, "amount": 1000}],
            "paid_at": "2026-01-15T20:00:00Z",
            "method": "cash",
        },
        headers=idem(),
    )
    assert resp.status_code == 404, resp.text


def test_tip_payout_with_zero_total_is_rejected(
    admin_client: TestClient, open_shift: Any, employees: dict, store: Store
) -> None:
    shift = open_shift(cash_responsible=employees["cashier"])
    resp = admin_client.post(
        f"/api/v1/admin/tips/payouts?store_id={store.id}",
        json={
            "shift_ids": [shift["id"]],
            "distribution": [{"employee_id": employees["cashier"].id, "amount": 0}],
            "paid_at": "2026-01-15T20:00:00Z",
            "method": "cash",
        },
        headers=idem(),
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "TIP_PAYOUT_EMPTY"


def test_tip_payout_replays_with_the_same_idempotency_key(
    admin_client: TestClient, open_shift: Any, employees: dict, store: Store
) -> None:
    shift = open_shift(cash_responsible=employees["cashier"])
    headers = idem()
    payload = {
        "shift_ids": [shift["id"]],
        "distribution": [{"employee_id": employees["cashier"].id, "amount": 1000}],
        "paid_at": "2026-01-15T20:00:00Z",
        "method": "cash",
    }
    first = admin_client.post(f"/api/v1/admin/tips/payouts?store_id={store.id}", json=payload, headers=headers)
    second = admin_client.post(f"/api/v1/admin/tips/payouts?store_id={store.id}", json=payload, headers=headers)
    assert first.status_code == 201 and second.status_code == 201
    assert first.json() == second.json()
