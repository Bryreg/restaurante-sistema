"""El MISMO billete mueve el esperado del turno lo MISMO, venga por donde venga.

Ronda 2 del pedido 2c — cierre del **hallazgo H-1 (bloqueante)** del auditor.

El hallazgo era que una venta en efectivo de $100.000 con $10.000 de propina
movía el esperado del turno:

- **+$100.000** por mostrador (la fórmula heredada de 1b sólo lee `.cash`, y
  la propina vive en `tips_cash` y se salda al cierre por
  `tips_cash_out`/`to_deposit`, `app/shifts/service.py:1035`), y
- **+$110.000** por domicilio liquidado, porque la liquidación mandaba
  `amount + tip_amount` al `CashMovement(kind=INCOME)`.

Dos matemáticas del esperado para la misma plata. La consecuencia es del
conteo a ciegas: la diferencia del arqueo cambiaba exactamente por el valor
de la propina según el canal, y quien cuenta tenía que justificar con causa
tipada una diferencia que no existe.

**La decisión de fondo** (del Maestro, no negociable): la matemática del
esperado es HEREDADA (1b) y ya está publicada por dos pedidos —
`expected = base + sales.cash + incomes − expenses − pickups`
(`app/shifts/service.py:259`)—. 2c no la reescribe: **es el código nuevo el
que se acomoda al invariante viejo**. Así que la liquidación mueve el
esperado por la VENTA sola, y la propina en efectivo del domicilio se trata
igual que la propina en efectivo de cualquier otra venta.

Estos tests leen el esperado ANTES y DESPUÉS por los dos caminos, con los
MISMOS números, e imprimen las cifras en el mensaje del assert.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.catalog.models import Category, Product
from app.core import clock as clock_module
from app.shifts import service as shifts_service
from app.shifts.models import CashMovement, CashMovementCause, CashMovementKind, Shift
from app.stores.models import Store
from tests.channels.conftest import idem

# Los números del contrato de esta ronda, los MISMOS por los dos caminos.
VENTA = 100_000
PROPINA = 10_000
CARGO_DOMICILIO = 6_000  # el precio del `delivery_fee_product` de la conftest


def _shift(db: Session) -> Shift:
    row = db.execute(select(Shift).order_by(Shift.id.desc())).scalars().first()
    assert row is not None
    return row


def _expected(db: Session) -> int:
    db.expire_all()
    return int(shifts_service.compute_breakdown(db, _shift(db))["expected"])


def _product(db: Session, store: Store, *, name: str, price: int) -> Product:
    """Un plato al precio pedido, INC 8 % incluido (como todo el consumo)."""
    now = clock_module.now_utc()
    category = Category(
        organization_id=store.organization_id,
        store_id=store.id,
        name=f"Paridad {name}",
        sort_order=71,
        default_course="main",
        default_station=None,
        active=True,
    )
    db.add(category)
    db.flush()
    row = Product(
        organization_id=store.organization_id,
        store_id=store.id,
        category_id=category.id,
        name=name,
        description=None,
        station=None,
        default_course="main",
        price_dine_in=price,
        price_takeout=None,
        price_delivery=None,
        price_platform=None,
        tax_code="inc_8",
        active=True,
        available=True,
        daily_count=None,
        daily_remaining=None,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _add_item(device_client: Any, order: dict[str, Any], product: Product) -> dict[str, Any]:
    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={"expected_version": order["version"], "items": [{"product_id": product.id, "qty": 1}]},
        headers=idem(),
    )
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] = resp.json()
    return body


def _pay_cash_with_tip(device_client: Any, order: dict[str, Any], *, tip: int) -> dict[str, Any]:
    total = order["totals"]["total"]
    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/payments",
        json={
            "pin": "1111",
            "splits": [{"method": "cash", "amount": total + tip, "tendered": total + tip}],
            "tip": {"asked": True, "accepted": tip > 0, "modified": False, "amount": tip},
        },
        headers=idem(),
    )
    assert resp.status_code == 201, resp.text
    body: dict[str, Any] = resp.json()
    return body


def _counter_sale(device_client: Any, db: Session, store: Store, *, tip: int) -> int:
    """Venta de mostrador de $100.000 cobrada en efectivo, con propina.
    Devuelve el total de la comanda (la VENTA, sin la propina)."""
    product = _product(db, store, name="Plato mostrador", price=VENTA)
    resp = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem())
    assert resp.status_code == 201, resp.text
    order = _add_item(device_client, resp.json(), product)
    total = int(order["totals"]["total"])
    assert total == VENTA, f"la venta de mostrador tenía que ser {VENTA} y es {total}"
    _pay_cash_with_tip(device_client, order, tip=tip)
    return total


def _delivery_sale(device_client: Any, db: Session, store: Store, employees: dict, *, tip: int) -> int:
    """Domicilio propio por los MISMOS $100.000 cobrados en efectivo, con la
    misma propina. El plato vale $94.000 y el cargo de domicilio entra como
    LÍNEA por $6.000: la venta total es exactamente la de mostrador."""
    product = _product(db, store, name="Plato domicilio", price=VENTA - CARGO_DOMICILIO)
    resp = device_client.post(
        "/api/v1/orders",
        json={
            "channel": "delivery",
            "delivery": {
                "address": "Calle 1 #2-3",
                "phone": "3001234567",
                "courier_employee_id": employees["operator"].id,
            },
        },
        headers=idem(),
    )
    assert resp.status_code == 201, resp.text
    order = _add_item(device_client, resp.json(), product)
    total = int(order["totals"]["total"])
    assert total == VENTA, (
        f"la venta de domicilio (plato {VENTA - CARGO_DOMICILIO} + cargo {CARGO_DOMICILIO} como línea) "
        f"tenía que ser {VENTA} y es {total}"
    )
    _pay_cash_with_tip(device_client, order, tip=tip)
    return total


def _settle(device_client: Any, employees: dict) -> dict[str, Any]:
    resp = device_client.post(
        "/api/v1/delivery-settlements",
        json={"courier_employee_id": employees["operator"].id},
        headers=idem(),
    )
    assert resp.status_code == 201, resp.text
    body: dict[str, Any] = resp.json()
    return body


# ---------------------------------------------------------------------------
# H-1: la ida
# ---------------------------------------------------------------------------


def test_the_same_cash_moves_the_expected_by_the_same_amount_through_both_channels(
    device_client: Any,
    identify: Any,
    employees: dict,
    open_shift: Any,
    channels_on: None,
    delivery_fee_product: Product,
    db: Session,
    store: Store,
) -> None:
    """**Cierre de H-1.** Los MISMOS números por los dos caminos: venta de
    $100.000 más $10.000 de propina, cobradas en efectivo.

    Mostrador y domicilio liquidado tienen que mover el esperado exactamente
    **+$100.000** los dos. La propina no mueve el esperado por ningún
    camino: se salda al cierre por `tips_cash_out`/`to_deposit`.
    """
    open_shift()
    identify(device_client, employees["cashier"])

    antes_mostrador = _expected(db)
    venta_mostrador = _counter_sale(device_client, db, store, tip=PROPINA)
    delta_mostrador = _expected(db) - antes_mostrador

    antes_domicilio = _expected(db)
    venta_domicilio = _delivery_sale(device_client, db, store, employees, tip=PROPINA)
    # Mientras el domiciliario tiene la plata, el esperado NO se movió.
    assert _expected(db) == antes_domicilio, (
        f"el efectivo que todavía tiene el domiciliario movió el esperado de {antes_domicilio} a "
        f"{_expected(db)}: se arquea APARTE hasta que liquida"
    )
    liquidacion = _settle(device_client, employees)
    delta_domicilio = _expected(db) - antes_domicilio

    # Los números a la vista, como hace `test_platform_expected_cash.py`: leer un
    # renglón del checklist pasar sin ver las cifras no convence a nadie.
    print(
        f"[esperado de caja] venta={VENTA} propina={PROPINA} | "
        f"mostrador: antes={antes_mostrador} despues={antes_mostrador + delta_mostrador} "
        f"delta={delta_mostrador} | domicilio liquidado: antes={antes_domicilio} "
        f"despues={antes_domicilio + delta_domicilio} delta={delta_domicilio}"
    )

    assert venta_mostrador == venta_domicilio == VENTA
    assert liquidacion["amount"] == VENTA, (
        f"la liquidación registró una venta de {liquidacion['amount']} y tenía que ser {VENTA}"
    )
    assert liquidacion["tip_amount"] == PROPINA, (
        "el domiciliario entrega venta + propina y las dos se siguen registrando; "
        f"la propina registrada es {liquidacion['tip_amount']} y tenía que ser {PROPINA}"
    )
    assert liquidacion["total"] == VENTA + PROPINA, (
        f"el total entregado por el domiciliario es {liquidacion['total']} y tenía que ser "
        f"{VENTA + PROPINA}: la propina se sigue entregando, sólo que no mueve el esperado"
    )

    assert delta_mostrador == VENTA, (
        f"una venta de mostrador de {VENTA} en efectivo con {PROPINA} de propina movió el esperado "
        f"{delta_mostrador} y tenía que moverlo {VENTA}: la propina en efectivo NO entra al esperado "
        "(se salda al cierre por `tips_cash_out`/`to_deposit`)"
    )
    assert delta_domicilio == VENTA, (
        f"un domicilio de {VENTA} en efectivo con {PROPINA} de propina, liquidado, movió el esperado "
        f"{delta_domicilio} y tenía que moverlo {VENTA}: la liquidación entra al cajón por la VENTA sola"
    )
    assert delta_mostrador == delta_domicilio, (
        f"el mismo billete mueve el esperado distinto según el canal: mostrador {delta_mostrador}, "
        f"domicilio liquidado {delta_domicilio}, con la misma venta ({VENTA}) y la misma propina "
        f"({PROPINA}). Son dos matemáticas del esperado para la misma plata, y la diferencia del "
        "arqueo a ciegas cambiaría por el valor de la propina según el canal"
    )


def test_the_settlement_cash_movement_is_written_for_the_sale_alone(
    device_client: Any,
    identify: Any,
    employees: dict,
    open_shift: Any,
    channels_on: None,
    delivery_fee_product: Product,
    db: Session,
    store: Store,
) -> None:
    """El `CashMovement` de la IDA, mirado de cerca: causa tipada, `INCOME`,
    y **`amount` = la venta sola**, no venta + propina."""
    open_shift()
    identify(device_client, employees["cashier"])
    _delivery_sale(device_client, db, store, employees, tip=PROPINA)

    liquidacion = _settle(device_client, employees)
    db.expire_all()

    movimiento = db.get(CashMovement, liquidacion["cash_movement_id"])
    assert movimiento is not None
    assert movimiento.kind == CashMovementKind.INCOME
    assert movimiento.cause == CashMovementCause.DELIVERY_SETTLEMENT, "causa TIPADA, nunca texto libre"
    assert movimiento.amount == VENTA, (
        f"el ingreso de la liquidación se escribió por {movimiento.amount} y tenía que escribirse por "
        f"{VENTA} (la venta sola). Con {VENTA + PROPINA} el esperado del turno subiría por la propina, "
        "que en ningún otro camino del sistema lo mueve"
    )


# ---------------------------------------------------------------------------
# H-1: la vuelta
# ---------------------------------------------------------------------------


def test_undoing_a_settlement_leaves_the_expected_exactly_where_it_was(
    device_client: Any,
    identify: Any,
    employees: dict,
    open_shift: Any,
    channels_on: None,
    delivery_fee_product: Product,
    db: Session,
    store: Store,
) -> None:
    """La VUELTA es el espejo EXACTO de la ida: mismo monto, kind opuesto,
    misma causa tipada. Liquidar y deshacer deja el esperado donde estaba, y
    el movimiento original queda VIVO (nada financiero se borra)."""
    open_shift()
    identify(device_client, employees["cashier"])
    _delivery_sale(device_client, db, store, employees, tip=PROPINA)

    antes = _expected(db)
    liquidacion = _settle(device_client, employees)
    despues_de_liquidar = _expected(db)
    assert despues_de_liquidar == antes + VENTA, (
        f"liquidar movió el esperado de {antes} a {despues_de_liquidar}; tenía que moverlo {VENTA}"
    )

    anulacion = device_client.post(
        f"/api/v1/delivery-settlements/{liquidacion['id']}/void",
        json={"reason": "El domiciliario entregó de menos y se recuenta"},
        headers=idem(),
    )
    assert anulacion.status_code == 200, anulacion.text
    cuerpo = anulacion.json()
    db.expire_all()

    despues_de_deshacer = _expected(db)
    print(
        f"[ida y vuelta] antes={antes} despues_de_liquidar={despues_de_liquidar} "
        f"despues_de_deshacer={despues_de_deshacer}"
    )
    assert despues_de_deshacer == antes, (
        f"deshacer la liquidación dejó el esperado en {despues_de_deshacer} y tenía que dejarlo en "
        f"{antes}: si la ida movió el esperado por la venta ({VENTA}), la vuelta lo devuelve por la "
        "venta. Un espejo que no es espejo fabrica un faltante o un sobrante en el arqueo"
    )

    original = db.get(CashMovement, liquidacion["cash_movement_id"])
    espejo = db.get(CashMovement, cuerpo["void_cash_movement_id"])
    assert original is not None and espejo is not None
    assert original.amount == espejo.amount == VENTA, (
        f"la ida movió {original.amount} y la vuelta {espejo.amount}: el espejo tiene que ser exacto"
    )
    assert espejo.kind == CashMovementKind.EXPENSE
    assert espejo.cause == CashMovementCause.DELIVERY_SETTLEMENT
    assert espejo.id != original.id, "el original queda VIVO: nada financiero se borra"

    # Y el efectivo vuelve a estar PENDIENTE, venta y propina.
    breakdown = shifts_service.compute_breakdown(db, _shift(db))
    assert breakdown["delivery_cash_pending"] == VENTA + PROPINA, (
        "el renglón informativo del desglose sí suma venta + propina: es cierto que el domiciliario "
        "sostiene las dos cosas. Lo que no mueve el esperado es la propina"
    )
