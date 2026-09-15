"""`GET /admin/pending-refunds` y `POST /admin/pending-refunds/{id}/settle`."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.deps import Actor
from app.auth.models import Employee
from app.core import clock as clock_module
from app.refunds.hooks import settle_or_queue_refund
from app.refunds.models import PendingRefund
from app.shifts.models import CashMovement, CashMovementCause, Shift, ShiftStatus
from app.stores.models import Organization, Store


def _admin_actor(org: Organization, admin: Employee) -> Actor:
    return Actor(
        kind="admin", organization_id=org.id, store_id=None, employee_id=admin.id, employee_name=admin.name, role="admin"
    )


def _queue_pending_refund(
    db: Session, *, org: Organization, store: Store, admin: Employee, paid_order: Any, amount: int = 5000
) -> PendingRefund:
    payment = paid_order()
    document_id = payment["document"]["id"]
    shift = db.execute(select(Shift).where(Shift.store_id == store.id)).scalars().one()
    shift.status = ShiftStatus.CLOSED
    db.commit()

    outcome = settle_or_queue_refund(
        db,
        organization_id=org.id,
        store_id=store.id,
        document_id=document_id,
        method="cash",
        amount=amount,
        actor=_admin_actor(org, admin),
        now=clock_module.now_utc(),
    )
    assert outcome.status == "pending"
    pending = db.get(PendingRefund, outcome.pending_refund_id)
    assert pending is not None
    return pending


def test_list_pending_refunds(
    admin_client: TestClient, db: Session, org: Organization, store: Store, employees: dict, paid_order: Any
) -> None:
    _queue_pending_refund(db, org=org, store=store, admin=employees["admin"], paid_order=paid_order)

    resp = admin_client.get(f"/api/v1/admin/pending-refunds?store_id={store.id}")
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["status"] == "pending"
    assert rows[0]["amount"] == 5000


def test_list_pending_refunds_csv(
    admin_client: TestClient, db: Session, org: Organization, store: Store, employees: dict, paid_order: Any
) -> None:
    _queue_pending_refund(db, org=org, store=store, admin=employees["admin"], paid_order=paid_order)
    resp = admin_client.get(f"/api/v1/admin/pending-refunds?store_id={store.id}&format=csv")
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/csv")
    assert "amount" in resp.text


def test_settle_from_a_shift_creates_the_egress_in_that_shift_only(
    admin_client: TestClient,
    db: Session,
    org: Organization,
    store: Store,
    employees: dict,
    paid_order: Any,
    open_shift: Any,
) -> None:
    pending = _queue_pending_refund(db, org=org, store=store, admin=employees["admin"], paid_order=paid_order)
    original_shift_id = db.execute(select(Shift).where(Shift.store_id == store.id, Shift.status == ShiftStatus.CLOSED)).scalars().one().id

    new_shift = open_shift()

    resp = admin_client.post(
        f"/api/v1/admin/pending-refunds/{pending.id}/settle",
        json={"from": "shift", "shift_id": new_shift["id"]},
        headers={"Idempotency-Key": str(uuid.uuid4())},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "settled"
    assert body["settled_from"] == "shift"
    assert body["settled_shift_id"] == new_shift["id"]

    movements_new = list(db.execute(select(CashMovement).where(CashMovement.shift_id == new_shift["id"])).scalars())
    assert len(movements_new) == 1
    assert movements_new[0].cause == CashMovementCause.REFUND
    assert movements_new[0].amount == 5000

    movements_original = list(db.execute(select(CashMovement).where(CashMovement.shift_id == original_shift_id)).scalars())
    assert movements_original == []


def test_settle_from_the_owner_creates_no_cash_movement(
    admin_client: TestClient, db: Session, org: Organization, store: Store, employees: dict, paid_order: Any
) -> None:
    pending = _queue_pending_refund(db, org=org, store=store, admin=employees["admin"], paid_order=paid_order)

    resp = admin_client.post(
        f"/api/v1/admin/pending-refunds/{pending.id}/settle",
        json={"from": "owner"},
        headers={"Idempotency-Key": str(uuid.uuid4())},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "settled"
    assert body["settled_from"] == "owner"
    assert body["settled_cash_movement_id"] is None

    movements = list(db.execute(select(CashMovement)).scalars())
    assert movements == []


def test_settling_twice_fails_with_400(
    admin_client: TestClient, db: Session, org: Organization, store: Store, employees: dict, paid_order: Any
) -> None:
    pending = _queue_pending_refund(db, org=org, store=store, admin=employees["admin"], paid_order=paid_order)

    first = admin_client.post(
        f"/api/v1/admin/pending-refunds/{pending.id}/settle",
        json={"from": "owner"},
        headers={"Idempotency-Key": str(uuid.uuid4())},
    )
    assert first.status_code == 200, first.text

    second = admin_client.post(
        f"/api/v1/admin/pending-refunds/{pending.id}/settle",
        json={"from": "owner"},
        headers={"Idempotency-Key": str(uuid.uuid4())},
    )
    assert second.status_code == 400, second.text
    assert second.json()["error"]["code"] == "PENDING_REFUND_ALREADY_SETTLED"


def test_settle_with_the_same_idempotency_key_replays_the_same_response(
    admin_client: TestClient, db: Session, org: Organization, store: Store, employees: dict, paid_order: Any
) -> None:
    pending = _queue_pending_refund(db, org=org, store=store, admin=employees["admin"], paid_order=paid_order)
    key = {"Idempotency-Key": str(uuid.uuid4())}

    first = admin_client.post(f"/api/v1/admin/pending-refunds/{pending.id}/settle", json={"from": "owner"}, headers=key)
    second = admin_client.post(f"/api/v1/admin/pending-refunds/{pending.id}/settle", json={"from": "owner"}, headers=key)

    assert first.status_code == 200 and second.status_code == 200
    assert first.json() == second.json()


def test_settle_from_shift_without_shift_id_returns_400(
    admin_client: TestClient, db: Session, org: Organization, store: Store, employees: dict, paid_order: Any
) -> None:
    pending = _queue_pending_refund(db, org=org, store=store, admin=employees["admin"], paid_order=paid_order)

    resp = admin_client.post(
        f"/api/v1/admin/pending-refunds/{pending.id}/settle",
        json={"from": "shift"},
        headers={"Idempotency-Key": str(uuid.uuid4())},
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "SHIFT_ID_REQUIRED"
