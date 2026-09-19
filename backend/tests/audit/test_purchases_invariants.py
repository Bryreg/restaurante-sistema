"""Invariantes ejecutables de COMPRAS (pedido 2b).

Cada test de este archivo es un renglón del `spec.md § Verificación del pedido
2b (checklist de entrega)` convertido en enunciado ejecutable. No prueban
funcionalidad: prueban **garantías** — plata cobrada, integridad del libro,
que nada financiero se borre, y que el operador del salón no vea un costo.

Los cruces de territorio son donde caen los rojos (lección de
`outputs-2a/ENTREGA.md § 7`), así que acá se concentran los tres que este
pedido tiene: `purchases -> inventory` (lote + promedio ponderado),
`purchases -> shifts` (el egreso del cajón) y `purchases -> stores` (INC vs
IVA).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from tests.audit.conftest import (
    OPENING_FIXED,
    denoms,
    idem_headers,
    lots_of,
    make_ingredient,
    make_supplier,
    post_reception,
    reception_line,
    set_iva_regime,
    stock_of,
)

API = "/api/v1"


def _movements(db: Any, store: Any, *, ingredient_id: int) -> list[Any]:
    from sqlalchemy import select

    from app.inventory.models import StockMovement

    return list(
        db.execute(
            select(StockMovement)
            .where(StockMovement.store_id == store.id, StockMovement.ingredient_id == ingredient_id)
            .order_by(StockMovement.id)
        ).scalars()
    )


# ---------------------------------------------------------------------------
# (a) Atomicidad de la recepción — el test que más caro sale si falta.
# ---------------------------------------------------------------------------


def test_a_confirmed_reception_leaves_movement_lot_average_and_payable_in_one_transaction(
    admin_client: Any, store: Any, db: Any
) -> None:
    """Checklist 2b: «Una recepción confirmada deja, en una sola transacción,
    un movimiento por línea, un lote con vencimiento y costo, el promedio
    ponderado recalculado y una cuenta por pagar en `pending_review`»."""
    from app.inventory.models import MovementCause

    a = make_ingredient(admin_client, store, name="Tomate", official_cost=None, min_stock="1000")
    b = make_ingredient(admin_client, store, name="Cebolla", official_cost=None, min_stock="1000")
    supplier = make_supplier(admin_client, store)

    body = post_reception(
        admin_client,
        store,
        [
            reception_line(a["id"], qty_received="10000", purchase_unit_price="12000", lot_code="L-A", expires_at="2026-03-01"),
            reception_line(b["id"], qty_received="5000", purchase_unit_price="3000", lot_code="L-B", expires_at="2026-04-01"),
        ],
        supplier_id=supplier["id"],
    )

    # 1) Un movimiento por línea, con la causa tipada `purchase`.
    for ing in (a, b):
        movs = [m for m in _movements(db, store, ingredient_id=ing["id"]) if m.cause == MovementCause.PURCHASE]
        assert len(movs) == 1, f"{ing['name']}: {len(movs)} movimientos de compra, se esperaba exactamente 1"
        assert movs[0].qty_base > 0
        assert movs[0].cost_micros is not None and movs[0].cost_source.value != "none", (
            "un movimiento de compra sin costo con origen es el cero mudo que la spec prohíbe"
        )

    # 2) Un lote por línea, con vencimiento y costo.
    for ing, code, expires in ((a, "L-A", "2026-03-01"), (b, "L-B", "2026-04-01")):
        lots = lots_of(db, store, ingredient_id=ing["id"])
        assert len(lots) == 1, f"{ing['name']}: {len(lots)} lotes, se esperaba 1"
        assert lots[0].lot_code == code
        assert lots[0].expires_at is not None and lots[0].expires_at.isoformat() == expires
        assert lots[0].unit_cost_micros > 0
        assert lots[0].qty_remaining == lots[0].qty_received

    # 3) El promedio ponderado ya está recalculado (se DERIVA de los lotes).
    from app.inventory import hooks as inventory_hooks

    for ing in (a, b):
        avg = inventory_hooks.weighted_average_cost_micros(db, store_id=store.id, ingredient_id=ing["id"])
        assert avg is not None and avg > 0, f"{ing['name']}: el promedio ponderado no se movió con la compra"

    # 4) Una cuenta por pagar en `pending_review`.
    payables = admin_client.get(f"{API}/admin/payables?store_id={store.id}").json()
    assert len(payables) == 1, f"se esperaba 1 cuenta por pagar, hay {len(payables)}"
    assert payables[0]["status"] == "pending_review"
    assert payables[0]["reception_id"] == body["id"]
    assert payables[0]["balance"] == payables[0]["amount"] > 0


def test_a_failure_injected_on_the_last_line_leaves_nothing_behind(
    admin_client: Any, store: Any, db: Any, monkeypatch: Any
) -> None:
    """Checklist 2b: «Si algo falla no queda **nada** (test de atomicidad, con
    un fallo inyectado en la última línea)».

    El fallo se inyecta en `app.purchases.hooks.create_stock_batch`, que es el
    cruce real `purchases -> inventory`: en la SEGUNDA línea, después de que
    la primera ya escribió movimiento y lote. Si la transacción no fuera una
    sola, quedaría media recepción: stock de la línea 1 sumado, lote de la
    línea 1 vivo y ninguna cuenta por pagar — el modo de falla más caro de
    este pedido, porque el inventario queda diciendo que entró mercancía que
    nadie va a pagar.
    """
    from app.purchases import hooks as purchases_hooks
    from app.purchases.models import Payable, Reception

    a = make_ingredient(admin_client, store, name="Tomate", official_cost=None, min_stock="1000")
    b = make_ingredient(admin_client, store, name="Cebolla", official_cost=None, min_stock="1000")
    supplier = make_supplier(admin_client, store)

    stock_a_before = stock_of(db, store, ingredient_id=a["id"])
    original = purchases_hooks.create_stock_batch
    calls = {"n": 0}

    def _exploding(*args: Any, **kwargs: Any) -> Any:
        calls["n"] += 1
        if calls["n"] == 2:
            # NO es un `AppError`: `app.core.db.get_db` comitea ante un
            # `AppError` a propósito, así que un fallo de negocio a mitad de
            # escritura NO probaría atomicidad. El fallo inyectado tiene que
            # ser el que de verdad hace `rollback()`.
            raise RuntimeError("fallo inyectado en la última línea")
        return original(*args, **kwargs)

    monkeypatch.setattr(purchases_hooks, "create_stock_batch", _exploding)

    with pytest.raises(RuntimeError):
        post_reception(
            admin_client,
            store,
            [
                reception_line(a["id"], qty_received="10000", purchase_unit_price="12000", lot_code="L-A"),
                reception_line(b["id"], qty_received="5000", purchase_unit_price="3000", lot_code="L-B"),
            ],
            supplier_id=supplier["id"],
            expect=None,
        )

    db.expire_all()
    from sqlalchemy import func, select

    assert calls["n"] == 2, "el fallo no llegó a la segunda línea: el test no probó lo que dice"
    assert db.execute(select(func.count()).select_from(Reception)).scalar_one() == 0, "quedó una recepción a medias"
    assert db.execute(select(func.count()).select_from(Payable)).scalar_one() == 0, "quedó una cuenta por pagar"
    assert lots_of(db, store, ingredient_id=a["id"]) == [], "quedó vivo el lote de la línea 1"
    assert _movements(db, store, ingredient_id=a["id"]) == [], "quedó el movimiento de la línea 1"
    assert stock_of(db, store, ingredient_id=a["id"]) == stock_a_before


# ---------------------------------------------------------------------------
# (b) El IVA bajo INC es mayor valor del costo (§4.1). Ignorarlo subestima
#     el costo cerca de 19 %.
# ---------------------------------------------------------------------------


def test_the_tax_enters_the_cost_under_inc_and_the_difference_is_exactly_the_tax(
    admin_client: Any, store: Any, db: Any
) -> None:
    """Checklist 2b: «dos recepciones idénticas, una bajo INC y otra bajo IVA,
    dejan costos distintos y la diferencia es exactamente el IVA»."""
    ing_inc = make_ingredient(admin_client, store, name="Bajo INC", official_cost=None, min_stock="1000")
    supplier = make_supplier(admin_client, store)

    def _linea(ingredient_id: int) -> dict[str, Any]:
        """La MISMA línea, dos veces: sólo cambia el régimen de la sede."""
        return reception_line(
            ingredient_id,
            qty_received="10000",
            qty_invoiced="10000",
            purchase_unit_price="12000",
            tax_base=120_000,
            tax_rate=19,
            tax_amount=22_800,
        )

    post_reception(admin_client, store, [_linea(ing_inc["id"])], supplier_id=supplier["id"])
    lote_inc = lots_of(db, store, ingredient_id=ing_inc["id"])[0]

    # La misma compra, la misma sede, pero responsable de IVA (descontable).
    set_iva_regime(db, store)
    ing_iva = make_ingredient(admin_client, store, name="Bajo IVA", official_cost=None, min_stock="1000")
    post_reception(admin_client, store, [_linea(ing_iva["id"])], supplier_id=supplier["id"])
    lote_iva = lots_of(db, store, ingredient_id=ing_iva["id"])[0]

    assert lote_inc.unit_cost_micros > lote_iva.unit_cost_micros, (
        "el impuesto de una compra bajo INC NO entró al costo: se está subestimando el costo "
        f"({lote_inc.unit_cost_micros} vs {lote_iva.unit_cost_micros} micros/unidad base)"
    )

    # La diferencia es EXACTAMENTE el impuesto repartido por unidad base.
    from app.core.quantity import COST_SCALE, QTY_SCALE

    esperado = (22_800 * COST_SCALE * QTY_SCALE) // 10_000_000  # 10.000 unidades base = 10.000 * QTY_SCALE milésimas
    assert lote_inc.unit_cost_micros - lote_iva.unit_cost_micros == esperado, (
        f"la diferencia es {lote_inc.unit_cost_micros - lote_iva.unit_cost_micros}, se esperaba exactamente {esperado}"
    )
    # Y el orden de magnitud es el que la spec nombra: 19 % sobre la base.
    assert lote_iva.unit_cost_micros * 119 // 100 == lote_inc.unit_cost_micros


# ---------------------------------------------------------------------------
# (c) Las dos guardas de tecleo PREGUNTAN y no corrigen solas.
# ---------------------------------------------------------------------------


def test_the_two_typing_guards_ask_and_never_self_correct(admin_client: Any, store: Any, db: Any) -> None:
    """Checklist 2b: «precio 10–12 × la referencia y salto > 15 % contra el
    promedio; confirmadas pasan y queda quién confirmó»."""
    ing = make_ingredient(admin_client, store, name="Tomate", official_cost=None, min_stock="1000")
    supplier = make_supplier(admin_client, store)

    # Referencia: una compra normal a $12/unidad base.
    post_reception(admin_client, store, [reception_line(ing["id"], purchase_unit_price="12000")], supplier_id=supplier["id"])
    lotes_antes = len(lots_of(db, store, ingredient_id=ing["id"]))

    # 11 × la referencia: precio de empaque tecleado como precio unitario.
    resp = post_reception(
        admin_client, store, [reception_line(ing["id"], purchase_unit_price="132000")], supplier_id=supplier["id"], expect=None
    )
    assert resp.status_code == 409, resp.text
    assert resp.json()["error"]["code"] == "PRICE_LOOKS_LIKE_PACKAGE"
    assert len(lots_of(db, store, ingredient_id=ing["id"])) == lotes_antes, "la guarda escribió igual"

    # > 15 % contra el promedio, sin llegar a 10 ×.
    resp = post_reception(
        admin_client, store, [reception_line(ing["id"], purchase_unit_price="20000")], supplier_id=supplier["id"], expect=None
    )
    assert resp.status_code == 409, resp.text
    assert resp.json()["error"]["code"] == "PRICE_JUMP"
    assert len(lots_of(db, store, ingredient_id=ing["id"])) == lotes_antes

    # Confirmada explícitamente: pasa, y queda quién confirmó. La guarda
    # nunca "corrige" el precio: el lote entra con el precio tecleado.
    body = post_reception(
        admin_client,
        store,
        [reception_line(ing["id"], purchase_unit_price="20000")],
        supplier_id=supplier["id"],
        confirm_price=True,
    )
    assert body["price_confirmed"] is True
    assert body["price_confirmed_by_employee_name"], "no quedó registrado quién confirmó el precio"
    assert body["lines"][0]["unit_cost"] == "20", "la guarda corrigió el precio sola en vez de preguntar"


# ---------------------------------------------------------------------------
# (d) El saldo de una cuenta por pagar SE DERIVA. Aprobar antes de pagar.
# ---------------------------------------------------------------------------


def test_the_payable_has_no_stored_balance_column(db: Any) -> None:
    """Checklist 2b: «no existe ningún campo `balance` guardado (test y
    revisión del modelo)». Por inspección del modelo Y de la tabla real: un
    saldo guardado es una segunda fuente de verdad, y la regla dura de
    `AGENTS.md` («una sola matemática, en el backend») la prohíbe."""
    from app.purchases.models import Payable

    columnas = {c.name for c in Payable.__table__.columns}
    assert "balance" not in columnas, f"`payables` guarda un saldo: {sorted(columnas)}"
    assert "paid_amount" not in columnas and "amount_paid" not in columnas, (
        f"`payables` guarda un acumulado de pagos, que es el mismo saldo con otro nombre: {sorted(columnas)}"
    )


def test_voiding_a_payment_returns_it_to_the_derived_balance(admin_client: Any, store: Any, db: Any) -> None:
    """Checklist 2b: «anular un pago lo devuelve al saldo». Y nada se borra:
    el pago anulado sigue existiendo, con motivo y con quién lo anuló."""
    ing = make_ingredient(admin_client, store, name="Tomate", official_cost=None, min_stock="1000")
    supplier = make_supplier(admin_client, store)
    post_reception(admin_client, store, [reception_line(ing["id"])], supplier_id=supplier["id"])
    payable = admin_client.get(f"{API}/admin/payables?store_id={store.id}").json()[0]
    total = payable["amount"]

    aprobar = admin_client.post(f"{API}/admin/payables/{payable['id']}/approve", json={"authorizer_pin": "9999"})
    assert aprobar.status_code == 200, aprobar.text

    pago = admin_client.post(
        f"{API}/admin/payables/{payable['id']}/payments",
        headers=idem_headers(),
        json={
            "amount": total // 3,
            "method": "transfer",
            "paid_at": "2026-01-16T10:00:00Z",
            "from_cash_drawer": False,
            "authorizer_pin": "9999",
        },
    )
    assert pago.status_code == 201, pago.text
    despues = admin_client.get(f"{API}/admin/payables?store_id={store.id}").json()[0]
    assert despues["balance"] == total - total // 3

    anular = admin_client.post(
        f"{API}/admin/payables/{payable['id']}/payments/{pago.json()['id']}/void",
        json={"reason": "Se pagó dos veces por error", "authorizer_pin": "9999"},
    )
    assert anular.status_code == 200, anular.text
    assert anular.json()["voided_at"] is not None
    assert anular.json()["voided_reason"] == "Se pagó dos veces por error"

    vuelto = admin_client.get(f"{API}/admin/payables?store_id={store.id}").json()[0]
    assert vuelto["balance"] == total, "anular un pago no devolvió la plata al saldo"

    # Nada financiero se borra: la fila del pago sigue ahí.
    from sqlalchemy import func, select

    from app.purchases.models import Payment

    assert db.execute(select(func.count()).select_from(Payment)).scalar_one() == 1, "el pago anulado se borró"


def test_paying_before_approving_is_409(admin_client: Any, store: Any) -> None:
    """Checklist 2b: «Una cuenta por pagar no se puede pagar antes de ser
    aprobada»: es el control mínimo entre quien recibe y quien paga."""
    ing = make_ingredient(admin_client, store, name="Tomate", official_cost=None, min_stock="1000")
    supplier = make_supplier(admin_client, store)
    post_reception(admin_client, store, [reception_line(ing["id"])], supplier_id=supplier["id"])
    payable = admin_client.get(f"{API}/admin/payables?store_id={store.id}").json()[0]
    assert payable["status"] == "pending_review"

    resp = admin_client.post(
        f"{API}/admin/payables/{payable['id']}/payments",
        headers=idem_headers(),
        json={
            "amount": 1000,
            "method": "transfer",
            "paid_at": "2026-01-16T10:00:00Z",
            "from_cash_drawer": False,
            "authorizer_pin": "9999",
        },
    )
    assert resp.status_code == 409, resp.text
    assert resp.json()["error"]["code"] == "PAYABLE_NOT_APPROVED"


# ---------------------------------------------------------------------------
# (e) purchases -> shifts: el egreso del cajón, en la misma transacción.
# ---------------------------------------------------------------------------


def _approved_payable(admin_client: Any, store: Any) -> dict[str, Any]:
    ing = make_ingredient(admin_client, store, name="Tomate", official_cost=None, min_stock="1000")
    supplier = make_supplier(admin_client, store)
    post_reception(admin_client, store, [reception_line(ing["id"])], supplier_id=supplier["id"])
    payable = admin_client.get(f"{API}/admin/payables?store_id={store.id}").json()[0]
    resp = admin_client.post(f"{API}/admin/payables/{payable['id']}/approve", json={"authorizer_pin": "9999"})
    assert resp.status_code == 200, resp.text
    return payable


def test_a_cash_payment_creates_the_shift_expense_in_the_same_transaction(
    admin_client: Any, store: Any, db: Any, open_shift: Any
) -> None:
    """Checklist 2b: «Un pago en efectivo desde el cajón crea el egreso en el
    turno abierto **en la misma transacción**».

    Es el cruce `purchases -> shifts`, y `app/shifts/**` fue el único huérfano
    sin dueño de 2a — exactamente donde cayó el hallazgo A-2 de esa entrega.
    """
    from sqlalchemy import select

    from app.shifts.models import CashMovement, CashMovementKind

    payable = _approved_payable(admin_client, store)
    open_shift()

    resp = admin_client.post(
        f"{API}/admin/payables/{payable['id']}/payments",
        headers=idem_headers(),
        json={
            "amount": 50_000,
            "method": "cash",
            "paid_at": "2026-01-16T10:00:00Z",
            "from_cash_drawer": True,
            "authorizer_pin": "9999",
        },
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["cash_movement_id"] is not None, "el pago del cajón no dejó egreso de caja"

    movimiento = db.get(CashMovement, resp.json()["cash_movement_id"])
    assert movimiento is not None
    assert movimiento.kind == CashMovementKind.EXPENSE
    assert movimiento.amount == 50_000
    assert movimiento.cause.value == "supplier_payment", (
        f"la causa del egreso es `{movimiento.cause.value}`: tiene que ser tipada y propia, "
        "nunca una causa genérica reciclada (AGENTS.md: causa tipada en todo movimiento de caja)"
    )
    # Un solo egreso por el pago: la misma transacción, no dos caminos.
    egresos = list(
        db.execute(select(CashMovement).where(CashMovement.store_id == store.id, CashMovement.amount == 50_000)).scalars()
    )
    assert len(egresos) == 1


def test_without_an_open_shift_a_cash_payment_is_409_and_no_payment_is_left_behind(
    admin_client: Any, store: Any, db: Any
) -> None:
    """Checklist 2b: «sin turno abierto, `409` y **el pago no queda**».

    La mitad que más fácil se rompe es la segunda: `app.core.db.get_db`
    comitea también ante un `AppError`, así que un servicio que escriba la
    fila del pago ANTES de pedirle el egreso a `shifts` deja el pago vivo con
    el 409 en la mano — una cuenta por pagar que figura pagada y una caja que
    nunca sacó la plata.
    """
    from sqlalchemy import func, select

    from app.purchases.models import Payment

    payable = _approved_payable(admin_client, store)

    resp = admin_client.post(
        f"{API}/admin/payables/{payable['id']}/payments",
        headers=idem_headers(),
        json={
            "amount": 50_000,
            "method": "cash",
            "paid_at": "2026-01-16T10:00:00Z",
            "from_cash_drawer": True,
            "authorizer_pin": "9999",
        },
    )
    assert resp.status_code == 409, resp.text
    assert resp.json()["error"]["code"] == "NO_OPEN_SHIFT"

    db.expire_all()
    assert db.execute(select(func.count()).select_from(Payment)).scalar_one() == 0, "quedó el pago sin egreso de caja"
    saldo = admin_client.get(f"{API}/admin/payables?store_id={store.id}").json()[0]
    assert saldo["balance"] == saldo["amount"], "el saldo se movió con un pago que no existe"


# ---------------------------------------------------------------------------
# (f) Eliminar una recepción: revierte todo o falla con nombre propio.
# ---------------------------------------------------------------------------


def test_reversing_a_reception_undoes_everything_and_deletes_nothing(
    admin_client: Any, store: Any, db: Any
) -> None:
    from sqlalchemy import func, select

    from app.inventory.models import MovementCause
    from app.purchases.models import Reception, ReceptionLine

    ing = make_ingredient(admin_client, store, name="Tomate", official_cost=None, min_stock="1000")
    supplier = make_supplier(admin_client, store)
    antes = stock_of(db, store, ingredient_id=ing["id"])
    body = post_reception(admin_client, store, [reception_line(ing["id"], lot_code="L-1")], supplier_id=supplier["id"])

    resp = admin_client.request(
        "DELETE", f"{API}/admin/receptions/{body['id']}", json={"authorizer_pin": "9999"}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "reversed"

    db.expire_all()
    assert stock_of(db, store, ingredient_id=ing["id"]) == antes, "la reversa no devolvió el stock a su valor previo"

    # La reversa es un MOVIMIENTO con causa propia; nada se borra.
    movs = _movements(db, store, ingredient_id=ing["id"])
    causas = [m.cause for m in movs]
    assert MovementCause.PURCHASE in causas and MovementCause.RECEPTION_REVERSAL in causas, causas
    assert db.execute(select(func.count()).select_from(Reception)).scalar_one() == 1, "se borró la recepción"
    assert db.execute(select(func.count()).select_from(ReceptionLine)).scalar_one() == 1, "se borraron las líneas"
    assert lots_of(db, store, ingredient_id=ing["id"]), "se borró el lote en vez de revertirlo"
    assert lots_of(db, store, ingredient_id=ing["id"])[0].reversed_at is not None

    # La cuenta por pagar queda cancelada, no borrada.
    payables = admin_client.get(f"{API}/admin/payables?store_id={store.id}").json()
    assert len(payables) == 1 and payables[0]["status"] == "cancelled"


def test_reversing_a_reception_whose_lot_was_consumed_fails_by_name(
    admin_client: Any, store: Any, db: Any, device_client: Any, identify: Any, employees: Any, open_shift: Any
) -> None:
    """`409 LOT_CONSUMED`, el primero de los dos caminos con nombre propio."""
    # Sin costo oficial a propósito: con uno puesto, la guarda de tecleo
    # compara el precio tecleado contra ÉL (`_reference_cost_micros`) y este
    # caso se cortaría en `PRICE_JUMP` antes de llegar al lote.
    ing = make_ingredient(admin_client, store, name="Tomate", official_cost=None, min_stock="1000")
    supplier = make_supplier(admin_client, store)
    body = post_reception(admin_client, store, [reception_line(ing["id"], lot_code="L-1")], supplier_id=supplier["id"])

    # Una merma consume del lote por FEFO (dentro de `record_movement`).
    open_shift()
    identify(device_client, employees["operator"])
    merma = device_client.post(
        f"{API}/waste",
        headers=idem_headers(),
        json={"ingredient_id": ing["id"], "qty": "100", "type": "breakage", "employee_pin": "2222"},
    )
    assert merma.status_code == 201, merma.text
    db.expire_all()
    lote = lots_of(db, store, ingredient_id=ing["id"])[0]
    assert lote.qty_remaining < lote.qty_received, "la merma no consumió del lote: el caso no se armó"

    resp = admin_client.request(
        "DELETE", f"{API}/admin/receptions/{body['id']}", json={"authorizer_pin": "9999"}
    )
    assert resp.status_code == 409, resp.text
    assert resp.json()["error"]["code"] == "LOT_CONSUMED"


def test_reversing_a_reception_with_live_payments_fails_by_name(admin_client: Any, store: Any) -> None:
    """`409 PAYABLE_HAS_PAYMENTS`, el segundo camino con nombre propio."""
    ing = make_ingredient(admin_client, store, name="Tomate", official_cost=None, min_stock="1000")
    supplier = make_supplier(admin_client, store)
    body = post_reception(admin_client, store, [reception_line(ing["id"])], supplier_id=supplier["id"])
    payable = admin_client.get(f"{API}/admin/payables?store_id={store.id}").json()[0]
    admin_client.post(f"{API}/admin/payables/{payable['id']}/approve", json={"authorizer_pin": "9999"})
    pago = admin_client.post(
        f"{API}/admin/payables/{payable['id']}/payments",
        headers=idem_headers(),
        json={
            "amount": 1000,
            "method": "transfer",
            "paid_at": "2026-01-16T10:00:00Z",
            "from_cash_drawer": False,
            "authorizer_pin": "9999",
        },
    )
    assert pago.status_code == 201, pago.text

    resp = admin_client.request(
        "DELETE", f"{API}/admin/receptions/{body['id']}", json={"authorizer_pin": "9999"}
    )
    assert resp.status_code == 409, resp.text
    assert resp.json()["error"]["code"] == "PAYABLE_HAS_PAYMENTS"


# ---------------------------------------------------------------------------
# (g) Zona horaria, `min_stock`, idempotencia.
# ---------------------------------------------------------------------------


def test_a_reception_at_0030_is_sealed_with_the_business_day_of_the_shift(
    admin_client: Any, store: Any, db: Any, clock: Any
) -> None:
    """Checklist 2b: «una recepción a las 00:30 queda sellada con el día del
    turno». La sede corta a las 6 am (`cutoff_hour=6`): 00:30 del día 16
    todavía es la jornada del 15."""
    from datetime import date

    ing = make_ingredient(admin_client, store, name="Tomate", official_cost=None, min_stock="1000")
    supplier = make_supplier(admin_client, store)

    # 00:30 hora de Bogotá (UTC-5) del 16 de enero = 05:30 UTC del 16.
    clock.set(datetime(2026, 1, 16, 5, 30, tzinfo=timezone.utc))
    body = post_reception(admin_client, store, [reception_line(ing["id"])], supplier_id=supplier["id"])

    assert body["business_date"] == "2026-01-15", (
        f"la recepción de las 00:30 quedó sellada con {body['business_date']}: "
        "la fecha de negocio se derivó de UTC en vez del corte de la sede"
    )
    movs = _movements(db, store, ingredient_id=ing["id"])
    assert movs and movs[0].business_date == date(2026, 1, 15), (
        "el movimiento de inventario quedó con otra fecha de negocio que la recepción"
    )
    lote = lots_of(db, store, ingredient_id=ing["id"])[0]
    assert lote.business_date == date(2026, 1, 15)


def test_a_reception_cannot_create_ingredients_through_the_back_door(admin_client: Any, store: Any) -> None:
    """Invariante heredado #4 de `spec.md`: `min_stock` obligatorio ya existe;
    la recepción no puede crear insumos sin umbral por la puerta de atrás. Se
    prueba por los dos lados: la puerta de entrada sigue exigiéndolo, y la
    recepción **sólo acepta un `ingredient_id` que ya existe** (no hay
    `name` ni `create_if_missing` en su contrato)."""
    fallo = make_ingredient(admin_client, store, name="Sin umbral", min_stock="0", expect=400)
    assert fallo["_body"]["error"]["code"] == "MIN_STOCK_REQUIRED"

    from app.purchases.schemas import ReceptionLineIn

    campos = set(ReceptionLineIn.model_fields)
    assert "ingredient_id" in campos
    assert not (campos & {"ingredient_name", "name", "create_if_missing", "new_ingredient"}), (
        f"la línea de recepción puede crear un insumo sin pasar por `POST /admin/ingredients`: {sorted(campos)}"
    )

    supplier = make_supplier(admin_client, store)
    resp = post_reception(admin_client, store, [reception_line(999_999)], supplier_id=supplier["id"], expect=None)
    assert resp.status_code == 404, resp.text


def test_the_same_idempotency_key_never_duplicates_a_reception(admin_client: Any, store: Any, db: Any) -> None:
    ing = make_ingredient(admin_client, store, name="Tomate", official_cost=None, min_stock="1000")
    supplier = make_supplier(admin_client, store)
    headers = idem_headers()
    primero = post_reception(admin_client, store, [reception_line(ing["id"])], supplier_id=supplier["id"], headers=headers)
    segundo = post_reception(admin_client, store, [reception_line(ing["id"])], supplier_id=supplier["id"], headers=headers)
    assert primero["id"] == segundo["id"]
    assert len(lots_of(db, store, ingredient_id=ing["id"])) == 1, "la repetición duplicó el lote"
    assert len(admin_client.get(f"{API}/admin/payables?store_id={store.id}").json()) == 1


# ---------------------------------------------------------------------------
# (h) Las flags de 2b, en los dos estados, respetando las dependencias.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "flag,metodo,ruta,cuerpo",
    [
        ("purchases", "get", "/admin/suppliers", None),
        ("purchases", "get", "/admin/receptions", None),
        ("purchases", "get", "/admin/payables", None),
        ("inventory.counts", "get", "/admin/counts", None),
        ("inventory.variance", "get", "/admin/variance", None),
        ("inventory.variance", "get", "/admin/food-cost", None),
        ("inventory.variance", "get", "/admin/control-health", None),
        ("inventory.lots", "get", "/admin/lots", None),
    ],
)
def test_each_2b_capability_answers_400_feature_disabled_when_its_flag_is_off(
    admin_client: Any, store: Any, set_feature: Any, flag: str, metodo: str, ruta: str, cuerpo: Any
) -> None:
    """Checklist 2b, primer renglón: «con `purchases` apagada … las rutas
    nuevas responden `400 FEATURE_DISABLED`; ídem `inventory.counts`,
    `inventory.variance` e `inventory.lots`» (cada flag en los dos estados)."""
    encendida = getattr(admin_client, metodo)(f"{API}{ruta}?store_id={store.id}")
    assert encendida.status_code != 400 or encendida.json().get("error", {}).get("code") != "FEATURE_DISABLED", (
        f"{ruta} responde FEATURE_DISABLED con `{flag}` ENCENDIDA: {encendida.text[:200]}"
    )

    set_feature(flag, False, store_id=store.id)
    apagada = getattr(admin_client, metodo)(f"{API}{ruta}?store_id={store.id}")
    assert apagada.status_code == 400, f"{ruta} con `{flag}` apagada devolvió {apagada.status_code}: {apagada.text[:200]}"
    assert apagada.json()["error"]["code"] == "FEATURE_DISABLED"


def test_with_purchases_off_everything_2a_built_keeps_working(
    admin_client: Any, store: Any, db: Any, set_feature: Any, device_client: Any, identify: Any, employees: Any, open_shift: Any
) -> None:
    """Checklist 2b: «Con `purchases` apagada todo lo de 2a sigue igual»."""
    ing = make_ingredient(admin_client, store, name="Tomate", official_cost="10", min_stock="1000")
    set_feature("purchases", False, store_id=store.id)

    stock = admin_client.get(f"{API}/admin/inventory/stock?store_id={store.id}")
    assert stock.status_code == 200, stock.text
    assert any(r["ingredient_id"] == ing["id"] for r in stock.json())

    open_shift()
    identify(device_client, employees["operator"])
    merma = device_client.post(
        f"{API}/waste",
        headers=idem_headers(),
        json={"ingredient_id": ing["id"], "qty": "100", "type": "breakage", "employee_pin": "2222"},
    )
    assert merma.status_code == 201, merma.text
    assert admin_client.get(f"{API}/admin/waste?store_id={store.id}").status_code == 200


def test_the_declared_dependencies_between_2b_flags_are_enforced(admin_client: Any, store: Any) -> None:
    """«respetando sus dependencias declaradas»: `inventory.variance` requiere
    `inventory.counts`, y las tres primeras requieren `inventory.perpetual`.
    El backend lo hace cumplir al PRENDER y al APAGAR, no sólo en el
    catálogo."""
    from app.core.features import FEATURE_BY_KEY

    assert FEATURE_BY_KEY["purchases"].requires == ["inventory.perpetual"]
    assert FEATURE_BY_KEY["inventory.counts"].requires == ["inventory.perpetual"]
    assert FEATURE_BY_KEY["inventory.lots"].requires == ["inventory.perpetual"]
    assert FEATURE_BY_KEY["inventory.variance"].requires == ["inventory.counts"]

    # Apagar `inventory.counts` con `inventory.variance` encendida no puede
    # dejar la varianza colgando de un conteo que no existe.
    resp = admin_client.put(
        f"{API}/admin/features/inventory.counts?store_id={store.id}", json={"enabled": False}
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DEPENDENCY"

    # Y prender `inventory.variance` sin `inventory.counts` tampoco.
    admin_client.put(f"{API}/admin/features/inventory.variance?store_id={store.id}", json={"enabled": False})
    admin_client.put(f"{API}/admin/features/inventory.counts?store_id={store.id}", json={"enabled": False})
    resp = admin_client.put(
        f"{API}/admin/features/inventory.variance?store_id={store.id}", json={"enabled": True}
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DEPENDENCY"


# ---------------------------------------------------------------------------
# (i) Confiabilidad del proveedor y "nada financiero se borra".
# ---------------------------------------------------------------------------


def test_supplier_reliability_is_received_over_invoiced(admin_client: Any, store: Any) -> None:
    ing = make_ingredient(admin_client, store, name="Tomate", official_cost=None, min_stock="1000")
    supplier = make_supplier(admin_client, store)
    post_reception(
        admin_client,
        store,
        [reception_line(ing["id"], qty_received="9000", qty_invoiced="10000")],
        supplier_id=supplier["id"],
    )
    resp = admin_client.get(
        f"{API}/admin/suppliers/{supplier['id']}/reliability?from=2020-01-01&to=2099-12-31"
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["receptions"] == 1
    assert body["received_over_invoiced_pct"] == 90, body
    assert body["invoice_share_pct"] == 100


def test_deleting_a_supplier_is_a_logical_deactivation(admin_client: Any, store: Any, db: Any) -> None:
    from sqlalchemy import func, select

    from app.purchases.models import Supplier

    supplier = make_supplier(admin_client, store)
    resp = admin_client.delete(f"{API}/admin/suppliers/{supplier['id']}")
    assert resp.status_code == 200, resp.text
    assert resp.json()["active"] is False
    assert db.execute(select(func.count()).select_from(Supplier)).scalar_one() == 1, "se borró el proveedor"


def test_a_duplicate_nit_is_refused_by_name(admin_client: Any, store: Any) -> None:
    """«nunca texto libre (41 grafías para 23 proveedores en la referencia)»."""
    make_supplier(admin_client, store, name="Distribuidora X", nit="900111222")
    resp = make_supplier(admin_client, store, name="DISTRIBUIDORA X SAS", nit="900111222", expect=None)
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "SUPPLIER_DUPLICATE_NIT"


def test_the_cash_payment_lowers_the_expected_cash_of_the_shift_by_exactly_the_amount(
    admin_client: Any, store: Any, db: Any, open_shift: Any, expected_of: Any
) -> None:
    """La otra mitad del cruce `purchases -> shifts`: el egreso no sólo tiene
    que existir, tiene que **contar** en el esperado del turno. Si la causa
    nueva quedara fuera de `compute_breakdown`, el cajero cerraría a ciegas
    con un faltante de exactamente el pago al proveedor, y la spec prohíbe
    que el sistema calcule deuda de un empleado (CST art. 149): la
    diferencia la escribiría una persona como «gasto sin soporte»."""
    payable = _approved_payable(admin_client, store)
    turno = open_shift()
    esperado_antes = expected_of(turno["id"])

    resp = admin_client.post(
        f"{API}/admin/payables/{payable['id']}/payments",
        headers=idem_headers(),
        json={
            "amount": 50_000,
            "method": "cash",
            "paid_at": "2026-01-16T10:00:00Z",
            "from_cash_drawer": True,
            "authorizer_pin": "9999",
        },
    )
    assert resp.status_code == 201, resp.text

    esperado_despues = expected_of(turno["id"])
    assert esperado_despues == esperado_antes - 50_000, (
        "el pago al proveedor desde el cajón no bajó el esperado del turno: "
        f"{esperado_antes} -> {esperado_despues}"
    )


def test_no_purchases_route_is_reachable_under_a_device_session(
    device_client: Any, store: Any
) -> None:
    """**Invariante heredado #2 de `spec.md`, BLOQUEANTE si falla**: «el
    operador no ve costos» sigue en pie y 2b no lo toca. La recepción lleva
    precios unitarios, así que es pantalla de administrador; el PIN de quien
    recibe es atribución, no una sesión de dispositivo.

    Se prueba con la sesión REAL de un dispositivo activado, no sólo sobre el
    documento: cada ruta de compras contestada con algo que no sea 401/404 es
    costo de proveedor servido a la tablet del salón.
    """
    rutas = [
        ("get", f"{API}/admin/suppliers?store_id={store.id}"),
        ("get", f"{API}/admin/receptions?store_id={store.id}"),
        ("get", f"{API}/admin/receptions/1"),
        ("get", f"{API}/admin/payables?store_id={store.id}"),
        ("post", f"{API}/receptions?store_id={store.id}"),
        ("post", f"{API}/admin/payables/1/approve"),
        ("post", f"{API}/admin/payables/1/payments"),
        ("get", f"{API}/admin/lots?store_id={store.id}"),
        ("get", f"{API}/admin/counts?store_id={store.id}"),
        ("get", f"{API}/admin/variance?store_id={store.id}&count_id=1"),
        ("get", f"{API}/admin/food-cost?store_id={store.id}&from=2026-01-01&to=2026-12-31"),
        ("get", f"{API}/admin/control-health?store_id={store.id}"),
    ]
    alcanzables: list[str] = []
    for metodo, ruta in rutas:
        resp = getattr(device_client, metodo)(ruta, **({"json": {}} if metodo == "post" else {}))
        if resp.status_code not in (401, 403, 404):
            alcanzables.append(f"{metodo.upper()} {ruta} -> {resp.status_code} {resp.text[:120]}")
    assert not alcanzables, (
        "una sesión de dispositivo alcanza rutas de compras/costo (BLOQUEANTE, regla dura §11.10):\n"
        + "\n".join(alcanzables)
    )


def test_voiding_a_cash_drawer_payment_does_not_leave_the_till_short(
    admin_client: Any, store: Any, db: Any, open_shift: Any, expected_of: Any
) -> None:
    """**ROJO A PROPÓSITO — BLOQUEANTE: toca plata contada en el cajón.**

    `app/purchases/service.py:744-773` (`void_payment`) cambia `voided_at`,
    `voided_reason` y el autorizador, y **nunca toca
    `Payment.cash_movement_id`** (`app/purchases/models.py:288`). Entonces,
    al anular un pago que salió del cajón:

    - el saldo de la cuenta por pagar vuelve (correcto, y el checklist lo
      pide);
    - el `CashMovement(kind=EXPENSE, cause=supplier_payment)` **sigue vivo**
      en el turno, así que `compute_breakdown` sigue restando esa plata del
      esperado (`app/shifts/service.py:239-242`).

    Los dos libros quedan contando el mismo hecho al revés: la cuenta dice
    «no está pagada» y la caja dice «la plata salió». En el cierre **a
    ciegas** eso aparece como un SOBRANTE de exactamente el monto anulado, y
    alguien tiene que tipificarlo con una causa que no existe. Fabricar
    sobrantes es el bug de la referencia que `AGENTS.md` nombra por escrito
    al apartarse de la regla global de caja.

    Las dos salidas correctas, cualquiera de las dos cierra este test:

    1. anular el pago **revierte también** el egreso de caja (un movimiento
       compensatorio en el turno abierto, con causa tipada — nunca borrando
       la fila, que también está prohibido); o
    2. anular un pago que salió del cajón **se rechaza con nombre propio**
       cuando no se puede compensar, y el mensaje nombra la acción
       correctiva.

    Lo que no puede pasar es que el saldo vuelva y la caja no se entere.
    """
    payable = _approved_payable(admin_client, store)
    turno = open_shift()
    esperado_inicial = expected_of(turno["id"])

    pago = admin_client.post(
        f"{API}/admin/payables/{payable['id']}/payments",
        headers=idem_headers(),
        json={
            "amount": 50_000,
            "method": "cash",
            "paid_at": "2026-01-16T10:00:00Z",
            "from_cash_drawer": True,
            "authorizer_pin": "9999",
        },
    )
    assert pago.status_code == 201, pago.text
    assert expected_of(turno["id"]) == esperado_inicial - 50_000

    anular = admin_client.post(
        f"{API}/admin/payables/{payable['id']}/payments/{pago.json()['id']}/void",
        json={"reason": "El pago se registró por error: la plata nunca salió", "authorizer_pin": "9999"},
    )

    saldo = admin_client.get(f"{API}/admin/payables?store_id={store.id}").json()[0]
    if anular.status_code != 200:
        # Salida 2: se rechaza con nombre propio y NADA se movió.
        assert anular.status_code in (400, 409), anular.text
        assert anular.json()["error"]["code"] not in (None, ""), anular.text
        assert saldo["balance"] == saldo["amount"] - 50_000, "se rechazó la anulación pero el saldo igual se movió"
        return

    # Salida 1: se anuló, así que la caja tiene que haberse enterado.
    assert saldo["balance"] == saldo["amount"], "anular no devolvió el saldo"
    assert expected_of(turno["id"]) == esperado_inicial, (
        "anular un pago hecho desde el cajón devolvió el saldo de la cuenta por pagar pero dejó el egreso "
        f"vivo en el turno: el esperado sigue en {expected_of(turno['id'])} en vez de {esperado_inicial}. "
        "En el cierre a ciegas eso es un SOBRANTE fabricado de $50.000 que nadie puede explicar"
    )


# ---------------------------------------------------------------------------
# RONDA 2 — los invariantes que cierran H-1 para que no pueda volver.
#
# La ronda 1 dejó `test_voiding_a_cash_drawer_payment_does_not_leave_the_till_
# short` aceptando CUALQUIERA de las dos salidas correctas, porque la decisión
# no estaba tomada. Ya está: el orquestador resolvió **compensar** con un
# `CashMovement(kind=INCOME, cause=SUPPLIER_PAYMENT)` en el turno ABIERTO, y
# rechazar con `409 NO_OPEN_SHIFT` sin escribir nada cuando no hay turno.
# Estos dos tests fijan esa decisión al detalle: sin ellos, la próxima
# refactorización puede volver a "arreglarlo" reciclando `other_income` o
# borrando el egreso original, y el test de la ronda 1 seguiría verde.
# ---------------------------------------------------------------------------


def _close_shift(device_client: Any, shift_id: int, counted: int) -> None:
    """Cierre a ciegas en tres pasos (el default del perfil `full`)."""
    count = device_client.post(
        f"{API}/shifts/{shift_id}/close/count",
        json={"counted_cash": denoms(counted), "tips_cash_out": 0, "photo": "data:image/png;base64,AAAA"},
        headers=idem_headers(),
    )
    assert count.status_code in (200, 201), count.text
    count_id = count.json()["count_id"]
    review = device_client.get(f"{API}/shifts/{shift_id}/close/{count_id}/review")
    assert review.status_code == 200, review.text
    confirm = device_client.post(
        f"{API}/shifts/{shift_id}/close/{count_id}/confirm",
        json={
            "difference_seen": review.json()["difference"],
            "closes_day": True,
            "close_cause": "unknown",
            "close_note": "auditoría",
        },
    )
    assert confirm.status_code in (200, 201), confirm.text


def test_voiding_a_cash_drawer_payment_restores_the_expected_with_a_typed_reintegro(
    admin_client: Any, store: Any, db: Any, open_shift: Any, expected_of: Any
) -> None:
    """**RONDA 2 — fija la decisión que cerró H-1 (bloqueante).**

    No alcanza con «el esperado vuelve»: hay tres formas de hacer que vuelva
    y dos están prohibidas. Este test exige la que el orquestador eligió y
    rechaza las otras dos por separado:

    1. **El esperado del turno queda EXACTAMENTE como estaba antes del
       pago.** Ni un peso de diferencia: en el cierre a ciegas una diferencia
       de cualquier tamaño es una persona explicando algo que el sistema
       fabricó.
    2. **El reintegro es un movimiento NUEVO y TIPADO**: `kind=income`,
       `cause=supplier_payment`. Si alguien recicla `other_income` (la causa
       comodín) o mete un ajuste manual, el cajero ve un ingreso genérico y
       pierde la única señal de que ese ingreso compensa un pago anulado —
       que es la que le permite explicarlo. `AGENTS.md`: causa tipada en todo
       movimiento de caja, nunca inferida de un texto.
    3. **El egreso original sigue vivo, intacto.** Nada financiero se borra:
       el `CashMovement` del pago no se elimina ni se reescribe, y el
       `Payment` queda con `voided_at`, no fuera de la tabla.
    """
    from sqlalchemy import select

    from app.purchases.models import Payment
    from app.shifts.models import CashMovement, CashMovementKind

    payable = _approved_payable(admin_client, store)
    turno = open_shift()
    esperado_inicial = expected_of(turno["id"])

    pago = admin_client.post(
        f"{API}/admin/payables/{payable['id']}/payments",
        headers=idem_headers(),
        json={
            "amount": 50_000,
            "method": "cash",
            "paid_at": "2026-01-16T10:00:00Z",
            "from_cash_drawer": True,
            "authorizer_pin": "9999",
        },
    )
    assert pago.status_code == 201, pago.text
    pago_id = pago.json()["id"]
    egreso_id = pago.json()["cash_movement_id"]
    assert egreso_id is not None
    assert expected_of(turno["id"]) == esperado_inicial - 50_000

    anular = admin_client.post(
        f"{API}/admin/payables/{payable['id']}/payments/{pago_id}/void",
        json={"reason": "El pago se registró por error: la plata nunca salió", "authorizer_pin": "9999"},
    )
    assert anular.status_code == 200, anular.text

    # (1) El esperado vuelve EXACTO.
    esperado_final = expected_of(turno["id"])
    assert esperado_final == esperado_inicial, (
        f"anular el pago dejó el esperado en {esperado_final} y antes del pago era {esperado_inicial}: "
        "la diferencia aparece en el cierre a ciegas como un sobrante/faltante que nadie puede explicar"
    )

    # (2) El reintegro existe, es nuevo, y está tipado.
    db.expire_all()
    movimientos = list(
        db.execute(
            select(CashMovement).where(CashMovement.store_id == store.id, CashMovement.shift_id == turno["id"])
        ).scalars()
    )
    reintegros = [m for m in movimientos if m.kind == CashMovementKind.INCOME and m.amount == 50_000]
    assert len(reintegros) == 1, (
        "el esperado volvió pero no hay UN ingreso compensatorio de $50.000 en el turno: "
        f"{[(m.kind.value, m.cause.value if m.cause else None, m.amount) for m in movimientos]}. "
        "Si el esperado volvió sin un movimiento nuevo, alguien borró o reescribió el egreso original "
        "— y nada financiero se borra"
    )
    reintegro = reintegros[0]
    assert reintegro.cause is not None and reintegro.cause.value == "supplier_payment", (
        f"el reintegro se registró con causa `{reintegro.cause.value if reintegro.cause else None}`: tiene que "
        "ser `supplier_payment`, la causa tipada propia. Reciclar `other_income` (o un ajuste manual) deja al "
        "cajero con un ingreso genérico que no explica nada en el cierre a ciegas"
    )

    # (3) El egreso original sigue vivo e intacto.
    original = db.get(CashMovement, egreso_id)
    assert original is not None, "el egreso original se BORRÓ al anular: nada financiero se borra"
    assert original.kind == CashMovementKind.EXPENSE and original.amount == 50_000, (
        "el egreso original se reescribió al anular en vez de compensarse con un movimiento nuevo"
    )
    fila_pago = db.get(Payment, pago_id)
    assert fila_pago is not None and fila_pago.voided_at is not None, "el pago se borró en vez de anularse"


def test_voiding_a_cash_drawer_payment_without_an_open_shift_is_409_and_writes_nothing(
    admin_client: Any, device_client: Any, store: Any, db: Any, open_shift: Any
) -> None:
    """**RONDA 2 — la otra mitad de la decisión de H-1: validar ANTES de
    escribir.**

    Si no hay turno abierto, el reintegro no se puede registrar en ninguna
    parte (un turno `CLOSED` es inviolable: su conteo a ciegas ya ocurrió).
    La anulación se rechaza entera con `409 NO_OPEN_SHIFT` y **nada queda
    escrito**. Es el mismo contrato que ya defiende `create_payment`, y la
    mitad que más fácil se rompe es la segunda: `app.core.db.get_db` comitea
    también ante un `AppError`, así que un servicio que escriba `voided_at`
    ANTES de pedirle el reintegro a `shifts` deja el pago anulado con el 409
    en la mano — el saldo de la cuenta por pagar vuelve y la caja nunca se
    entera. Exactamente el bug que H-1 reportó, con otro disparador.

    Se comprueban las tres cosas que tienen que seguir como estaban:
    `voided_at` sigue `None`, el saldo del `payable` no se movió, y no hay
    ningún `CashMovement` nuevo en ningún turno.
    """
    from sqlalchemy import func, select

    from app.purchases.models import Payment
    from app.shifts.models import CashMovement

    payable = _approved_payable(admin_client, store)
    turno = open_shift()

    pago = admin_client.post(
        f"{API}/admin/payables/{payable['id']}/payments",
        headers=idem_headers(),
        json={
            "amount": 50_000,
            "method": "cash",
            "paid_at": "2026-01-16T10:00:00Z",
            "from_cash_drawer": True,
            "authorizer_pin": "9999",
        },
    )
    assert pago.status_code == 201, pago.text
    pago_id = pago.json()["id"]

    _close_shift(device_client, turno["id"], counted=OPENING_FIXED - 50_000)

    saldo_antes = admin_client.get(f"{API}/admin/payables?store_id={store.id}").json()[0]["balance"]
    movimientos_antes = db.execute(
        select(func.count()).select_from(CashMovement).where(CashMovement.store_id == store.id)
    ).scalar_one()

    anular = admin_client.post(
        f"{API}/admin/payables/{payable['id']}/payments/{pago_id}/void",
        json={"reason": "El pago se registró por error", "authorizer_pin": "9999"},
    )
    assert anular.status_code == 409, (
        f"sin turno abierto la anulación de un pago del cajón contestó {anular.status_code}: no hay dónde "
        f"registrar el reintegro, así que se rechaza entera — {anular.text}"
    )
    assert anular.json()["error"]["code"] == "NO_OPEN_SHIFT", anular.text

    db.expire_all()
    fila = db.get(Payment, pago_id)
    assert fila is not None and fila.voided_at is None, (
        "la anulación se rechazó con 409 pero el pago QUEDÓ anulado: `voided_at` se escribió antes de pedir "
        "el reintegro, y `get_db` comitea también ante un `AppError`. El saldo vuelve y la caja no se entera"
    )
    saldo_despues = admin_client.get(f"{API}/admin/payables?store_id={store.id}").json()[0]["balance"]
    assert saldo_despues == saldo_antes, (
        f"la anulación se rechazó y el saldo igual se movió: {saldo_antes} -> {saldo_despues}"
    )
    movimientos_despues = db.execute(
        select(func.count()).select_from(CashMovement).where(CashMovement.store_id == store.id)
    ).scalar_one()
    assert movimientos_despues == movimientos_antes, (
        "la anulación se rechazó pero dejó un movimiento de caja nuevo (¿en un turno cerrado?): un turno "
        "`CLOSED` es inviolable porque su conteo a ciegas ya ocurrió"
    )
