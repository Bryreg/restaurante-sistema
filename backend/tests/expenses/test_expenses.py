"""`GET`/`POST /admin/expenses`, `POST .../void`: gastos del período que
NUNCA crean un `CashMovement` — la llave anti doble conteo de este
territorio (ver docstring de `app.expenses.service`)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.stores.models import Store


def _idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


def _expected(db: Session, shift_id: int) -> int:
    from app.shifts import service as shifts_service
    from app.shifts.models import Shift

    shift = db.get(Shift, shift_id)
    assert shift is not None
    return shifts_service.compute_breakdown(db, shift)["expected"]


def test_create_and_list_expense(admin_client: TestClient, store: Store) -> None:
    resp = admin_client.post(
        f"/api/v1/admin/expenses?store_id={store.id}",
        json={"category": "utilities", "description": "Factura de energía", "amount": 350_000, "business_date": "2026-01-10", "source": "bank"},
        headers=_idem(),
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["amount"] == 350_000
    assert body["source"] == "bank"
    assert body["cash_movement_id"] is None
    assert body["voided_at"] is None

    listed = admin_client.get(
        f"/api/v1/admin/expenses?store_id={store.id}&from=2026-01-01&to=2026-01-31"
    )
    assert listed.status_code == 200, listed.text
    assert any(e["id"] == body["id"] for e in listed.json())


def test_expense_amount_must_be_positive(admin_client: TestClient, store: Store) -> None:
    resp = admin_client.post(
        f"/api/v1/admin/expenses?store_id={store.id}",
        json={"category": "supplies", "description": "x", "amount": 0, "business_date": "2026-01-10", "source": "other"},
        headers=_idem(),
    )
    assert resp.status_code == 400, resp.text


def test_expense_from_cash_drawer_requires_existing_cash_movement_id(admin_client: TestClient, store: Store) -> None:
    resp = admin_client.post(
        f"/api/v1/admin/expenses?store_id={store.id}",
        json={"category": "supplies", "description": "Servilletas", "amount": 20_000, "business_date": "2026-01-10", "source": "cash_drawer"},
        headers=_idem(),
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


def test_expense_cash_movement_id_only_applies_to_cash_drawer(admin_client: TestClient, store: Store) -> None:
    resp = admin_client.post(
        f"/api/v1/admin/expenses?store_id={store.id}",
        json={
            "category": "supplies", "description": "x", "amount": 20_000, "business_date": "2026-01-10",
            "source": "bank", "cash_movement_id": 999,
        },
        headers=_idem(),
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


def test_expense_referencing_unknown_cash_movement_is_404(admin_client: TestClient, store: Store) -> None:
    resp = admin_client.post(
        f"/api/v1/admin/expenses?store_id={store.id}",
        json={
            "category": "supplies", "description": "x", "amount": 20_000, "business_date": "2026-01-10",
            "source": "cash_drawer", "cash_movement_id": 999999,
        },
        headers=_idem(),
    )
    assert resp.status_code == 404, resp.text


def test_expense_that_never_touched_the_drawer_leaves_expected_cash_unchanged(
    admin_client: TestClient, store: Store, open_shift: Callable[..., dict[str, Any]], db: Session
) -> None:
    """El invariante nº1 del territorio: un gasto que NO pasó por el cajón
    (transferencia de arriendo, `source="bank"`) no puede mover el esperado
    del turno — medido antes y después."""
    shift = open_shift()
    expected_before = _expected(db, shift["id"])

    resp = admin_client.post(
        f"/api/v1/admin/expenses?store_id={store.id}",
        json={"category": "utilities", "description": "Arriendo", "amount": 2_000_000, "business_date": "2026-01-15", "source": "bank"},
        headers=_idem(),
    )
    assert resp.status_code == 201, resp.text

    assert _expected(db, shift["id"]) == expected_before, "un gasto que no pasa por el cajón no puede tocar compute_breakdown"


def test_expense_referencing_an_existing_cash_drawer_movement_does_not_move_expected_again(
    admin_client: TestClient,
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: Any,
    store: Store,
    open_shift: Callable[..., dict[str, Any]],
    db: Session,
) -> None:
    """Cuando el gasto SÍ salió del cajón, la plata entra por la puerta que
    `shifts` ya publica (`POST /shifts/{id}/cash-movements`); este dominio
    sólo referencia el movimiento ya creado y NO vuelve a moverlo."""
    shift = open_shift()
    identify(device_client, employees["cashier"])
    expected_before = _expected(db, shift["id"])

    movement_resp = device_client.post(
        f"/api/v1/shifts/{shift['id']}/cash-movements",
        json={"kind": "expense", "cause": "other_expense", "amount": 20_000, "note": "Reparación menor"},
        headers=_idem(),
    )
    assert movement_resp.status_code == 201, movement_resp.text
    movement_id = movement_resp.json()["id"]
    expected_after_real_movement = _expected(db, shift["id"])
    assert expected_after_real_movement == expected_before - 20_000

    resp = admin_client.post(
        f"/api/v1/admin/expenses?store_id={store.id}",
        json={
            "category": "maintenance", "description": "Reparación menor", "amount": 20_000, "business_date": "2026-01-15",
            "source": "cash_drawer", "cash_movement_id": movement_id,
        },
        headers=_idem(),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["cash_movement_id"] == movement_id

    # El registro en `expenses` sólo referenció el movimiento: no lo volvió a
    # contar. El esperado sigue exactamente donde quedó tras el movimiento real.
    assert _expected(db, shift["id"]) == expected_after_real_movement


def test_void_expense_is_logical_not_deleted(admin_client: TestClient, store: Store) -> None:
    created = admin_client.post(
        f"/api/v1/admin/expenses?store_id={store.id}",
        json={"category": "supplies", "description": "Compra por error", "amount": 15_000, "business_date": "2026-01-10", "source": "other"},
        headers=_idem(),
    ).json()

    voided = admin_client.post(
        f"/api/v1/admin/expenses/{created['id']}/void",
        json={"reason": "Se cargó dos veces"},
        headers=_idem(),
    )
    assert voided.status_code == 200, voided.text
    assert voided.json()["voided_at"] is not None
    assert voided.json()["voided_reason"] == "Se cargó dos veces"

    # No aparece en el listado default (sólo vivos)...
    listed = admin_client.get(f"/api/v1/admin/expenses?store_id={store.id}&from=2026-01-01&to=2026-01-31")
    assert all(e["id"] != created["id"] for e in listed.json())

    # ...pero nunca se borró: sigue existiendo con su estado.
    double_void = admin_client.post(
        f"/api/v1/admin/expenses/{created['id']}/void", json={"reason": "otra vez"}, headers=_idem()
    )
    assert double_void.status_code == 400, double_void.text
    assert double_void.json()["error"]["code"] == "EXPENSE_ALREADY_VOIDED"


def test_expenses_feature_disabled(admin_client: TestClient, store: Store, set_feature: Callable[..., None]) -> None:
    set_feature("money.obligations", False)
    resp = admin_client.get(f"/api/v1/admin/expenses?store_id={store.id}")
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"

    resp2 = admin_client.post(
        f"/api/v1/admin/expenses?store_id={store.id}",
        json={"category": "other", "description": "x", "amount": 1000, "business_date": "2026-01-10", "source": "other"},
        headers=_idem(),
    )
    assert resp2.status_code == 400, resp2.text
    assert resp2.json()["error"]["code"] == "FEATURE_DISABLED"


def test_expenses_feature_enabled_works(admin_client: TestClient, store: Store, set_feature: Callable[..., None]) -> None:
    set_feature("money.obligations", True)
    resp = admin_client.get(f"/api/v1/admin/expenses?store_id={store.id}")
    assert resp.status_code == 200, resp.text


def test_expense_of_other_organization_store_is_404(
    admin_client: TestClient, store_b: Store
) -> None:
    resp = admin_client.post(
        f"/api/v1/admin/expenses?store_id={store_b.id}",
        json={"category": "other", "description": "x", "amount": 1000, "business_date": "2026-01-10", "source": "other"},
        headers=_idem(),
    )
    assert resp.status_code == 404, resp.text
