"""Pedido de sencilla: se pide por denominaciones con motivo, el administrador
la ajusta y aprueba («por entregar»), y cuando llega el cajero la registra con
el **Cambio** del turno (neto cero) y la marca recibida. La solicitud nunca
mueve plata: el esperado del turno no cambia en ningún paso.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.requests.models import StaffRequest
from app.shifts import service as shifts_service
from app.shifts.models import CashMovement, Shift
from tests.requests.conftest import API, find_secret_keys, idem

SMALL = {"denominations": [{"value": 1000, "count": 20}, {"value": 2000, "count": 10}], "total": 40000}


def _change(device_client: Any, denominations: dict[str, Any] = SMALL, reason: str = "Se acabaron las monedas") -> Any:
    return device_client.post(
        f"{API}/requests/change", json={"denominations": denominations, "reason": reason}, headers=idem()
    )


def _open(db: Session) -> Shift:
    shift = db.execute(select(Shift).where(Shift.status == "open")).scalars().first()
    assert shift is not None
    return shift


def test_full_change_flow_ends_in_the_existing_cash_swap(
    device_client, admin_client, open_shift, store, db: Session
) -> None:
    open_shift()
    shift = _open(db)
    expected_before = shifts_service.compute_breakdown(db, shift)["expected"]

    created = _change(device_client)
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["kind"] == "change"
    assert body["status"] == "pending"
    assert body["requested_total"] == 40000
    # De mayor a menor, sin renglones en cero.
    assert body["requested_denominations"] == [{"value": 2000, "count": 10}, {"value": 1000, "count": 20}]
    assert body["reason"] == "Se acabaron las monedas"
    assert find_secret_keys(body) == []

    adjusted = {"denominations": [{"value": 2000, "count": 5}, {"value": 1000, "count": 10}], "total": 20000}
    approved = admin_client.post(
        f"{API}/admin/requests/{body['id']}/approve", json={"denominations": adjusted}, headers=idem()
    )
    assert approved.status_code == 200, approved.text
    assert approved.json()["status"] == "approved"
    assert approved.json()["approved_total"] == 20000
    assert approved.json()["approved_denominations"] == [{"value": 2000, "count": 5}, {"value": 1000, "count": 10}]
    # Lo pedido queda como se pidió.
    assert approved.json()["requested_total"] == 40000

    # Llega la sencilla: el cajero la registra con el Cambio que ya existe.
    swap = device_client.post(
        f"{API}/shifts/{shift.id}/cash-swaps",
        json={
            "out": {"denominations": [{"value": 20000, "count": 1}], "total": 20000},
            "in": adjusted,
        },
    )
    assert swap.status_code in (200, 201), swap.text
    swap_id = swap.json()["id"]

    received = device_client.post(
        f"{API}/requests/{body['id']}/received", json={"cash_swap_id": swap_id}, headers=idem()
    )
    assert received.status_code == 200, received.text
    assert received.json()["status"] == "received"
    assert received.json()["cash_swap_id"] == swap_id
    assert received.json()["closed_by"]["name"] == "Cashier"

    # Ni la solicitud ni su aprobación movieron plata del cajón.
    db.expire_all()
    assert shifts_service.compute_breakdown(db, _open(db))["expected"] == expected_before
    assert db.execute(select(func.count(CashMovement.id))).scalar_one() == 0


def test_approve_without_adjustment_approves_what_was_requested(device_client, admin_client, open_shift) -> None:
    open_shift()
    created = _change(device_client).json()
    approved = admin_client.post(f"{API}/admin/requests/{created['id']}/approve", json={}, headers=idem())
    assert approved.status_code == 200, approved.text
    assert approved.json()["approved_total"] == 40000
    assert approved.json()["approved_denominations"] == created["requested_denominations"]


def test_change_needs_reason_and_valid_denominations(device_client, open_shift, db: Session) -> None:
    open_shift()
    cases = [
        _change(device_client, reason="   "),
        _change(device_client, denominations={"denominations": [{"value": 3000, "count": 1}], "total": 3000}),
        _change(device_client, denominations={"denominations": [{"value": 1000, "count": 2}], "total": 5000}),
        _change(device_client, denominations={"denominations": [], "total": 0}),
    ]
    codes = [c.json()["error"]["code"] for c in cases]
    assert codes == ["REASON_REQUIRED", "DENOMINATION_INVALID", "DENOMINATIONS_MISMATCH", "CHANGE_EMPTY"]
    assert db.execute(select(func.count(StaffRequest.id))).scalar_one() == 0


def test_received_only_after_approval_and_a_swap_links_once(
    device_client, admin_client, open_shift, db: Session
) -> None:
    open_shift()
    shift = _open(db)
    first = _change(device_client).json()
    second = _change(device_client).json()

    early = device_client.post(f"{API}/requests/{first['id']}/received", json={}, headers=idem())
    assert early.status_code == 409

    for req in (first, second):
        admin_client.post(f"{API}/admin/requests/{req['id']}/approve", json={}, headers=idem())
    swap = device_client.post(
        f"{API}/shifts/{shift.id}/cash-swaps",
        json={"out": {"denominations": [{"value": 20000, "count": 2}], "total": 40000}, "in": SMALL},
    ).json()

    ok = device_client.post(f"{API}/requests/{first['id']}/received", json={"cash_swap_id": swap["id"]}, headers=idem())
    assert ok.status_code == 200, ok.text
    dup = device_client.post(f"{API}/requests/{second['id']}/received", json={"cash_swap_id": swap["id"]}, headers=idem())
    assert dup.status_code == 409
    assert dup.json()["error"]["code"] == "CASH_SWAP_ALREADY_LINKED"
    missing = device_client.post(f"{API}/requests/{second['id']}/received", json={"cash_swap_id": 999_999}, headers=idem())
    assert missing.status_code == 404
    db.expire_all()
    assert db.get(StaffRequest, second["id"]).status.value == "approved"  # type: ignore[union-attr]

    # Sin atar a un Cambio también se puede cerrar (queda a la vista: `cash_swap_id` nulo).
    loose = device_client.post(f"{API}/requests/{second['id']}/received", json={}, headers=idem())
    assert loose.status_code == 200
    assert loose.json()["cash_swap_id"] is None


def test_supply_endpoints_do_not_take_denominations_nor_change_take_lines(
    device_client, admin_client, open_shift
) -> None:
    open_shift()
    created = _change(device_client).json()
    resp = admin_client.post(
        f"{API}/admin/requests/{created['id']}/approve", json={"lines": [{"line_id": 1, "qty": "1"}]}, headers=idem()
    )
    assert resp.status_code == 400
    bought = admin_client.post(f"{API}/admin/requests/{created['id']}/mark-bought", json={}, headers=idem())
    assert bought.status_code == 400


def test_change_requests_need_cash_swaps(device_client, open_shift, set_feature) -> None:
    open_shift()
    set_feature("cash.swaps", False)
    resp = _change(device_client)
    assert resp.status_code == 400
    assert resp.json()["error"]["feature"] == "cash.swaps"
