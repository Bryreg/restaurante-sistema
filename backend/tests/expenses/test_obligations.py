"""`GET`/`POST /admin/obligations`, `POST .../settle`, `POST .../cancel`:
obligaciones agendadas (arriendo, servicios, impuestos) con vencimiento y
estado — nunca mueven plata por sí solas."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.stores.models import Store


def _idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


def _create(admin_client: TestClient, store: Store, *, due_date: str = "2099-12-31", category: str = "rent") -> dict[str, Any]:
    resp = admin_client.post(
        f"/api/v1/admin/obligations?store_id={store.id}",
        json={"category": category, "description": "Arriendo de enero", "amount": 2_000_000, "due_date": due_date},
        headers=_idem(),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_create_and_list_obligation(admin_client: TestClient, store: Store) -> None:
    row = _create(admin_client, store)
    assert row["status"] == "pending"
    assert row["overdue"] is False

    listed = admin_client.get(f"/api/v1/admin/obligations?store_id={store.id}")
    assert any(o["id"] == row["id"] for o in listed.json())


def test_obligation_overdue_is_derived_not_stored(admin_client: TestClient, store: Store, clock: Any) -> None:
    row = _create(admin_client, store, due_date="2026-01-05")
    clock.set(__import__("datetime").datetime(2026, 2, 1, 12, 0, tzinfo=__import__("datetime").timezone.utc))

    listed = admin_client.get(f"/api/v1/admin/obligations?store_id={store.id}").json()
    found = next(o for o in listed if o["id"] == row["id"])
    assert found["overdue"] is True


def test_settle_obligation_marks_paid(admin_client: TestClient, store: Store) -> None:
    row = _create(admin_client, store)
    resp = admin_client.post(
        f"/api/v1/admin/obligations/{row['id']}/settle",
        json={"source": "bank"},
        headers=_idem(),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "paid"
    assert body["settled_source"] == "bank"
    assert body["settled_at"] is not None


def test_settle_already_paid_obligation_fails(admin_client: TestClient, store: Store) -> None:
    row = _create(admin_client, store)
    admin_client.post(f"/api/v1/admin/obligations/{row['id']}/settle", json={"source": "bank"}, headers=_idem())
    resp = admin_client.post(
        f"/api/v1/admin/obligations/{row['id']}/settle", json={"source": "bank"}, headers=_idem()
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "OBLIGATION_ALREADY_SETTLED"


def test_settle_from_cash_drawer_requires_existing_cash_movement_id(admin_client: TestClient, store: Store) -> None:
    row = _create(admin_client, store)
    resp = admin_client.post(
        f"/api/v1/admin/obligations/{row['id']}/settle", json={"source": "cash_drawer"}, headers=_idem()
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


def test_cancel_obligation_is_logical_and_blocks_settle(admin_client: TestClient, store: Store) -> None:
    row = _create(admin_client, store)
    cancelled = admin_client.post(
        f"/api/v1/admin/obligations/{row['id']}/cancel", json={"reason": "Se dio de baja el contrato"}, headers=_idem()
    )
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["cancelled_at"] is not None

    settle_after_cancel = admin_client.post(
        f"/api/v1/admin/obligations/{row['id']}/settle", json={"source": "bank"}, headers=_idem()
    )
    assert settle_after_cancel.status_code == 400, settle_after_cancel.text
    assert settle_after_cancel.json()["error"]["code"] == "OBLIGATION_CANCELLED"

    # No aparece en el listado default (sólo vivas)...
    listed = admin_client.get(f"/api/v1/admin/obligations?store_id={store.id}")
    assert all(o["id"] != row["id"] for o in listed.json())


def test_cannot_cancel_a_settled_obligation(admin_client: TestClient, store: Store) -> None:
    row = _create(admin_client, store)
    admin_client.post(f"/api/v1/admin/obligations/{row['id']}/settle", json={"source": "bank"}, headers=_idem())
    resp = admin_client.post(
        f"/api/v1/admin/obligations/{row['id']}/cancel", json={"reason": "x"}, headers=_idem()
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "OBLIGATION_ALREADY_SETTLED"


def test_settle_is_idempotent(admin_client: TestClient, store: Store) -> None:
    row = _create(admin_client, store)
    key = str(uuid4())
    first = admin_client.post(f"/api/v1/admin/obligations/{row['id']}/settle", json={"source": "bank"}, headers={"Idempotency-Key": key})
    second = admin_client.post(f"/api/v1/admin/obligations/{row['id']}/settle", json={"source": "bank"}, headers={"Idempotency-Key": key})
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json() == second.json()


def test_obligations_feature_disabled(admin_client: TestClient, store: Store, set_feature: Callable[..., None]) -> None:
    set_feature("money.obligations", False)
    resp = admin_client.get(f"/api/v1/admin/obligations?store_id={store.id}")
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"


def test_obligation_of_other_organization_is_404(admin_client: TestClient, store_b: Store) -> None:
    resp = admin_client.post(
        f"/api/v1/admin/obligations?store_id={store_b.id}",
        json={"category": "rent", "description": "x", "amount": 1000, "due_date": "2026-01-31"},
        headers=_idem(),
    )
    assert resp.status_code == 404, resp.text


def _drawer_expense(
    device_client: TestClient, shift_id: int, *, amount: int = 40_000, cause: str = "other_expense"
) -> int:
    resp = device_client.post(
        f"/api/v1/shifts/{shift_id}/cash-movements",
        json={"kind": "expense", "cause": cause, "amount": amount, "note": "Arriendo en efectivo"},
        headers=_idem(),
    )
    assert resp.status_code == 201, resp.text
    return int(resp.json()["id"])


def _expected(db: Session, shift_id: int) -> int:
    from app.shifts import service as shifts_service
    from app.shifts.models import Shift

    db.expire_all()
    shift = db.get(Shift, shift_id)
    assert shift is not None
    return int(shifts_service.compute_breakdown(db, shift)["expected"])


def test_settle_from_cash_drawer_references_the_drawer_egress_and_does_not_move_expected_again(
    admin_client: TestClient,
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: Any,
    store: Store,
    open_shift: Callable[..., dict[str, Any]],
    db: Session,
) -> None:
    """u4: saldar desde el cajón se comporta igual que un gasto con
    `source="cash_drawer"`: referencia el egreso que el turno YA registró
    (que es el que movió el esperado) y no vuelve a moverlo."""
    shift = open_shift()
    identify(device_client, employees["cashier"])
    movement_id = _drawer_expense(device_client, shift["id"])
    expected_before = _expected(db, shift["id"])

    listed = admin_client.get(f"/api/v1/admin/expenses/drawer-movements?store_id={store.id}")
    assert listed.status_code == 200, listed.text
    assert [m["id"] for m in listed.json()] == [movement_id]
    assert listed.json()[0]["amount"] == 40_000
    assert listed.json()[0]["cause"] == "other_expense"

    row = _create(admin_client, store)
    resp = admin_client.post(
        f"/api/v1/admin/obligations/{row['id']}/settle",
        json={"source": "cash_drawer", "cash_movement_id": movement_id},
        headers=_idem(),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "paid"
    assert body["settled_source"] == "cash_drawer"
    assert body["cash_movement_id"] == movement_id
    assert _expected(db, shift["id"]) == expected_before

    # Ya respalda esta obligación: no se ofrece más ni se puede reusar.
    listed_after = admin_client.get(f"/api/v1/admin/expenses/drawer-movements?store_id={store.id}")
    assert listed_after.json() == []
    other = _create(admin_client, store)
    reused = admin_client.post(
        f"/api/v1/admin/obligations/{other['id']}/settle",
        json={"source": "cash_drawer", "cash_movement_id": movement_id},
        headers=_idem(),
    )
    assert reused.status_code == 400, reused.text
    assert reused.json()["error"]["code"] == "CASH_MOVEMENT_ALREADY_USED"
    expense = admin_client.post(
        f"/api/v1/admin/expenses?store_id={store.id}",
        json={
            "category": "other", "description": "Doble", "amount": 2_000_000, "business_date": "2026-01-15",
            "source": "cash_drawer", "cash_movement_id": movement_id,
        },
        headers=_idem(),
    )
    assert expense.status_code == 400, expense.text
    assert expense.json()["error"]["code"] == "CASH_MOVEMENT_ALREADY_USED"


def test_drawer_movements_only_lists_expense_causes(
    admin_client: TestClient,
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: Any,
    store: Store,
    open_shift: Callable[..., dict[str, Any]],
) -> None:
    shift = open_shift()
    identify(device_client, employees["cashier"])
    petty = _drawer_expense(device_client, shift["id"], amount=10_000, cause="petty_expense")
    income = device_client.post(
        f"/api/v1/shifts/{shift['id']}/cash-movements",
        json={"kind": "income", "cause": "other_income", "amount": 5_000, "note": "Ingreso"},
        headers=_idem(),
    )
    assert income.status_code == 201, income.text

    listed = admin_client.get(f"/api/v1/admin/expenses/drawer-movements?store_id={store.id}")
    assert listed.status_code == 200, listed.text
    assert [m["id"] for m in listed.json()] == [petty]


def test_settle_with_bank_source_records_bank_without_cash_movement(admin_client: TestClient, store: Store) -> None:
    row = _create(admin_client, store)
    resp = admin_client.post(f"/api/v1/admin/obligations/{row['id']}/settle", json={"source": "bank"}, headers=_idem())
    assert resp.status_code == 200, resp.text
    assert resp.json()["settled_source"] == "bank"
    assert resp.json()["cash_movement_id"] is None
