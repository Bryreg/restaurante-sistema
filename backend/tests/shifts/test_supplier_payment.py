"""`app.shifts.hooks.register_supplier_payment_expense` — el egreso del
cajón que deja un pago a proveedor (pedido 2b, `app/shifts/**` territorio de
`backend-compras` en este pedido). Causa tipada `SUPPLIER_PAYMENT`, nunca
`OTHER_EXPENSE`; sin turno abierto, `409 NO_OPEN_SHIFT` y no se escribe
nada.

Ronda 2 (H-1 BLOQUEANTE) agrega `register_supplier_payment_reversal`, el
hermano exacto en la otra dirección: el reintegro que anular ese pago deja
en el turno abierto. Causa tipada `SUPPLIER_PAYMENT`, `kind=INCOME`, nunca
`OTHER_INCOME`; sin turno abierto, `409 NO_OPEN_SHIFT` y tampoco se escribe
nada. Los tests de extremo a extremo (pago + anulación, esperado del turno,
los dos movimientos vivos) están en `tests/purchases/test_payables.py`,
donde vive el flujo completo de `void_payment`."""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.deps import Actor
from app.core.errors import AppError
from app.shifts import hooks, service
from app.shifts.models import CashMovement, CashMovementCause, CashMovementKind, Shift


def _actor(employee: Any) -> Actor:
    return Actor(
        kind="device",
        organization_id=employee.organization_id,
        store_id=employee.store_id,
        employee_id=employee.id,
        employee_name=employee.name,
        role=employee.role,
    )


def test_register_supplier_payment_expense_creates_typed_cash_movement(
    device_client: Any, open_shift: Any, employees: dict, db: Session
) -> None:
    body = open_shift()
    shift = db.get(Shift, body["id"])
    assert shift is not None

    movement = hooks.register_supplier_payment_expense(
        db,
        organization_id=shift.organization_id,
        store_id=shift.store_id,
        amount=50_000,
        actor=_actor(employees["cashier"]),
        note="Pago a proveedor — cuenta por pagar #1",
        reference="TX-123",
    )
    db.commit()

    assert movement.shift_id == shift.id
    assert movement.cause == CashMovementCause.SUPPLIER_PAYMENT
    assert movement.kind == CashMovementKind.EXPENSE
    assert movement.amount == 50_000
    assert "TX-123" in (movement.note or "")

    # Cuenta como egreso en `compute_breakdown`, igual que cualquier otro.
    breakdown = service.compute_breakdown(db, shift)
    assert breakdown["expected"] == shift.opening_cash_total - 50_000


def test_register_supplier_payment_expense_without_open_shift_raises_and_writes_nothing(
    store: Any, employees: dict, db: Session
) -> None:
    with pytest.raises(AppError) as excinfo:
        hooks.register_supplier_payment_expense(
            db,
            organization_id=store.organization_id,
            store_id=store.id,
            amount=10_000,
            actor=_actor(employees["cashier"]),
        )
    assert excinfo.value.code == "NO_OPEN_SHIFT"
    assert excinfo.value.status == 409

    rows = db.execute(
        select(CashMovement).where(CashMovement.cause == CashMovementCause.SUPPLIER_PAYMENT)
    ).scalars().all()
    assert rows == []


def test_supplier_payment_cause_accepted_by_generic_cash_movement_endpoint(
    device_client: Any, open_shift: Any, identify: Any, employees: dict, db: Session
) -> None:
    """La causa nueva también es válida en el endpoint genérico de
    movimientos de caja (no sólo desde el hook de `purchases`), porque
    `CashMovementCauseLiteral` la publica en el esquema de entrada."""
    body = open_shift()
    identify(device_client, employees["cashier"])
    resp = device_client.post(
        f"/api/v1/shifts/{body['id']}/cash-movements",
        json={"kind": "expense", "cause": "supplier_payment", "amount": 5_000, "note": "prueba"},
        headers={"Idempotency-Key": "test-supplier-payment-cause-1"},
    )
    assert resp.status_code in (200, 201), resp.text
    assert resp.json()["cause"] == "supplier_payment"


# ---------------------------------------------------------------------------
# Ronda 2 — `register_supplier_payment_reversal`, hermano exacto de
# `register_supplier_payment_expense` en la otra dirección.
# ---------------------------------------------------------------------------


def test_register_supplier_payment_reversal_creates_typed_income_movement(
    device_client: Any, open_shift: Any, employees: dict, db: Session
) -> None:
    body = open_shift()
    shift = db.get(Shift, body["id"])
    assert shift is not None

    expense = hooks.register_supplier_payment_expense(
        db,
        organization_id=shift.organization_id,
        store_id=shift.store_id,
        amount=50_000,
        actor=_actor(employees["cashier"]),
        note="Pago a proveedor — cuenta por pagar #1",
    )
    db.commit()
    assert service.compute_breakdown(db, shift)["expected"] == shift.opening_cash_total - 50_000

    reversal = hooks.register_supplier_payment_reversal(
        db,
        organization_id=shift.organization_id,
        store_id=shift.store_id,
        amount=50_000,
        actor=_actor(employees["cashier"]),
        note="Reintegro por anulación del pago a proveedor #1",
    )
    db.commit()

    assert reversal.shift_id == shift.id
    assert reversal.cause == CashMovementCause.SUPPLIER_PAYMENT
    assert reversal.kind == CashMovementKind.INCOME
    assert reversal.amount == 50_000
    assert reversal.id != expense.id, "tiene que ser un movimiento nuevo, no reescribir el original"
    assert "1" in (reversal.note or "")

    # El original sigue vivo: los dos movimientos están, uno anula al otro
    # por SUMA, no por borrado.
    original = db.get(CashMovement, expense.id)
    assert original is not None
    assert original.kind == CashMovementKind.EXPENSE

    # `compute_breakdown` vuelve al valor previo al egreso, sin ninguna
    # segunda fórmula: el INCOME nuevo neutraliza el EXPENSE por construcción.
    assert service.compute_breakdown(db, shift)["expected"] == shift.opening_cash_total


def test_register_supplier_payment_reversal_without_open_shift_raises_and_writes_nothing(
    store: Any, employees: dict, db: Session
) -> None:
    with pytest.raises(AppError) as excinfo:
        hooks.register_supplier_payment_reversal(
            db,
            organization_id=store.organization_id,
            store_id=store.id,
            amount=10_000,
            actor=_actor(employees["cashier"]),
            note="Reintegro por anulación del pago a proveedor #1",
        )
    assert excinfo.value.code == "NO_OPEN_SHIFT"
    assert excinfo.value.status == 409

    rows = db.execute(
        select(CashMovement).where(CashMovement.cause == CashMovementCause.SUPPLIER_PAYMENT)
    ).scalars().all()
    assert rows == []
