"""`GET /shifts/{id}/tips` y `POST /admin/tips/payouts` (SPEC-NEGOCIO §6.2,
Ley 1935 de 2018)."""

from __future__ import annotations

import uuid
from typing import Any

import pytest
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


@pytest.fixture()
def shift_with_tip(
    device_client: TestClient, identify: Any, employees: dict, open_shift: Any, db: Session, store: Store, set_feature: Any
) -> Any:
    """Un turno abierto con `amount` de propina cobrada por datáfono: desde c3
    un reparto no puede entregar más de lo que se recogió, así que todo test
    que reparte necesita propina de verdad."""

    def _make(amount: int) -> dict:
        set_feature("fiscal.dee_pos", False)
        product_id = _make_product(db, store)
        cashier = employees["cashier"]
        shift = open_shift(cash_responsible=cashier)
        identify(device_client, cashier)
        _pay_with_tip(device_client, product_id, method="card", tip_amount=amount)
        return shift

    return _make


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
    admin_client: TestClient, shift_with_tip: Any, employees: dict, store: Store
) -> None:
    shift = shift_with_tip(1000)
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


def test_tip_payout_accepts_the_wall_clock_hour_the_screen_sends(
    admin_client: TestClient, shift_with_tip: Any, employees: dict, store: Store, db: Session
) -> None:
    """`TipsTab.tsx` manda `paid_at` desde un `<input type="datetime-local">`:
    `"2026-01-15T15:00"`, sin zona. Antes se guardaba naive y la columna
    `UTCDateTime` lo rechazaba con un `500` (lo encontró `python -m app.demo`
    registrando el reparto como lo hace la pantalla). La zona la pone el
    servidor: las 15:00 de Bogotá son las 20:00 UTC."""
    from app.shifts.models import TipPayout

    shift = shift_with_tip(1500)
    resp = admin_client.post(
        f"/api/v1/admin/tips/payouts?store_id={store.id}",
        json={
            "shift_ids": [shift["id"]],
            "distribution": [{"employee_id": employees["operator"].id, "amount": 1500}],
            "paid_at": "2026-01-15T15:00",
            "method": "cash",
        },
        headers=idem(),
    )
    assert resp.status_code == 201, resp.text
    stored = db.get(TipPayout, resp.json()["id"])
    assert stored is not None
    assert stored.paid_at.isoformat().startswith("2026-01-15T20:00")


# ---------------------------------------------------------------------------
# c3 — historial, reversa, recogido vs. entregado vs. pendiente (Ley 1935).
# ---------------------------------------------------------------------------


def _payout(
    admin_client: TestClient, store: Store, shift_ids: list[int], lines: list[tuple[int, int]], **extra: Any
) -> Any:
    return admin_client.post(
        f"/api/v1/admin/tips/payouts?store_id={store.id}",
        json={
            "shift_ids": shift_ids,
            "distribution": [{"employee_id": eid, "amount": amount} for eid, amount in lines],
            "paid_at": "2026-01-15T15:00",
            "method": "cash",
            **extra,
        },
        headers=idem(),
    )


def _close_by_orm(db: Session, shift_id: int) -> str:
    """Cierra el turno por ORM y devuelve su fecha de negocio: lo que se
    prueba acá es la lectura del balance, no el cierre a ciegas (que tiene su
    propia suite)."""
    from app.shifts.models import BusinessDay, Shift, ShiftStatus

    row = db.get(Shift, shift_id)
    assert row is not None
    row.status = ShiftStatus.CLOSED
    db.commit()
    day = db.get(BusinessDay, row.business_day_id)
    assert day is not None
    return day.business_date.isoformat()


