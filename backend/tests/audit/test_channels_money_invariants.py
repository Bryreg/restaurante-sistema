"""Invariantes de PLATA del pedido 2c — los tres renglones que más fácil se rompen.

Este archivo cobra, uno por uno y con la cuenta hecha:

- #2  una venta cobrada por **plataforma** no mueve el efectivo esperado del
      turno, ni en `compute_breakdown`, ni en `get_sales_totals`, ni en el
      paso 2 del cierre a ciegas (el arqueo), que es donde la plata se ve.
- #3  el cargo de domicilio es una **LÍNEA con impuesto**: entra al documento
      fiscal como línea y a la base gravable, y **no existe** en ningún lado
      un campo `delivery_fee` sumado a mano a un total.
- #4  el efectivo de domicilios se arquea **aparte** hasta que el domiciliario
      liquida; la liquidación entra al turno abierto con causa tipada; el
      deshacer compensa con el movimiento espejo, el original queda vivo, y
      sin turno abierto se rechaza entera.
- #5  cancelar una venta de plataforma después de preparar compensa la VENTA
      y **no genera merma**: el LIBRO no gana una fila de merma y el stock no
      se repone.
- #7  la comisión se registra por pedido y por plataforma y **no se resta**.
- #8  mesa, domicilio y plataforma dejan el inventario **idéntico**.
- #12 zona horaria: un pedido de plataforma a las 00:30 queda sellado con el
      día del TURNO, derivando la fecha como la deriva el SERVIDOR.
- #13 sin `float` en comisiones ni en precios por canal.
"""

from __future__ import annotations

import ast
from datetime import datetime, timezone
from typing import Any

import pytest

from tests.audit.conftest import (
    NO_TIP,
    add_items,
    app_source_files,
    cash_movements_of,
    commissions_of,
    create_order,
    deep_keys,
    get_order,
    idem_headers,
    movements_of,
    pay,
    receivables_of,
    send,
    stock_of,
    wastes_of,
)

API = "/api/v1"
PHOTO = "data:image/png;base64,AAAA"


# ---------------------------------------------------------------------------
# Armado
# ---------------------------------------------------------------------------


def _delivery_order(client: Any, courier: Any) -> dict[str, Any]:
    resp = create_order(
        client,
        channel="delivery",
        delivery={"address": "Calle Falsa 123", "phone": "3001234567", "courier_employee_id": courier.id},
    )
    assert resp.status_code in (200, 201), resp.text
    body: dict[str, Any] = resp.json()
    return body


def _platform_order(client: Any, platform: Any, external_id: str = "AUDIT-1") -> dict[str, Any]:
    resp = create_order(
        client, channel="platform", platform={"platform_id": platform.id, "external_id": external_id}
    )
    assert resp.status_code in (200, 201), resp.text
    body: dict[str, Any] = resp.json()
    return body


