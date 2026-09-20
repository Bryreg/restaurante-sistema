"""El efectivo de domicilios se arquea APARTE (§3.3), y el IDA Y VUELTA de
la liquidación.

Renglón del checklist: «El efectivo de domicilios se arquea aparte del cajón
hasta que el domiciliario liquida (test sobre el desglose del turno)».

Y la mitad que a 2b le faltó dos veces: **qué pasa cuando se DESHACE**.
Es el cierre de H-1 de 2b, en el sentido opuesto.
"""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.channels.models import DeliverySettlement, DeliverySettlementStatus
from app.core.errors import AppError
from app.payments.models import Payment
from app.shifts import hooks as shifts_hooks
from app.shifts import service as shifts_service
from app.shifts.models import CashMovement, CashMovementCause, CashMovementKind, Shift, ShiftStatus
from tests.channels.conftest import idem


def _shift(db: Session) -> Shift:
    row = db.execute(select(Shift).order_by(Shift.id.desc())).scalars().first()
    assert row is not None
    return row


def _pay_delivery_in_cash(delivery_order: Any, pay: Any) -> dict[str, Any]:
    order = delivery_order()
    total = order["totals"]["total"]
    resp = pay(order, splits=[{"method": "cash", "amount": total, "tendered": total}])
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_delivery_cash_stays_out_of_the_expected_until_it_is_settled(
    delivery_order: Any, pay: Any, db: Session
) -> None:
    order = delivery_order()
    shift = _shift(db)
    expected_before = shifts_service.compute_breakdown(db, shift)["expected"]

    total = order["totals"]["total"]
    resp = pay(order, splits=[{"method": "cash", "amount": total, "tendered": total}])
    assert resp.status_code == 201, resp.text
    db.expire_all()

    breakdown = shifts_service.compute_breakdown(db, shift)
    assert breakdown["expected"] == expected_before, (
        "el efectivo que tiene el domiciliario entró al esperado del cajón antes de que lo entregara"
    )
    assert breakdown["cash_sales"] == 0
    # Renglón PROPIO del desglose, fuera de `expected`.
    assert breakdown["delivery_cash_pending"] == total

    totals = shifts_hooks.get_sales_totals(db, shift.id)
    assert totals.cash == 0
    assert totals.delivery_cash == total
    assert totals.delivery_cash_pending == total

    # El contrato de salida del cobro también lo dice.
    assert resp.json()["delivery_cash_pending"] == total


def test_the_payment_carries_the_courier_taken_from_the_order(
    delivery_order: Any, pay: Any, employees: dict, db: Session
) -> None:
    """El domiciliario sale de la COMANDA, no de que el POS se acuerde de
    mandarlo: si dependiera del cliente, el turno cuadraría de más justo
    cuando alguien se olvidó del bloque."""
    order = delivery_order()
    total = order["totals"]["total"]
    assert pay(order, splits=[{"method": "cash", "amount": total, "tendered": total}]).status_code == 201
    db.expire_all()

    payment = db.execute(select(Payment).where(Payment.order_id == order["id"])).scalar_one()
    assert payment.method == "cash"
    assert payment.delivery_courier_employee_id == employees["operator"].id
    assert payment.delivery_courier_employee_name == employees["operator"].name
    assert payment.delivery_settlement_id is None