def test_a_payout_cannot_deliver_more_than_what_is_pending(
    admin_client: TestClient, shift_with_tip: Any, employees: dict, store: Store
) -> None:
    """Pagar el mismo turno dos veces, o más de lo recogido, se rechaza con
    un `400` que nombra lo que queda pendiente."""
    shift = shift_with_tip(4000)
    cashier = employees["cashier"].id

    too_much = _payout(admin_client, store, [shift["id"]], [(cashier, 4001)])
    assert too_much.status_code == 400, too_much.text
    assert too_much.json()["error"]["code"] == "TIP_PAYOUT_EXCEEDS_PENDING"

    first = _payout(admin_client, store, [shift["id"]], [(cashier, 2500)])
    assert first.status_code == 201, first.text

    again = _payout(admin_client, store, [shift["id"], shift["id"]], [(cashier, 2500)])
    assert again.status_code == 400, again.text
    assert again.json()["error"]["code"] == "TIP_PAYOUT_EXCEEDS_PENDING"
    assert "1.500" in again.json()["error"]["message"]

    rest = _payout(admin_client, store, [shift["id"]], [(cashier, 1500)])
    assert rest.status_code == 201, rest.text

    nothing_left = _payout(admin_client, store, [shift["id"]], [(cashier, 1)])
    assert nothing_left.status_code == 400
    assert nothing_left.json()["error"]["code"] == "TIP_PAYOUT_EXCEEDS_PENDING"


def test_reversing_a_payout_keeps_it_in_history_and_frees_the_pending(
    admin_client: TestClient, shift_with_tip: Any, employees: dict, store: Store, db: Session
) -> None:
    from sqlalchemy import select

    from app.audit.models import AuditLog

    shift = shift_with_tip(3000)
    cashier = employees["cashier"].id
    created = _payout(admin_client, store, [shift["id"]], [(cashier, 3000)])
    assert created.status_code == 201, created.text
    payout_id = created.json()["id"]
    url = f"/api/v1/admin/tips/payouts/{payout_id}/reverse?store_id={store.id}"

    no_reason = admin_client.post(url, json={"reason": ""}, headers=idem())
    assert no_reason.status_code in (400, 422)

    headers = idem()
    reversed_ = admin_client.post(url, json={"reason": "Se cargó con el monto equivocado"}, headers=headers)
    assert reversed_.status_code == 200, reversed_.text
    body = reversed_.json()
    assert body["reversed_at"] is not None
    assert body["reversed_reason"] == "Se cargó con el monto equivocado"
    assert body["reversed_by"]["id"] is not None

    # Reintento con la misma llave: la misma respuesta, sin error.
    replay = admin_client.post(url, json={"reason": "Se cargó con el monto equivocado"}, headers=headers)
    assert replay.status_code == 200 and replay.json() == body

    twice = admin_client.post(url, json={"reason": "otra vez"}, headers=idem())
    assert twice.status_code == 400
    assert twice.json()["error"]["code"] == "TIP_PAYOUT_ALREADY_REVERSED"

    # La plata vuelve a quedar pendiente: se puede registrar el reparto bueno.
    again = _payout(admin_client, store, [shift["id"]], [(cashier, 3000)])
    assert again.status_code == 201, again.text

    history = admin_client.get(f"/api/v1/admin/tips/payouts?store_id={store.id}").json()
    assert {p["id"] for p in history} == {payout_id, again.json()["id"]}
    live = admin_client.get(f"/api/v1/admin/tips/payouts?store_id={store.id}&status=live").json()
    assert [p["id"] for p in live] == [again.json()["id"]]
    gone = admin_client.get(f"/api/v1/admin/tips/payouts?store_id={store.id}&status=reversed").json()
    assert [p["id"] for p in gone] == [payout_id]

    audit = db.execute(
        select(AuditLog).where(AuditLog.entity == "tip_payout", AuditLog.entity_id == str(payout_id))
    ).scalars().all()
    assert [a.action for a in audit] == ["reverse"]