def _product(db: Any, store: Any, **kw: Any) -> Any:
    from app.catalog.models import Category, Product
    from app.core import clock as clock_module

    now = clock_module.now_utc()
    category = Category(
        organization_id=store.organization_id,
        store_id=store.id,
        name=kw.pop("category_name", "Auditoría 2c dinero"),
        sort_order=92,
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
        name=kw.pop("name", "Plato auditado"),
        description=None,
        station=kw.pop("station", None),
        default_course="main",
        price_dine_in=kw.pop("price_dine_in", 100_000),
        price_takeout=kw.pop("price_takeout", None),
        price_delivery=kw.pop("price_delivery", None),
        price_platform=kw.pop("price_platform", None),
        tax_code=kw.pop("tax_code", "inc_8"),
        active=True,
        available=True,
        daily_count=None,
        daily_remaining=None,
        unavailable_by_employee_id=None,
        unavailable_by_employee_name=None,
        unavailable_at=None,
        is_delivery_fee=False,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


# ===========================================================================
# #2 — UNA VENTA COBRADA POR PLATAFORMA NO MUEVE EL EFECTIVO ESPERADO
# ===========================================================================


def test_a_platform_sale_does_not_move_the_expected_cash_of_the_shift(
    device_client: Any,
    admin_client: Any,
    identify: Any,
    employees: dict[str, Any],
    enable_2c: Any,
    open_shift: Any,
    expected_of: Any,
    db: Any,
    store: Any,
    platform: Any,
) -> None:
    """Checklist #2, el test literal: abrir turno, leer el esperado, vender y
    cobrar por plataforma, leer el esperado, comparar.

    Es una CUENTA POR COBRAR contra la plataforma, no plata en el cajón.
    """
    shift = open_shift()
    identify(device_client, employees["cashier"])
    enable_2c()
    product = _product(db, store, price_platform=100_000)

    antes = expected_of(shift["id"])

    order = _platform_order(device_client, platform)
    add_items(device_client, order, [{"product_id": product.id, "qty": 1}])
    order = get_order(device_client, order["id"])
    resp = pay(
        device_client,
        order["id"],
        splits=[{"method": "platform", "amount": order["totals"]["total"]}],
        tip=NO_TIP,
        expected_version=order["version"],
    )
    assert resp.status_code in (200, 201), resp.text
    assert order["totals"]["total"] == 100_000, order["totals"]

    despues = expected_of(shift["id"])
    assert despues == antes, (
        f"vender $100.000 por plataforma movió el esperado de {antes} a {despues}: "
        "una venta por plataforma es una cuenta por cobrar, no plata en el cajón"
    )


def test_the_platform_payment_never_lands_in_the_cash_bucket_of_get_sales_totals(
    device_client: Any,
    identify: Any,
    employees: dict[str, Any],
    enable_2c: Any,
    open_shift: Any,
    db: Any,
    store: Any,
    platform: Any,
) -> None:
    """Checklist #2, el camino entero: no alcanza con `compute_breakdown`.
    `app/shifts/hooks.py::get_sales_totals` es quien reparte por medio, y
    `_OTHER_METHODS` (línea 59) es la lista que decide qué NO entra al
    cajón. Si alguien sacara `platform` de ahí, `compute_breakdown` empezaría
    a sumarlo sin cambiar una línea."""
    from app.shifts import hooks as shifts_hooks
    from app.shifts.models import Shift

    shift_body = open_shift()
    identify(device_client, employees["cashier"])
    enable_2c()
    product = _product(db, store, price_platform=100_000)

    order = _platform_order(device_client, platform)
    add_items(device_client, order, [{"product_id": product.id, "qty": 1}])
    order = get_order(device_client, order["id"])
    total = order["totals"]["total"]
    resp = pay(
        device_client,
        order["id"],
        splits=[{"method": "platform", "amount": total}],
        tip=NO_TIP,
        expected_version=order["version"],
    )
    assert resp.status_code in (200, 201), resp.text

    shift = db.get(Shift, shift_body["id"])
    totals = shifts_hooks.get_sales_totals(db, shift.id)
    assert totals.cash == 0, f"la venta por plataforma entró a `.cash`: {totals}"
    assert totals.other == total, f"la venta por plataforma tenía que ir a `.other`: {totals}"
    assert "platform" in shifts_hooks._OTHER_METHODS, (
        "`platform` salió de `_OTHER_METHODS` (app/shifts/hooks.py:59): "
        "desde ese momento el cobro por plataforma entra al efectivo esperado"
    )


def test_a_platform_sale_does_not_move_the_arqueo_of_the_blind_close(
    device_client: Any,
    admin_client: Any,
    identify: Any,
    employees: dict[str, Any],
    enable_2c: Any,
    open_shift: Any,
    db: Any,
    store: Any,
    platform: Any,
) -> None:
    """Checklist #2, donde la plata se ve de verdad: el paso 2 del cierre a
    ciegas. Con la base fija contada exacta, la diferencia del arqueo tiene
    que ser **cero** después de vender $100.000 por plataforma. Si el cobro
    hubiera entrado al esperado, quien cuenta vería un faltante de $100.000
    y le pedirían una causa por plata que nunca existió en el cajón."""
    from tests.audit.conftest import OPENING_FIXED, denoms

    shift = open_shift()
    identify(device_client, employees["cashier"])
    enable_2c()
    product = _product(db, store, price_platform=100_000)

    order = _platform_order(device_client, platform)
    add_items(device_client, order, [{"product_id": product.id, "qty": 1}])
    order = get_order(device_client, order["id"])
    pay(
        device_client,
        order["id"],
        splits=[{"method": "platform", "amount": order["totals"]["total"]}],
        tip=NO_TIP,
        expected_version=order["version"],
    )

    conteo = device_client.post(
        f"{API}/shifts/{shift['id']}/close/count",
        json={"counted_cash": denoms(OPENING_FIXED), "tips_cash_out": 0, "photo": PHOTO},
        headers=idem_headers(),
    )
    assert conteo.status_code in (200, 201), conteo.text
    count_id = conteo.json()["count_id"]

    review = device_client.get(f"{API}/shifts/{shift['id']}/close/{count_id}/review")
    assert review.status_code == 200, review.text
    cuerpo = review.json()
    assert cuerpo["expected"] == OPENING_FIXED, cuerpo
    assert cuerpo["difference"] == 0, (
        f"el arqueo acusó una diferencia de {cuerpo['difference']} después de una venta por "
        "plataforma: el cobro se coló al efectivo esperado"
    )
    assert cuerpo["requires_cause"] is False, cuerpo


def test_the_expected_cash_formula_never_gained_a_second_term(db: Any) -> None:
    """Checklist #2, el invariante estructural: `compute_breakdown` calcula
    `expected` con **una sola** suma y `delivery_cash_pending` queda FUERA.
    Se lee el AST: un `expected = ... + sales.delivery_cash_pending` en
    cualquier forma lo caza, y un comentario que nombre la fórmula, no."""
    fuente = [(ruta, arbol) for ruta, arbol in app_source_files() if ruta == "app/shifts/service.py"]
    assert fuente, "no se encontró app/shifts/service.py"
    _, arbol = fuente[0]

    funcion = next(
        n for n in ast.walk(arbol) if isinstance(n, ast.FunctionDef) and n.name == "compute_breakdown"
    )
    asignaciones = [
        n for n in ast.walk(funcion)
        if isinstance(n, ast.Assign)
        and any(isinstance(t, ast.Name) and t.id == "expected" for t in n.targets)
    ]
    assert len(asignaciones) == 1, f"`expected` se asigna {len(asignaciones)} veces: hay dos matemáticas"
    texto = ast.dump(asignaciones[0])
    for prohibido in ("delivery_cash_pending", "delivery_cash", "tips_delivery", "other"):
        assert prohibido not in texto, (
            f"`expected` pasó a incluir {prohibido!r}: es plata que no está en el cajón"
        )


# ===========================================================================
# #3 — EL CARGO DE DOMICILIO ES UNA LÍNEA CON IMPUESTO
# ===========================================================================


def test_the_delivery_fee_is_a_line_with_tax_and_enters_the_taxable_base(
    device_client: Any,
    identify: Any,
    employees: dict[str, Any],
    enable_2c: Any,
    open_shift: Any,
    db: Any,
    store: Any,
    courier: Any,
    delivery_fee_product: Any,
) -> None:
    """Checklist #3, con la cuenta hecha.

    Bajo INC 8 % con precio que incluye impuesto (el default de la sede),
    un plato de $100.000 más un cargo de $5.000 dan un total de $105.000 y
    una base gravable de `105.000 / 1,08`. El cargo NO es un extra sin
    impuesto: causa INC igual que cualquier consumo (art. 512-1 y 512-9 ET).

    Lo importante es la comparación: la `tax_base` del documento **crece**
    exactamente lo que aporta el cargo, y la línea del cargo aparece en el
    documento fiscal con su propia tasa.
    """
    open_shift()
    identify(device_client, employees["cashier"])
    enable_2c()
    product = _product(db, store, price_dine_in=100_000, price_delivery=100_000)

    order = _delivery_order(device_client, courier)
    # El cargo ya viene como línea: el cliente NUNCA lo manda.
    lineas_iniciales = order["items"]
    assert len(lineas_iniciales) == 1, f"el cargo tenía que nacer como línea: {lineas_iniciales}"
    cargo = lineas_iniciales[0]
    assert cargo["product_id"] == delivery_fee_product.id
    assert cargo["unit_price"] == 5_000
    assert cargo["tax_rate"] == 8, f"el cargo salió con tasa {cargo['tax_rate']}: bajo INC es 8"

    add_items(device_client, order, [{"product_id": product.id, "qty": 1}])
    order = get_order(device_client, order["id"])
    totales = order["totals"]
    assert totales["total"] == 105_000, totales

    resp = pay(
        device_client,
        order["id"],
        splits=[{"method": "cash", "amount": 105_000, "tendered": 105_000}],
        tip=NO_TIP,
        expected_version=order["version"],
        delivery={"courier_employee_id": courier.id},
    )
    assert resp.status_code in (200, 201), resp.text

    from sqlalchemy import select

    from app.fiscal.models import FiscalDocument

    documento = db.execute(
        select(FiscalDocument).where(FiscalDocument.order_id == order["id"]).order_by(FiscalDocument.id)
    ).scalars().first()
    assert documento is not None, "la venta no dejó documento fiscal"

    nombres = [str(linea.get("description", "")) for linea in documento.lines]
    assert delivery_fee_product.name in nombres, (
        f"el cargo de domicilio no aparece como LÍNEA del documento fiscal: {nombres}"
    )
    linea_cargo = [l for l in documento.lines if l.get("description") == delivery_fee_product.name][0]
    assert int(linea_cargo["tax_rate"]) == 8, linea_cargo

    # La base gravable: 105.000 con impuesto incluido al 8 %.
    #   base = round(105.000 / 1,08) = 97.222   →  impuesto = 7.778
    # Y sin el cargo habrían sido 100.000 → base 92.593. El cargo aporta
    # base gravable de verdad: 97.222 − 92.593 = 4.629, y no cero.
    por_tasa = {int(l["rate"]): l for l in documento.tax_lines}
    assert 8 in por_tasa, documento.tax_lines
    base_total = por_tasa[8]["base"]
    impuesto_total = por_tasa[8]["tax"]
    print(f"[cargo de domicilio] total={documento.total} base={base_total} impuesto={impuesto_total}")
    assert base_total + impuesto_total == documento.total == 105_000, documento.tax_lines

    # La cuenta, hecha: la línea del CARGO aporta base gravable de verdad.
    #   cargo 5.000 con impuesto incluido al 8 %  →  base 4.630, impuesto 370
    # (si el cargo no causara impuesto, `base` sería 5.000 y `tax` 0, y esta
    # aserción sería roja).
    assert int(linea_cargo["base"]) == 4_630, linea_cargo
    assert int(linea_cargo["tax"]) == 370, linea_cargo
    assert int(linea_cargo["net"]) == 5_000, linea_cargo
    # Y el mismo cargo sin impuesto habría dejado la base total en 4.630 menos.
    linea_plato = [l for l in documento.lines if l.get("description") == product.name][0]
    assert base_total == int(linea_cargo["base"]) + int(linea_plato["base"]), documento.tax_lines


def test_no_delivery_fee_field_is_ever_added_by_hand_to_a_total(db: Any) -> None:
    """Checklist #3, el invariante ESTRUCTURAL que lo protege: si existiera un
    campo `delivery_fee` (columna, atributo de esquema o clave de dict) habría
    que sumarlo a mano en cada total — dos matemáticas, que es exactamente lo
    que la spec prohíbe.

    Se barre el AST de `app/**`: ninguna asignación, anotación ni clave de
    diccionario puede llamarse `delivery_fee`/`delivery_fee_amount`/
    `delivery_charge`. `is_delivery_fee` (la BANDERA del producto de la
    carta) sí es legítima y está declarada como excepción por nombre exacto.
    """
    PROHIBIDOS = {"delivery_fee", "delivery_fee_amount", "delivery_fee_total", "delivery_charge"}
    hallazgos: list[str] = []
    for ruta, arbol in app_source_files():
        for nodo in ast.walk(arbol):
            if isinstance(nodo, ast.AnnAssign) and isinstance(nodo.target, ast.Name):
                if nodo.target.id in PROHIBIDOS:
                    hallazgos.append(f"{ruta}:{nodo.lineno} ({nodo.target.id})")
            elif isinstance(nodo, ast.Assign):
                for t in nodo.targets:
                    if isinstance(t, ast.Name) and t.id in PROHIBIDOS:
                        hallazgos.append(f"{ruta}:{nodo.lineno} ({t.id})")
            elif isinstance(nodo, ast.Dict):
                for clave in nodo.keys:
                    if isinstance(clave, ast.Constant) and clave.value in PROHIBIDOS:
                        hallazgos.append(f"{ruta}:{nodo.lineno} (clave {clave.value!r})")
            elif isinstance(nodo, ast.Attribute) and nodo.attr in PROHIBIDOS:
                hallazgos.append(f"{ruta}:{nodo.lineno} (.{nodo.attr})")
    assert not hallazgos, (
        "apareció un campo de cargo de domicilio sumado aparte; el cargo es una LÍNEA: " + str(hallazgos)
    )


def test_the_delivery_fee_line_never_carries_a_hand_written_tax_rate(db: Any) -> None:
    """Checklist #3 + invariante heredado (b): la tasa del cargo sale de
    `app.core.tax.rate_for_code`, nunca de un número escrito a mano.
    `_build_delivery_fee_item` no puede contener ningún literal `8`/`0.08`/
    `1.08` en su cuerpo."""
    fuente = [(r, a) for r, a in app_source_files() if r == "app/orders/service.py"]
    _, arbol = fuente[0]
    funcion = next(
        n for n in ast.walk(arbol) if isinstance(n, ast.FunctionDef) and n.name == "_build_delivery_fee_item"
    )
    llamadas = {
        n.func.id for n in ast.walk(funcion) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
    }
    assert "rate_for_code" in llamadas, (
        "`_build_delivery_fee_item` dejó de resolver la tasa con `app.core.tax.rate_for_code`"
    )
    literales = [
        n.value
        for n in ast.walk(funcion)
        if isinstance(n, ast.Constant) and isinstance(n.value, (int, float)) and n.value not in (0, 1)
    ]
    assert not literales, f"el cargo de domicilio lleva una tasa/monto escrito a mano: {literales}"


# ===========================================================================
# #4 — EL EFECTIVO DE DOMICILIOS SE ARQUEA APARTE
# ===========================================================================


def _sell_delivery_in_cash(
    device_client: Any, db: Any, store: Any, courier: Any, product: Any, *, amount: int
) -> dict[str, Any]:
    order = _delivery_order(device_client, courier)
    add_items(device_client, order, [{"product_id": product.id, "qty": 1}])
    order = get_order(device_client, order["id"])
    total = order["totals"]["total"]
    assert total == amount, f"el total salió {total} y el test esperaba {amount}"
    resp = pay(
        device_client,
        order["id"],
        splits=[{"method": "cash", "amount": total, "tendered": total}],
        tip=NO_TIP,
        expected_version=order["version"],
        delivery={"courier_employee_id": courier.id},
    )
    assert resp.status_code in (200, 201), resp.text
    return order


def test_delivery_cash_stays_out_of_the_expected_until_the_courier_settles(
    device_client: Any,
    identify: Any,
    employees: dict[str, Any],
    enable_2c: Any,
    open_shift: Any,
    expected_of: Any,
    db: Any,
    store: Any,
    courier: Any,
    delivery_fee_product: Any,
) -> None:
    """Checklist #4: el efectivo del domiciliario **no está en el cajón**.
    El esperado no se mueve al cobrar; el desglose lo publica en su renglón
    propio, FUERA de `expected`; y al liquidar entra completo por `incomes`."""
    from app.shifts.models import Shift
    from app.shifts.service import compute_breakdown

    shift_body = open_shift()
    identify(device_client, employees["cashier"])
    enable_2c()
    product = _product(db, store, price_dine_in=95_000, price_delivery=95_000)

    antes = expected_of(shift_body["id"])
    _sell_delivery_in_cash(device_client, db, store, courier, product, amount=100_000)
    despues = expected_of(shift_body["id"])
    assert despues == antes, (
        f"el efectivo de un domicilio movió el esperado de {antes} a {despues} antes de liquidar"
    )

    shift = db.get(Shift, shift_body["id"])
    desglose = compute_breakdown(db, shift)
    assert desglose["delivery_cash_pending"] == 100_000, desglose
    assert desglose["cash_sales"] == 0, f"el efectivo del domiciliario entró a cash_sales: {desglose}"
    assert desglose["expected"] == antes, desglose

    # Y el renglón viaja hasta el paso 2 del cierre a ciegas: es EL momento
    # en que importa (quien acaba de contar está por justificar).
    from tests.audit.conftest import OPENING_FIXED, denoms

    conteo = device_client.post(
        f"{API}/shifts/{shift_body['id']}/close/count",
        json={"counted_cash": denoms(OPENING_FIXED), "tips_cash_out": 0, "photo": PHOTO},
        headers=idem_headers(),
    )
    assert conteo.status_code in (200, 201), conteo.text
    review = device_client.get(
        f"{API}/shifts/{shift_body['id']}/close/{conteo.json()['count_id']}/review"
    )
    assert review.status_code == 200, review.text
    ecuacion = review.json()["equation"]
    assert ecuacion["delivery_cash_pending"] == 100_000, ecuacion
    # La ecuación del esperado tiene que seguir cerrando SIN ese término.
    assert (
        ecuacion["base"]
        + ecuacion["cash_sales"]
        + ecuacion["incomes"]
        - ecuacion["expenses"]
        - ecuacion["pickups"]
        == ecuacion["expected"]
    ), ecuacion
    assert review.json()["difference"] == 0, review.text


def test_settling_delivery_cash_writes_a_typed_income_in_the_open_shift(
    device_client: Any,
    identify: Any,
    employees: dict[str, Any],
    enable_2c: Any,
    open_shift: Any,
    expected_of: Any,
    db: Any,
    store: Any,
    courier: Any,
    delivery_fee_product: Any,
) -> None:
    """Checklist #4: la liquidación entra al turno abierto con **causa
    tipada** (`delivery_settlement`, enum — nunca texto libre ni una causa
    reciclada) y recién ahí sube el esperado."""
    from app.shifts.models import CashMovementCause, CashMovementKind

    shift_body = open_shift()
    identify(device_client, employees["cashier"])
    enable_2c()
    product = _product(db, store, price_dine_in=95_000, price_delivery=95_000)
    antes = expected_of(shift_body["id"])
    _sell_delivery_in_cash(device_client, db, store, courier, product, amount=100_000)

    resp = device_client.post(
        f"{API}/delivery-settlements",
        json={"courier_employee_id": courier.id},
        headers=idem_headers(),
    )
    assert resp.status_code in (200, 201), resp.text
    liquidacion = resp.json()
    assert liquidacion["total"] == 100_000, liquidacion
    assert liquidacion["status"] == "settled", liquidacion

    movimientos = cash_movements_of(db, shift_body["id"])
    ingresos = [m for m in movimientos if m.kind == CashMovementKind.INCOME]
    assert len(ingresos) == 1, f"la liquidación tenía que escribir UN ingreso: {movimientos}"
    assert ingresos[0].cause == CashMovementCause.DELIVERY_SETTLEMENT, ingresos[0].cause
    assert ingresos[0].amount == 100_000

    assert expected_of(shift_body["id"]) == antes + 100_000


def test_voiding_a_settlement_writes_the_mirror_and_leaves_the_original_alive(
    device_client: Any,
    identify: Any,
    employees: dict[str, Any],
    enable_2c: Any,
    open_shift: Any,
    expected_of: Any,
    db: Any,
    store: Any,
    courier: Any,
    delivery_fee_product: Any,
) -> None:
    """Checklist #4, el deshacer — donde 2b fabricaba un sobrante (H-1).

    Anular una liquidación escribe el movimiento ESPEJO (`kind` opuesto,
    MISMA causa tipada), el `CashMovement` original **queda vivo**, y el
    esperado vuelve al valor de antes de liquidar. Nada financiero se borra.
    """
    from app.shifts.models import CashMovementCause, CashMovementKind

    shift_body = open_shift()
    identify(device_client, employees["cashier"])
    enable_2c()
    product = _product(db, store, price_dine_in=95_000, price_delivery=95_000)
    antes_de_liquidar = expected_of(shift_body["id"])
    _sell_delivery_in_cash(device_client, db, store, courier, product, amount=100_000)

    creada = device_client.post(
        f"{API}/delivery-settlements", json={"courier_employee_id": courier.id}, headers=idem_headers()
    )
    assert creada.status_code in (200, 201), creada.text
    settlement_id = creada.json()["id"]
    movimiento_original = creada.json()["cash_movement_id"]
    assert expected_of(shift_body["id"]) == antes_de_liquidar + 100_000

    anulada = device_client.post(
        f"{API}/delivery-settlements/{settlement_id}/void",
        json={"reason": "el domiciliario no entregó la plata"},
        headers=idem_headers(),
    )
    assert anulada.status_code == 200, anulada.text
    cuerpo = anulada.json()
    assert cuerpo["status"] == "voided", cuerpo
    assert cuerpo["voided_at"] is not None, cuerpo
    assert cuerpo["void_cash_movement_id"] is not None, cuerpo

    movimientos = cash_movements_of(db, shift_body["id"])
    por_id = {m.id: m for m in movimientos}
    assert movimiento_original in por_id, "el movimiento original de la liquidación se borró"
    original = por_id[movimiento_original]
    assert original.kind == CashMovementKind.INCOME
    assert original.cause == CashMovementCause.DELIVERY_SETTLEMENT

    espejo = por_id[cuerpo["void_cash_movement_id"]]
    assert espejo.kind == CashMovementKind.EXPENSE, "el espejo no es del signo opuesto"
    assert espejo.cause == CashMovementCause.DELIVERY_SETTLEMENT, (
        f"el espejo usó la causa {espejo.cause}: tiene que ser la MISMA causa tipada"
    )
    assert espejo.amount == original.amount

    assert expected_of(shift_body["id"]) == antes_de_liquidar, (
        "deshacer la liquidación dejó plata de más en el esperado: es el sobrante fabricado de H-1"
    )


def test_voiding_a_settlement_without_an_open_shift_rejects_the_whole_thing(
    device_client: Any,
    admin_client: Any,
    identify: Any,
    employees: dict[str, Any],
    enable_2c: Any,
    open_shift: Any,
    db: Any,
    store: Any,
    courier: Any,
    delivery_fee_product: Any,
) -> None:
    """Checklist #4, el borde: sin turno abierto la anulación se rechaza
    ENTERA — no queda ni el espejo, ni el `voided_at`, ni el pago liberado.
    Es el cierre de H-1 de 2b en el sentido opuesto."""
    from app.channels.models import DeliverySettlement, DeliverySettlementStatus
    from app.shifts.models import Shift, ShiftStatus

    shift_body = open_shift()
    identify(device_client, employees["cashier"])
    enable_2c()
    product = _product(db, store, price_dine_in=95_000, price_delivery=95_000)
    _sell_delivery_in_cash(device_client, db, store, courier, product, amount=100_000)

    creada = device_client.post(
        f"{API}/delivery-settlements", json={"courier_employee_id": courier.id}, headers=idem_headers()
    )
    assert creada.status_code in (200, 201), creada.text
    settlement_id = creada.json()["id"]

    # Cerrar el turno a mano (el camino de cierre real exige conteo y causa;
    # acá lo que se prueba es el borde "no hay turno abierto").
    shift = db.get(Shift, shift_body["id"])
    shift.status = ShiftStatus.CLOSED
    db.commit()

    anulada = device_client.post(
        f"{API}/delivery-settlements/{settlement_id}/void",
        json={"reason": "sin turno"},
        headers=idem_headers(),
    )
    assert anulada.status_code == 409, anulada.text
    assert anulada.json()["error"]["code"] == "NO_OPEN_SHIFT", anulada.text

    db.expire_all()
    fila = db.get(DeliverySettlement, settlement_id)
    assert fila.status == DeliverySettlementStatus.SETTLED, "la anulación dejó la fila a medias"
    assert fila.voided_at is None, "quedó `voided_at` sin movimiento espejo"
    assert fila.void_cash_movement_id is None


def test_the_pending_delivery_cash_is_never_called_a_debt_of_the_employee(
    device_client: Any,
    identify: Any,
    employees: dict[str, Any],
    enable_2c: Any,
    open_shift: Any,
    db: Any,
    store: Any,
    courier: Any,
    delivery_fee_product: Any,
) -> None:
    """Regla dura del proyecto (CST art. 149): el sistema **nunca** calcula
    una deuda de un empleado. El pendiente por domiciliario es efectivo de la
    sede que falta entregar, y el contrato no puede nombrarlo de otra forma."""
    from tests.audit.conftest import deep_contains_text

    open_shift()
    identify(device_client, employees["cashier"])
    enable_2c()
    product = _product(db, store, price_dine_in=95_000, price_delivery=95_000)
    _sell_delivery_in_cash(device_client, db, store, courier, product, amount=100_000)

    resp = device_client.get(f"{API}/delivery-settlements/pending")
    assert resp.status_code == 200, resp.text
    cuerpo = resp.json()
    assert cuerpo["total"] == 100_000, cuerpo
    for palabra in ("debt", "deuda", "owes", "debe", "descuento"):
        assert not deep_contains_text(cuerpo, palabra), (
            f"el pendiente de domicilios se nombró {palabra!r}: no es una deuda del empleado"
        )


# ===========================================================================
# #5 — CANCELAR DESPUÉS DE PREPARAR COMPENSA LA VENTA, NO GENERA MERMA
# ===========================================================================


@pytest.fixture()
def platform_order_with_recipe(
    device_client: Any,
    admin_client: Any,
    identify: Any,
    employees: dict[str, Any],
    enable_2c: Any,
    open_shift: Any,
    db: Any,
    store: Any,
    platform: Any,
) -> dict[str, Any]:
    """Una venta de plataforma ENVIADA a cocina (con consumo teórico real) y
    cobrada. Es el estado desde el que se cancela «después de preparar»."""
    from tests.audit.conftest import make_ingredient, put_recipe

    open_shift()
    identify(device_client, employees["cashier"])
    enable_2c()

    ingrediente = make_ingredient(admin_client, store, name="Arroz auditado")
    product = _product(db, store, price_platform=100_000, station="hot_kitchen")
    put_recipe(
        admin_client,
        product.id,
        lines=[{"ingredient_id": ingrediente["id"], "qty": "1.000", "unit": ingrediente["base_unit"]}],
    )

    stock_inicial = stock_of(db, store, ingredient_id=ingrediente["id"])

    order = _platform_order(device_client, platform)
    add_items(device_client, order, [{"product_id": product.id, "qty": 1}])
    order = get_order(device_client, order["id"])
    assert send(device_client, order).status_code == 200, "no se pudo enviar a cocina"
    order = get_order(device_client, order["id"])
    stock_tras_enviar = stock_of(db, store, ingredient_id=ingrediente["id"])
    assert stock_tras_enviar < stock_inicial, "enviar no descontó el insumo: el test no prueba nada"

    resp = pay(
        device_client,
        order["id"],
        splits=[{"method": "platform", "amount": order["totals"]["total"]}],
        tip=NO_TIP,
        expected_version=order["version"],
    )
    assert resp.status_code in (200, 201), resp.text

    return {
        "order_id": order["id"],
        "ingredient_id": ingrediente["id"],
        "stock_tras_enviar": stock_tras_enviar,
        "product_id": product.id,
    }


def test_cancelling_a_platform_sale_after_preparing_creates_no_waste_in_the_ledger(
    admin_client: Any, db: Any, store: Any, platform_order_with_recipe: dict[str, Any]
) -> None:
    """Checklist #5, verificado en el LIBRO (no en el reporte): cancelar
    después de preparar **no escribe una fila de merma** y **no repone** el
    insumo. El plato se cocinó: el insumo ya se descontó y se queda
    descontado. Meterlo en mermas falsearía el KPI de mermas ÷ compras."""
    from app.inventory.models import MovementCause

    caso = platform_order_with_recipe
    movimientos_antes = movements_of(db, store, ingredient_id=caso["ingredient_id"])

    resp = admin_client.post(
        f"{API}/admin/platform-cancellations",
        params={"store_id": store.id},
        json={"order_id": caso["order_id"], "reason": "la plataforma canceló el pedido"},
        headers=idem_headers(),
    )
    assert resp.status_code in (200, 201), resp.text
    cuerpo = resp.json()
    assert cuerpo["restocked"] is False, cuerpo
    assert cuerpo["waste_created"] is False, cuerpo

    db.expire_all()
    movimientos_despues = movements_of(db, store, ingredient_id=caso["ingredient_id"])
    nuevos = movimientos_despues[len(movimientos_antes):]
    assert not nuevos, (
        "cancelar una venta de plataforma escribió movimientos de inventario nuevos: "
        + str([(m.cause, m.qty_base) for m in nuevos])
    )
    causas = {m.cause for m in movimientos_despues}
    assert MovementCause.WASTE not in causas, f"el LIBRO ganó una merma: {causas}"

    assert stock_of(db, store, ingredient_id=caso["ingredient_id"]) == caso["stock_tras_enviar"], (
        "el inventario se repuso al cancelar: el insumo ya se consumió y tiene que quedarse descontado"
    )
    assert not wastes_of(db, store), "se creó una fila en `wastes`"


def test_cancelling_a_platform_sale_compensates_the_sale_and_the_commission(
    admin_client: Any, db: Any, store: Any, platform: Any, platform_order_with_recipe: dict[str, Any]
) -> None:
    """Checklist #5, la otra mitad: lo que se compensa es la VENTA. La cuenta
    por cobrar pasa a `reversed` y la comisión recibe su asiento inverso con
    el porcentaje CONGELADO — ninguna de las dos se borra."""
    from app.channels.models import LedgerEntryKind, PlatformReceivableStatus

    caso = platform_order_with_recipe
    resp = admin_client.post(
        f"{API}/admin/platform-cancellations",
        params={"store_id": store.id},
        json={"order_id": caso["order_id"], "reason": "la plataforma canceló el pedido"},
        headers=idem_headers(),
    )
    assert resp.status_code in (200, 201), resp.text

    db.expire_all()
    cuentas = receivables_of(db, store)
    assert len(cuentas) == 1, "la cuenta por cobrar se borró en vez de reversarse"
    assert cuentas[0].status == PlatformReceivableStatus.REVERSED, cuentas[0].status
    assert cuentas[0].amount == 100_000, "el monto de la venta se reescribió al compensar"

    asientos = commissions_of(db, store)
    assert len(asientos) == 2, f"la comisión tenía que ganar un asiento inverso: {asientos}"
    cargo, reverso = asientos
    assert cargo.kind == LedgerEntryKind.CHARGE
    assert reverso.kind == LedgerEntryKind.REVERSAL
    assert reverso.commission_bp == cargo.commission_bp, "se compensó con otro porcentaje"
    assert reverso.amount == cargo.amount


def test_the_waste_report_does_not_include_a_cancelled_platform_sale(
    admin_client: Any, db: Any, store: Any, platform_order_with_recipe: dict[str, Any]
) -> None:
    """Checklist #5: el reporte de mermas no la incluye. Es la lectura que el
    dueño mira; el libro ya se verificó aparte."""
    caso = platform_order_with_recipe
    resp = admin_client.post(
        f"{API}/admin/platform-cancellations",
        params={"store_id": store.id},
        json={"order_id": caso["order_id"], "reason": "cancelada"},
        headers=idem_headers(),
    )
    assert resp.status_code in (200, 201), resp.text

    reporte = admin_client.get(f"{API}/admin/waste", params={"store_id": store.id})
    assert reporte.status_code == 200, reporte.text
    items = reporte.json()["items"]
    assert items == [] or all(f.get("order_id") != caso["order_id"] for f in items), (
        f"la cancelación de plataforma apareció en el reporte de mermas: {items}"
    )


# ===========================================================================
# #7 — LA COMISIÓN SE REGISTRA Y NO SE RESTA
# ===========================================================================


def test_the_commission_is_recorded_per_order_and_platform_and_never_subtracted(
    device_client: Any,
    admin_client: Any,
    identify: Any,
    employees: dict[str, Any],
    enable_2c: Any,
    open_shift: Any,
    db: Any,
    store: Any,
    platform: Any,
) -> None:
    """Checklist #7, con la cuenta hecha: venta de $100.000 al 18 %.
    La venta es $100.000 en TODAS partes (pago, cuenta por cobrar, documento)
    y la comisión $18.000 en su propia tabla. En ningún lado aparece $82.000.
    """
    from sqlalchemy import select

    from app.fiscal.models import FiscalDocument
    from app.payments.models import Payment

    open_shift()
    identify(device_client, employees["cashier"])
    enable_2c()
    product = _product(db, store, price_platform=100_000)

    order = _platform_order(device_client, platform, external_id="RAPPI-777")
    add_items(device_client, order, [{"product_id": product.id, "qty": 1}])
    order = get_order(device_client, order["id"])
    resp = pay(
        device_client,
        order["id"],
        splits=[{"method": "platform", "amount": 100_000}],
        tip=NO_TIP,
        expected_version=order["version"],
    )
    assert resp.status_code in (200, 201), resp.text
    cuerpo = resp.json()
    assert cuerpo["total"] == 100_000, cuerpo
    assert cuerpo["amount_due"] == 100_000, cuerpo

    pagos = list(db.execute(select(Payment).where(Payment.order_id == order["id"])).scalars())
    assert [p.amount for p in pagos] == [100_000], [p.amount for p in pagos]

    documento = db.execute(
        select(FiscalDocument).where(FiscalDocument.order_id == order["id"])
    ).scalars().first()
    assert documento is not None and documento.total == 100_000, documento

    cuentas = receivables_of(db, store)
    assert len(cuentas) == 1 and cuentas[0].amount == 100_000, cuentas
    assert cuentas[0].platform_id == platform.id
    assert cuentas[0].order_id == order["id"]
    assert cuentas[0].external_id == "RAPPI-777", "el `external_id` no viajó a la cuenta por cobrar"

    asientos = commissions_of(db, store)
    assert len(asientos) == 1, asientos
    assert asientos[0].amount == 18_000, asientos[0].amount
    assert asientos[0].commission_bp == 1_800, "el porcentaje no quedó congelado en el asiento"
    assert asientos[0].order_id == order["id"] and asientos[0].platform_id == platform.id

    # El 82.000 que NO tiene que existir en ninguna parte.
    assert 82_000 not in {p.amount for p in pagos}
    assert 82_000 != documento.total
    assert 82_000 != cuentas[0].amount


def test_only_one_place_in_the_backend_multiplies_by_commission_bp() -> None:
    """Checklist #7 + la lección de escalas (B-2 de 2a, H-7 de 2b): una
    escala escrita dos veces es un rojo esperando. Se lee el AST de todo
    `app/**`: `commission_bp` sólo puede aparecer dentro de una operación
    aritmética en `app/channels/service.py::compute_commission`."""
    hallazgos: list[str] = []
    for ruta, arbol in app_source_files():
        for nodo in ast.walk(arbol):
            if not isinstance(nodo, ast.BinOp):
                continue
            texto = ast.dump(nodo)
            if "commission_bp" not in texto:
                continue
            if ruta == "app/channels/service.py":
                continue
            hallazgos.append(f"{ruta}:{nodo.lineno}")
    assert not hallazgos, (
        "hay una segunda matemática de la comisión fuera de `compute_commission`: " + str(hallazgos)
    )


def test_the_device_never_sees_the_commission(
    device_client: Any,
    identify: Any,
    employees: dict[str, Any],
    enable_2c: Any,
    open_shift: Any,
    db: Any,
    store: Any,
    platform: Any,
) -> None:
    """Checklist #7 + «el operador no ve costos»: la comisión es plata contra
    la venta. Ni el selector de plataformas del dispositivo ni la comanda la
    traen, ni anidada."""
    open_shift()
    identify(device_client, employees["cashier"])
    enable_2c()
    product = _product(db, store, price_platform=100_000)

    listado = device_client.get(f"{API}/device/platforms")
    assert listado.status_code == 200, listado.text
    assert "commission_bp" not in deep_keys(listado.json()), listado.text

    order = _platform_order(device_client, platform)
    add_items(device_client, order, [{"product_id": product.id, "qty": 1}])
    cuerpo = get_order(device_client, order["id"])
    claves = deep_keys(cuerpo)
    for prohibida in ("commission_bp", "commission", "platform_commission_bp"):
        assert prohibida not in claves, f"la comanda del dispositivo trae {prohibida!r}: {sorted(claves)}"


# ===========================================================================
# #8 — LOS TRES CANALES DEJAN EL INVENTARIO IDÉNTICO
# ===========================================================================


def test_selling_by_table_delivery_and_platform_leaves_the_inventory_identical(
    device_client: Any,
    admin_client: Any,
    identify: Any,
    employees: dict[str, Any],
    enable_2c: Any,
    set_feature: Any,
    open_shift: Any,
    db: Any,
    store: Any,
    courier: Any,
    platform: Any,
    delivery_fee_product: Any,
    audit_tables: list[Any],
) -> None:
    """Checklist #8, hermano del test de 2a que compara venta, cortesía y
    `staff_meal`: mismo producto, misma cantidad, tres canales, **el mismo
    movimiento de insumo**. Vender por mesa, por domicilio o por plataforma
    no puede cambiar lo que sale del inventario."""
    from tests.audit.conftest import make_ingredient, put_recipe

    open_shift()
    identify(device_client, employees["cashier"])
    enable_2c()
    set_feature("pos.tables", True)

    ingrediente = make_ingredient(admin_client, store, name="Arroz de los tres canales")
    product = _product(
        db, store, price_dine_in=100_000, price_delivery=120_000, price_platform=140_000, station="hot_kitchen"
    )
    put_recipe(
        admin_client,
        product.id,
        lines=[{"ingredient_id": ingrediente["id"], "qty": "1.000", "unit": ingrediente["base_unit"]}],
    )

    consumos: dict[str, int] = {}
    for canal in ("dine_in", "delivery", "platform"):
        antes = stock_of(db, store, ingredient_id=ingrediente["id"])
        if canal == "dine_in":
            resp = create_order(device_client, channel="dine_in", table_ids=[audit_tables[0].id])
        elif canal == "delivery":
            resp = create_order(
                device_client,
                channel="delivery",
                delivery={"address": "X", "phone": "300", "courier_employee_id": courier.id},
            )
        else:
            resp = create_order(
                device_client,
                channel="platform",
                platform={"platform_id": platform.id, "external_id": f"EXT-{canal}"},
            )
        assert resp.status_code in (200, 201), resp.text
        order = resp.json()
        add_items(device_client, order, [{"product_id": product.id, "qty": 2}])
        order = get_order(device_client, order["id"])
        assert send(device_client, order).status_code == 200, f"{canal}: no se pudo enviar"
        db.expire_all()
        consumos[canal] = antes - stock_of(db, store, ingredient_id=ingrediente["id"])

        # Liberar la mesa para el siguiente canal no hace falta: cada canal
        # abre su propia comanda y sólo `dine_in` usa mesa.

    assert consumos["dine_in"] > 0, f"el envío de mesa no descontó nada: {consumos}"
    assert consumos["dine_in"] == consumos["delivery"] == consumos["platform"], (
        f"los tres canales dejaron el inventario distinto: {consumos}"
    )


# ===========================================================================
# #12 — ZONA HORARIA
# ===========================================================================


def test_a_platform_order_loaded_at_00_30_is_sealed_with_the_business_day_of_the_shift(
    device_client: Any,
    identify: Any,
    employees: dict[str, Any],
    enable_2c: Any,
    open_shift: Any,
    clock: Any,
    db: Any,
    store: Any,
    platform: Any,
) -> None:
    """Checklist #12: a las 00:30 (hora de Bogotá) el día de negocio sigue
    siendo el del turno, porque la hora de corte de la sede son las 06:00.

    La fecha esperada se deriva como la deriva el SERVIDOR —
    `app.core.tz.today_business_date(store.cutoff_hour)` — y **jamás** de
    `clock.now_utc().date()`: en 2b un test que hizo eso era rojo de 00:00 a
    10:59 UTC todas las noches y nadie lo vio porque la corrida cayó en la
    ventana verde.
    """
    from app.core import tz
    from app.orders.models import Order

    # 15 de enero de 2026, 20:00 Bogotá = 01:00 UTC del 16. Abrir el turno acá.
    clock.set(datetime(2026, 1, 16, 1, 0, tzinfo=timezone.utc))
    shift_body = open_shift()
    identify(device_client, employees["cashier"])
    enable_2c()
    product = _product(db, store, price_platform=50_000)
    dia_del_turno = tz.today_business_date(store.cutoff_hour)

    # 00:30 Bogotá del día siguiente = 05:30 UTC. Antes del corte (06:00
    # Bogotá), así que el día de negocio NO cambió.
    clock.set(datetime(2026, 1, 16, 5, 30, tzinfo=timezone.utc))
    identify(device_client, employees["cashier"])
    esperado = tz.today_business_date(store.cutoff_hour)
    assert esperado == dia_del_turno, (
        "el test se armó mal: a las 00:30 de Bogotá el día de negocio tiene que ser el del turno"
    )

    order = _platform_order(device_client, platform, external_id="MADRUGADA-1")
    add_items(device_client, order, [{"product_id": product.id, "qty": 1}])
    order = get_order(device_client, order["id"])
    pay(
        device_client,
        order["id"],
        splits=[{"method": "platform", "amount": 50_000}],
        tip=NO_TIP,
        expected_version=order["version"],
    )

    fila = db.get(Order, order["id"])
    assert fila.business_date == esperado, (
        f"el pedido quedó sellado con {fila.business_date} y el día del turno es {esperado}"
    )
    assert fila.shift_id == shift_body["id"], "el pedido de madrugada no quedó en el turno abierto"

    cuentas = receivables_of(db, store)
    assert len(cuentas) == 1 and cuentas[0].business_date == esperado, (
        f"la cuenta por cobrar quedó con el día {cuentas[0].business_date} y el turno es {esperado}"
    )
    asientos = commissions_of(db, store)
    assert asientos and asientos[0].business_date == esperado, (
        f"la comisión quedó con el día {asientos[0].business_date} y el turno es {esperado}"
    )


# ===========================================================================
# #13 — SIN `float`
# ===========================================================================


def test_no_money_or_percentage_column_of_the_new_domains_is_a_float(db: Any) -> None:
    """Checklist #13, leído del MODELO (no de una lista a mano): ninguna
    columna de `channels`, ni el precio por canal del catálogo, ni la
    comisión congelada de la comanda, puede ser `Float`/`Numeric`/`Decimal`.
    Una columna que agregue fase 3 cae sola en este barrido."""
    from sqlalchemy import Float, Numeric

    from app.catalog.models import Product
    from app.channels.models import (
        DeliveryPlatform,
        DeliverySettlement,
        PlatformCommission,
        PlatformReceivable,
    )
    from app.orders.models import Order

    hallazgos: list[str] = []
    tablas = [DeliveryPlatform, DeliverySettlement, PlatformCommission, PlatformReceivable]
    for modelo in tablas:
        for columna in modelo.__table__.columns:
            if isinstance(columna.type, (Float, Numeric)):
                hallazgos.append(f"{modelo.__tablename__}.{columna.name} = {columna.type}")
    for nombre in ("price_dine_in", "price_takeout", "price_delivery", "price_platform"):
        columna = Product.__table__.columns[nombre]
        if isinstance(columna.type, (Float, Numeric)):
            hallazgos.append(f"products.{nombre} = {columna.type}")
    columna = Order.__table__.columns["platform_commission_bp"]
    if isinstance(columna.type, (Float, Numeric)):
        hallazgos.append(f"orders.platform_commission_bp = {columna.type}")
    assert not hallazgos, "hay plata o porcentaje en coma flotante: " + str(hallazgos)


def test_no_schema_of_the_new_domains_declares_a_float_field() -> None:
    """Checklist #13, en el CONTRATO: ningún campo de los esquemas nuevos es
    `float`. Se recorren los modelos Pydantic de `app.channels.schemas` y los
    campos de 2c de `app.orders.schemas`/`app.payments.schemas`."""
    from pydantic import BaseModel

    from app.channels import schemas as channels_schemas
    from app.orders import schemas as orders_schemas
    from app.payments import schemas as payments_schemas

    # Excepción HEREDADA y declarada: `suggested_pct` (la propina sugerida de
    # 1b) es `float` en `app.orders.schemas.TipInfoOut` y en
    # `app.payments.schemas.DocumentTipOut`. NO es de 2c y no es comisión ni
    # precio por canal; queda anotada en el informe del auditor como deuda
    # heredada, no se tapa acá: este invariante la nombra por nombre exacto
    # para que un `float` NUEVO no se cuele detrás de ella.
    HEREDADOS = {
        ("app.orders.schemas", "TipInfoOut", "suggested_pct"),
        ("app.payments.schemas", "DocumentTipOut", "suggested_pct"),
    }
    hallazgos: list[str] = []
    for modulo in (channels_schemas, orders_schemas, payments_schemas):
        for nombre in dir(modulo):
            objeto = getattr(modulo, nombre)
            if not (isinstance(objeto, type) and issubclass(objeto, BaseModel)):
                continue
            for campo, info in objeto.model_fields.items():
                textos = str(info.annotation)
                if "float" not in textos.lower() and "Decimal" not in textos:
                    continue
                if (modulo.__name__, nombre, campo) in HEREDADOS:
                    continue
                hallazgos.append(f"{modulo.__name__}.{nombre}.{campo}: {textos}")
    assert not hallazgos, "hay un campo float/Decimal NUEVO en un esquema publicado: " + str(hallazgos)


def test_no_float_ever_travels_in_the_json_of_the_new_routes(
    device_client: Any,
    admin_client: Any,
    identify: Any,
    employees: dict[str, Any],
    enable_2c: Any,
    open_shift: Any,
    db: Any,
    store: Any,
    platform: Any,
    courier: Any,
    delivery_fee_product: Any,
) -> None:
    """Checklist #13, lo que sale de verdad por la API: se recorre el JSON de
    las rutas nuevas y ningún valor numérico puede ser `float`. Es la tercera
    puerta (base, esquema, JSON) y la única que ve un `float` construido a
    mano dentro de un `dict[str, Any]` sin `response_model`."""

    def floats(valor: Any, donde: str) -> list[str]:
        out: list[str] = []
        if isinstance(valor, bool):
            return out
        if isinstance(valor, float):
            return [f"{donde} = {valor!r}"]
        if isinstance(valor, dict):
            for k, v in valor.items():
                out += floats(v, f"{donde}.{k}")
        elif isinstance(valor, list):
            for i, v in enumerate(valor):
                out += floats(v, f"{donde}[{i}]")
        return out

    open_shift()
    identify(device_client, employees["cashier"])
    enable_2c()
    product = _product(db, store, price_platform=100_000, price_delivery=95_000, station="hot_kitchen")

    order = _platform_order(device_client, platform)
    add_items(device_client, order, [{"product_id": product.id, "qty": 1}])
    order = get_order(device_client, order["id"])
    send(device_client, order)
    pay(
        device_client,
        order["id"],
        splits=[{"method": "platform", "amount": 100_000}],
        tip=NO_TIP,
        expected_version=order["version"],
    )

    hallazgos: list[str] = []
    for cliente, ruta in (
        (device_client, f"{API}/device/platforms"),
        (device_client, f"{API}/delivery-settlements/pending"),
        (device_client, f"{API}/kitchen/rounds"),
        (admin_client, f"{API}/admin/platforms?store_id={store.id}"),
        (admin_client, f"{API}/admin/platform-commissions?store_id={store.id}&from=2026-01-01&to=2026-12-31"),
        (admin_client, f"{API}/admin/platform-receivables?store_id={store.id}&from=2026-01-01&to=2026-12-31"),
        (admin_client, f"{API}/admin/platforms/{platform.id}/summary?store_id={store.id}&from=2026-01-01&to=2026-12-31"),
    ):
        resp = cliente.get(ruta)
        assert resp.status_code == 200, f"{ruta}: {resp.status_code} {resp.text}"
        hallazgos += floats(resp.json(), ruta)
    assert not hallazgos, "salió un float por la API: " + str(hallazgos)


# ===========================================================================
# HALLAZGOS: la propina en efectivo de un domicilio
# ===========================================================================


def _cash_sale_with_tip(
    device_client: Any, db: Any, store: Any, *, channel: str, tip: int, courier: Any = None, price: int = 100_000
) -> dict[str, Any]:
    """Una venta cobrada en EFECTIVO con propina, por el canal pedido."""
    producto = _product(db, store, price_dine_in=price, price_delivery=price, name=f"Plato {channel}")
    if channel == "delivery":
        order = _delivery_order(device_client, courier)
    else:
        resp = create_order(device_client, channel="counter")
        assert resp.status_code in (200, 201), resp.text
        order = resp.json()
    add_items(device_client, order, [{"product_id": producto.id, "qty": 1}])
    order = get_order(device_client, order["id"])
    total = order["totals"]["total"]
    resp = pay(
        device_client,
        order["id"],
        splits=[{"method": "cash", "amount": total + tip, "tendered": total + tip}],
        tip={"asked": True, "accepted": True, "modified": False, "amount": tip},
        expected_version=order["version"],
    )
    assert resp.status_code in (200, 201), resp.text
    return {"order_id": order["id"], "total": total, "tip": tip}


def test_the_same_cash_moves_the_expected_by_the_same_amount_whatever_channel_it_came_through(
    device_client: Any,
    identify: Any,
    employees: dict[str, Any],
    enable_2c: Any,
    open_shift: Any,
    expected_of: Any,
    db: Any,
    store: Any,
    courier: Any,
    delivery_fee_product: Any,
) -> None:
    """**HALLAZGO H-1 (BLOQUEANTE).** El mismo billete mueve el esperado
    distinto según el canal por el que entró.

    - Venta de mostrador de $100.000 **más $10.000 de propina** cobrada en
      efectivo: `expected` sube **$100.000**. La propina en efectivo NO entra
      al esperado en ningún camino de 1b (`get_sales_totals` suma
      `Payment.amount` a `.cash` y `Payment.tip_amount` a `.tips_cash`, y
      `compute_breakdown` sólo lee `.cash`); se salda al cierre con
      `tips_cash_out` (`app/shifts/service.py:1035`).
    - El mismo cobro por **domicilio**, liquidado: `expected` sube
      **$110.000**, porque `app/channels/service.py:484-487` manda
      `total = amount + tip_amount` a `register_delivery_settlement_income`.

    Son dos matemáticas del esperado para la misma plata. La consecuencia es
    del conteo a ciegas: la diferencia del arqueo cambia exactamente en el
    valor de la propina según el canal, y quien cuenta tiene que justificar
    con causa tipada una diferencia que no existe.

    **Remedio**: la liquidación tiene que mover el esperado por el MISMO
    término que mueve una venta en efectivo. O bien el `INCOME` es sólo
    `amount` (y la propina se salda como cualquier otra propina en efectivo,
    por `tips_cash`), o bien `get_sales_totals` empieza a sumar `tip_amount`
    a `.cash` en TODOS los caminos — pero no uno sí y el otro no.
    **Dueño**: `backend-dinero-canales` (`app/channels/service.py`,
    `app/shifts/hooks.py`).
    """
    shift = open_shift()
    identify(device_client, employees["cashier"])
    enable_2c()

    antes_mostrador = expected_of(shift["id"])
    _cash_sale_with_tip(device_client, db, store, channel="counter", tip=10_000)
    delta_mostrador = expected_of(shift["id"]) - antes_mostrador

    antes_domicilio = expected_of(shift["id"])
    _cash_sale_with_tip(device_client, db, store, channel="delivery", tip=10_000, courier=courier)
    liquidacion = device_client.post(
        f"{API}/delivery-settlements", json={"courier_employee_id": courier.id}, headers=idem_headers()
    )
    assert liquidacion.status_code in (200, 201), liquidacion.text
    delta_domicilio = expected_of(shift["id"]) - antes_domicilio

    # El de mostrador incluye el cargo 0 y el de domicilio incluye el cargo de
    # $5.000 como línea; por eso se compara el EXCESO sobre la venta cobrada,
    # que es exactamente la propina o nada.
    venta_mostrador = 100_000
    venta_domicilio = liquidacion.json()["amount"]
    exceso_mostrador = delta_mostrador - venta_mostrador
    exceso_domicilio = delta_domicilio - venta_domicilio

    assert exceso_mostrador == exceso_domicilio, (
        "el mismo billete mueve el esperado distinto según el canal: una venta de mostrador en efectivo "
        f"con propina sube el esperado {exceso_mostrador} por encima de la venta, y un domicilio "
        f"liquidado lo sube {exceso_domicilio}. `app/channels/service.py:484-487` manda "
        "`total = amount + tip_amount` al `INCOME`, y `app/shifts/hooks.py:166-168` deja la propina fuera "
        "de `.cash` en todos los demás caminos. Son dos matemáticas del esperado para la misma plata, "
        "y la diferencia del arqueo a ciegas cambia por el valor de la propina según el canal"
    )


def test_the_shift_tips_reading_counts_the_same_cash_tip_once(
    device_client: Any,
    admin_client: Any,
    identify: Any,
    employees: dict[str, Any],
    enable_2c: Any,
    open_shift: Any,
    db: Any,
    store: Any,
    courier: Any,
    delivery_fee_product: Any,
) -> None:
    """**HALLAZGO H-2 (BLOQUEANTE).** `GET /shifts/{id}/tips` responde la
    misma pregunta con dos fórmulas distintas dentro del MISMO cuerpo.

    - `by_method.cash` y `cash_out` salen de `get_sales_totals().tips_cash`,
      que desde 2c **excluye** la propina en efectivo de un domicilio
      (`app/shifts/hooks.py:157-164`: el pago con `courier_id` se desvía
      entero a `delivery_cash`/`tips_delivery`).
    - `by_employee[*].cash` se calcula **aparte**, en
      `app/shifts/tips.py:49-78`, releyendo `Payment` sin esa exclusión: ahí
      la propina de domicilio SÍ cuenta.

    Con una propina de mostrador de $10.000 y una de domicilio de $10.000 el
    mismo cuerpo dice `by_method.cash = 10.000` y `by_employee[*].cash` suma
    $20.000. Es propina de un empleado (Ley 1935 de 2018, pasivo con el
    personal): el reparto por persona ofrece más plata de la que `cash_out`
    autoriza a sacar del cajón.

    Es **H-4 de 2b en su forma exacta** — la misma pregunta respondida dos
    veces, con dos fórmulas — ahora dentro de una sola respuesta.

    **Remedio**: `by_employee` tiene que derivarse del MISMO reparto que
    `by_method` (una sola función que clasifique un `Payment` en su bolsillo),
    o publicar el renglón de domicilio también por empleado. **Dueño**:
    `backend-dinero-canales` (`app/shifts/hooks.py`, `app/shifts/tips.py`).
    """
    shift = open_shift()
    identify(device_client, employees["cashier"])
    enable_2c()

    _cash_sale_with_tip(device_client, db, store, channel="counter", tip=10_000)
    _cash_sale_with_tip(device_client, db, store, channel="delivery", tip=10_000, courier=courier)

    resp = admin_client.get(f"{API}/shifts/{shift['id']}/tips")
    assert resp.status_code == 200, resp.text
    cuerpo = resp.json()
    por_metodo = cuerpo["by_method"]["cash"]
    por_empleado = sum(fila["cash"] for fila in cuerpo["by_employee"])

    assert por_metodo == por_empleado, (
        "el mismo cuerpo de `GET /shifts/{id}/tips` cuenta la propina en efectivo de dos maneras: "
        f"`by_method.cash` = {por_metodo} y la suma de `by_employee[*].cash` = {por_empleado}. "
        "`by_method`/`cash_out` salen de `get_sales_totals().tips_cash` (que desde 2c excluye la propina "
        "de domicilio) y `by_employee` se recalcula en `app/shifts/tips.py:49-78` sin esa exclusión. "
        "Es propina de un empleado: el reparto por persona ofrece plata que `cash_out` no autoriza a sacar"
    )
    assert cuerpo["cash_out"] == por_empleado, (
        f"`cash_out` ({cuerpo['cash_out']}) no alcanza para pagar lo que el reparto por empleado "
        f"declara ({por_empleado})"
    )
