"""**La regla que más fácil se rompe de todo el pedido 2c.**

Renglón textual del checklist: «Una venta cobrada por plataforma NO mueve el
efectivo esperado del turno (test: abrir turno, vender por plataforma,
comparar el esperado antes y después)».

Una venta cobrada por plataforma es una CUENTA POR COBRAR contra la
plataforma, no plata en el cajón. `compute_breakdown`
(`app/shifts/service.py`) es la única matemática del esperado y no la puede
mover.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.channels.models import PlatformCommission, PlatformReceivable
from app.payments.models import Payment
from app.shifts import service as shifts_service
from app.shifts.models import Shift


def test_a_platform_sale_does_not_move_the_expected_cash_of_the_shift(
    platform_order: Any, pay: Any, db: Session
) -> None:
    order = platform_order()
    shift = db.get(Shift, order["shift_id"]) if "shift_id" in order else None
    if shift is None:
        shift = db.execute(select(Shift).order_by(Shift.id.desc())).scalars().first()
    assert shift is not None

    # 1. El esperado ANTES de vender.
    expected_before = shifts_service.compute_breakdown(db, shift)["expected"]
    assert expected_before == shift.opening_cash_total

    # 2. Vender por plataforma.
    total = order["totals"]["total"]
    resp = pay(order, splits=[{"method": "platform", "amount": total}])
    assert resp.status_code == 201, resp.text
    body = resp.json()
    db.expire_all()

    # 3. El esperado DESPUÉS. **No cambió.**
    expected_after = shifts_service.compute_breakdown(db, shift)["expected"]
    # Los números, a la vista de quien corra la suite con `-s`: este test es
    # el renglón del checklist que más fácil se rompe, y leerlo pasar sin
    # ver las cifras no convence a nadie.
    print(
        f"\n[esperado de caja] antes={expected_before} "
        f"venta_por_plataforma={total} despues={expected_after}"
    )
    assert expected_after == expected_before, (
        "una venta cobrada por plataforma movió el efectivo esperado del turno: "
        f"{expected_before} -> {expected_after}. Es una cuenta por cobrar, no plata en el cajón"
    )

    # Y la venta sí quedó registrada (no es que no pasó nada).
    breakdown = shifts_service.compute_breakdown(db, shift)
    assert breakdown["cash_sales"] == 0
    assert breakdown["incomes"] == 0
    assert body["total"] == total


def test_the_platform_payment_is_not_cash_and_lands_in_other(
    platform_order: Any, pay: Any, db: Session
) -> None:
    """El pago existe, no entra a `.cash`, y cae en `.other` — que es donde
    `app.shifts.hooks._OTHER_METHODS` lo manda desde 1b-1 y que
    `compute_breakdown` nunca suma."""
    from app.shifts import hooks

    order = platform_order()
    total = order["totals"]["total"]
    assert pay(order, splits=[{"method": "platform", "amount": total}]).status_code == 201
    db.expire_all()

    shift = db.execute(select(Shift).order_by(Shift.id.desc())).scalars().first()
    assert shift is not None
    totals = hooks.get_sales_totals(db, shift.id)
    assert totals.cash == 0
    assert totals.other == total
    assert totals.delivery_cash == 0


def test_the_sale_is_the_sale_and_the_commission_lives_somewhere_else(
    platform_order: Any, pay: Any, db: Session
) -> None:
    """Venta de $100.000 con comisión de 18 %: la venta reportada sigue
    siendo $100.000 y la comisión registrada es $18.000, **en dos lugares
    distintos**."""
    order = platform_order()
    total = order["totals"]["total"]
    assert total == 100_000, "la fixture vende exactamente el monto del ejemplo del contrato"

    resp = pay(order, splits=[{"method": "platform", "amount": total}])
    assert resp.status_code == 201, resp.text
    body = resp.json()
    db.expire_all()

    # Lugar 1 — la VENTA. Ni el total, ni el pago, ni el documento fiscal
    # saben nada de la comisión.
    assert body["total"] == 100_000
    assert body["amount_due"] == 100_000
    payment = db.execute(select(Payment).where(Payment.order_id == order["id"])).scalar_one()
    assert payment.amount == 100_000
    assert payment.method == "platform"

    document_total = body["document"]
    assert document_total is not None

    # Lugar 2 — el COSTO, en su propia tabla.
    commission = db.execute(
        select(PlatformCommission).where(PlatformCommission.order_id == order["id"])
    ).scalar_one()
    assert commission.amount == 18_000
    assert commission.base_amount == 100_000
    assert commission.commission_bp == 1_800
    assert commission.kind.value == "charge"

    # Y la cuenta por cobrar, sin netear.
    receivable = db.execute(
        select(PlatformReceivable).where(PlatformReceivable.order_id == order["id"])
    ).scalar_one()
    assert receivable.amount == 100_000, "la cuenta por cobrar NO sale neteada de comisión"
    assert receivable.status.value == "pending"

    # El contrato de salida lo publica aparte, nunca restado.
    assert body["platform_commission"] == 18_000
    assert body["platform_receivable_id"] == receivable.id


def test_the_platform_method_is_rejected_on_a_non_platform_channel(
    device_client: Any,
    identify: Any,
    employees: dict,
    open_shift: Any,
    drink_product: Any,
    platform: Any,
    channels_on: None,
    pay: Any,
    db: Session,
) -> None:
    """Sin esto, cualquier venta de mesa podría salir del efectivo esperado
    del turno declarándose "cobrada por la plataforma"."""
    from tests.channels.conftest import idem

    open_shift()
    identify(device_client, employees["cashier"])
    resp = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem())
    assert resp.status_code == 201, resp.text
    order = resp.json()
    items = device_client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={"expected_version": order["version"], "items": [{"product_id": drink_product.id, "qty": 1}]},
        headers=idem(),
    )
    assert items.status_code == 200, items.text
    order = items.json()

    out = pay(order, splits=[{"method": "platform", "amount": order["totals"]["total"]}])
    assert out.status_code == 400, out.text
    assert out.json()["error"]["code"] == "PLATFORM_METHOD_WRONG_CHANNEL"

    # Y no escribió nada: la comanda sigue abierta y sin pagos.
    db.expire_all()
    assert db.execute(select(Payment).where(Payment.order_id == order["id"])).scalars().first() is None