def test_settling_brings_the_cash_into_the_open_shift_with_a_typed_cause(
    delivery_order: Any, pay: Any, device_client: Any, employees: dict, db: Session
) -> None:
    order = delivery_order()
    total = order["totals"]["total"]
    assert pay(order, splits=[{"method": "cash", "amount": total, "tendered": total}]).status_code == 201
    db.expire_all()

    shift = _shift(db)
    expected_before = shifts_service.compute_breakdown(db, shift)["expected"]

    resp = device_client.post(
        "/api/v1/delivery-settlements",
        json={"courier_employee_id": employees["operator"].id},
        headers=idem(),
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    db.expire_all()

    assert body["total"] == total
    assert body["status"] == "settled"
    assert body["payments_count"] == 1

    movement = db.get(CashMovement, body["cash_movement_id"])
    assert movement is not None
    assert movement.kind == CashMovementKind.INCOME
    assert movement.cause == CashMovementCause.DELIVERY_SETTLEMENT, "causa TIPADA, nunca `other_income`"
    assert movement.amount == total
    assert movement.shift_id == shift.id

    breakdown = shifts_service.compute_breakdown(db, shift)
    assert breakdown["incomes"] == total
    assert breakdown["expected"] == expected_before + total, "la plata entra al cajón por `incomes`"
    assert breakdown["delivery_cash_pending"] == 0
    # `cash_sales` NO cambió: no se cuenta dos veces.
    assert breakdown["cash_sales"] == 0


def test_undoing_a_settlement_writes_the_mirror_and_deletes_nothing(
    delivery_order: Any, pay: Any, device_client: Any, employees: dict, db: Session
) -> None:
    """El IDA Y VUELTA, escrito como test: el movimiento original queda
    VIVO, el espejo es un movimiento nuevo con la misma causa tipada y kind
    opuesto, y los cobros vuelven a estar pendientes."""
    order = delivery_order()
    total = order["totals"]["total"]
    assert pay(order, splits=[{"method": "cash", "amount": total, "tendered": total}]).status_code == 201
    db.expire_all()

    shift = _shift(db)
    expected_before = shifts_service.compute_breakdown(db, shift)["expected"]

    settled = device_client.post(
        "/api/v1/delivery-settlements",
        json={"courier_employee_id": employees["operator"].id},
        headers=idem(),
    )
    assert settled.status_code == 201, settled.text
    settlement_id = settled.json()["id"]
    original_movement_id = settled.json()["cash_movement_id"]

    voided = device_client.post(
        f"/api/v1/delivery-settlements/{settlement_id}/void",
        json={"reason": "El domiciliario entregó de menos y se recuenta"},
        headers=idem(),
    )
    assert voided.status_code == 200, voided.text
    body = voided.json()
    db.expire_all()

    assert body["status"] == "voided"
    assert body["voided_reason"] == "El domiciliario entregó de menos y se recuenta"

    # 1. El movimiento original sigue VIVO: nada financiero se borra.
    original = db.get(CashMovement, original_movement_id)
    assert original is not None
    assert original.kind == CashMovementKind.INCOME
    assert original.cause == CashMovementCause.DELIVERY_SETTLEMENT

    # 2. El espejo: kind opuesto, MISMA causa tipada, turno abierto al
    #    momento de deshacer.
    mirror = db.get(CashMovement, body["void_cash_movement_id"])
    assert mirror is not None
    assert mirror.id != original.id
    assert mirror.kind == CashMovementKind.EXPENSE
    assert mirror.cause == CashMovementCause.DELIVERY_SETTLEMENT
    assert mirror.amount == original.amount

    # 3. El esperado vuelve a donde estaba: entró y salió.
    breakdown = shifts_service.compute_breakdown(db, shift)
    assert breakdown["expected"] == expected_before
    # 4. Y el efectivo vuelve a estar pendiente de liquidar.
    assert breakdown["delivery_cash_pending"] == total
    payment = db.execute(select(Payment).where(Payment.order_id == order["id"])).scalar_one()
    assert payment.delivery_settlement_id is None

    # 5. La liquidación NO se borró: quedó anulada, con motivo y quién.
    row = db.get(DeliverySettlement, settlement_id)
    assert row is not None
    assert row.status == DeliverySettlementStatus.VOIDED
    assert row.voided_by_employee_name


def test_undoing_without_an_open_shift_rejects_the_whole_thing(
    delivery_order: Any, pay: Any, device_client: Any, employees: dict, db: Session
) -> None:
    """Sin turno abierto, `409` y **no queda nada a medias**: ni el espejo,
    ni el `voided_at`, ni los pagos liberados. Es el cierre exacto de H-1
    de 2b, en el otro sentido."""
    order = delivery_order()
    total = order["totals"]["total"]
    assert pay(order, splits=[{"method": "cash", "amount": total, "tendered": total}]).status_code == 201
    db.expire_all()

    settled = device_client.post(
        "/api/v1/delivery-settlements",
        json={"courier_employee_id": employees["operator"].id},
        headers=idem(),
    )
    assert settled.status_code == 201, settled.text
    settlement_id = settled.json()["id"]

    # Cerrar el turno a mano (sin pasar por el cierre a ciegas, que no es lo
    # que este test mide): lo que importa es que no haya turno `OPEN`.
    shift = _shift(db)
    shift.status = ShiftStatus.CLOSED
    db.commit()

    resp = device_client.post(
        f"/api/v1/delivery-settlements/{settlement_id}/void",
        json={"reason": "Se deshace sin turno abierto"},
        headers=idem(),
    )
    assert resp.status_code == 409, resp.text
    assert resp.json()["error"]["code"] == "NO_OPEN_SHIFT"
    db.expire_all()

    row = db.get(DeliverySettlement, settlement_id)
    assert row is not None
    assert row.status == DeliverySettlementStatus.SETTLED, "la anulación quedó a medias"
    assert row.voided_at is None
    assert row.void_cash_movement_id is None
    payment = db.execute(select(Payment).where(Payment.order_id == order["id"])).scalar_one()
    assert payment.delivery_settlement_id == settlement_id


def test_settling_without_an_open_shift_writes_nothing(
    store: Any, employees: dict, db: Session
) -> None:
    """La IDA, sin turno abierto: `409` levantado ANTES de escribir."""
    from app.auth.deps import Actor

    actor = Actor(
        kind="device",
        organization_id=store.organization_id,
        store_id=store.id,
        employee_id=employees["cashier"].id,
        employee_name=employees["cashier"].name,
        role="operator",
    )
    with pytest.raises(AppError) as excinfo:
        shifts_hooks.register_delivery_settlement_income(
            db,
            organization_id=store.organization_id,
            store_id=store.id,
            amount=50_000,
            actor=actor,
            courier_name="Operator",
        )
    assert excinfo.value.code == "NO_OPEN_SHIFT"
    assert excinfo.value.status == 409
    assert db.execute(select(CashMovement)).scalars().first() is None


def test_nothing_to_settle_is_a_business_rule_not_a_zero_settlement(
    delivery_order: Any, device_client: Any, employees: dict
) -> None:
    """`null` ≠ 0: sin efectivo pendiente no se crea una liquidación de
    `$0` (un cero mudo que después nadie sabe leer), se corta con `400`."""
    delivery_order()  # abre turno, sin cobrar
    resp = device_client.post(
        "/api/v1/delivery-settlements",
        json={"courier_employee_id": employees["operator"].id},
        headers=idem(),
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "NOTHING_TO_SETTLE"


def test_the_pending_list_groups_by_courier_and_never_calls_it_a_debt(
    delivery_order: Any, pay: Any, device_client: Any, employees: dict
) -> None:
    """CST art. 149: el sistema nunca calcula una deuda de un empleado. La
    lista dice qué efectivo falta entregar, con ese nombre."""
    order = delivery_order()
    total = order["totals"]["total"]
    assert pay(order, splits=[{"method": "cash", "amount": total, "tendered": total}]).status_code == 201

    resp = device_client.get("/api/v1/delivery-settlements/pending")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] == total
    assert len(body["couriers"]) == 1
    courier = body["couriers"][0]
    assert courier["courier_employee_id"] == employees["operator"].id
    assert courier["payments_count"] == 1
    # Ningún campo del contrato se llama "deuda"/"debt"/"owes".
    flat = str(body).lower()
    for forbidden in ("debt", "deuda", "owes", "debe"):
        assert forbidden not in flat


def test_a_delivery_settlement_cannot_be_typed_as_a_manual_cash_movement(
    delivery_order: Any, device_client: Any, db: Session
) -> None:
    """Una causa que produce un solo camino del sistema no se puede cargar a
    mano: si no, habría dos puertas hacia el mismo efectivo y el cajón
    cuadraría el doble."""
    delivery_order()
    shift = _shift(db)
    resp = device_client.post(
        f"/api/v1/shifts/{shift.id}/cash-movements",
        json={"kind": "income", "cause": "delivery_settlement", "amount": 10_000},
        headers=idem(),
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "CAUSE_NOT_MANUAL"