def test_payout_history_filters(admin_client: TestClient, shift_with_tip: Any, employees: dict, store: Store) -> None:
    shift = shift_with_tip(5000)
    cashier, operator = employees["cashier"].id, employees["operator"].id
    a = _payout(admin_client, store, [shift["id"]], [(cashier, 1000)]).json()
    b = _payout(admin_client, store, [shift["id"]], [(operator, 2000)], method="transfer").json()

    base = f"/api/v1/admin/tips/payouts?store_id={store.id}"
    assert [p["id"] for p in admin_client.get(f"{base}&employee_id={operator}").json()] == [b["id"]]
    assert [p["id"] for p in admin_client.get(f"{base}&method=cash").json()] == [a["id"]]
    assert {p["id"] for p in admin_client.get(f"{base}&shift_id={shift['id']}").json()} == {a["id"], b["id"]}
    # El período es la fecha de negocio de la entrega (15 de enero, Bogotá).
    assert len(admin_client.get(f"{base}&from=2026-01-15&to=2026-01-15").json()) == 2
    assert admin_client.get(f"{base}&from=2026-01-16&to=2026-01-20").json() == []


def test_tips_balance_collected_paid_pending_and_the_100_percent_check(
    admin_client: TestClient, shift_with_tip: Any, employees: dict, store: Store, db: Session
) -> None:
    shift = shift_with_tip(6000)
    bd = _close_by_orm(db, shift["id"])

    def balance() -> dict:
        resp = admin_client.get(f"/api/v1/admin/tips/balance?store_id={store.id}&from={bd}&to={bd}")
        assert resp.status_code == 200, resp.text
        return resp.json()

    before = balance()
    assert (before["collected"], before["paid"], before["pending"]) == (6000, 0, 6000)
    assert before["fully_delivered"] is False
    assert before["shifts"] == [
        {"shift_id": shift["id"], "business_date": bd, "collected": 6000, "paid": 0, "pending": 6000, "overpaid": 0}
    ]

    cashier = employees["cashier"].id
    first = _payout(admin_client, store, [shift["id"]], [(cashier, 4000)])
    assert first.status_code == 201
    mid = balance()
    assert (mid["collected"], mid["paid"], mid["pending"]) == (6000, 4000, 2000)
    assert mid["fully_delivered"] is False

    assert _payout(admin_client, store, [shift["id"]], [(cashier, 2000)]).status_code == 201
    done = balance()
    assert (done["paid"], done["pending"]) == (6000, 0)
    assert done["fully_delivered"] is True

    # Reversar devuelve el pendiente y apaga el «100 % entregado».
    admin_client.post(
        f"/api/v1/admin/tips/payouts/{first.json()['id']}/reverse?store_id={store.id}",
        json={"reason": "Mal cargado"},
        headers=idem(),
    )
    after = balance()
    assert (after["paid"], after["pending"]) == (2000, 4000)
    assert after["fully_delivered"] is False

    # Un período sin turnos cerrados no prueba nada: `null`, no `true`.
    empty = admin_client.get(f"/api/v1/admin/tips/balance?store_id={store.id}&from=2020-01-01&to=2020-01-02").json()
    assert empty["fully_delivered"] is None
    assert empty["shifts"] == []


def test_a_legacy_overpayment_is_published_not_hidden(
    admin_client: TestClient, shift_with_tip: Any, employees: dict, store: Store, db: Session
) -> None:
    """Un reparto anterior a la validación pudo entregar de más: no se
    esconde ni se resta de otro turno, se publica como `overpaid`."""
    from app.shifts.models import TipPayout

    shift = shift_with_tip(1000)
    created = _payout(admin_client, store, [shift["id"]], [(employees["cashier"].id, 1000)])
    assert created.status_code == 201
    row = db.get(TipPayout, created.json()["id"])
    assert row is not None
    row.total_amount = 1800  # como habría quedado antes de c3
    db.commit()
    bd = _close_by_orm(db, shift["id"])

    body = admin_client.get(f"/api/v1/admin/tips/balance?store_id={store.id}&from={bd}&to={bd}").json()
    assert (body["collected"], body["paid"], body["pending"], body["overpaid"]) == (1000, 1800, 0, 800)
