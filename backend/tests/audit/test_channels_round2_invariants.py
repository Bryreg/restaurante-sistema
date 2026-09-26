"""Ronda 2 del pedido 2c — los invariantes que cobran el CIERRE de H-1 y H-2.

La ronda 1 dejó dos bloqueantes en `app/shifts/**` (tercer pedido seguido como
territorio cruzado):

- **H-1** — la propina en efectivo de un domicilio movía el esperado del turno
  y la de cualquier otra venta no: dos matemáticas del esperado para la misma
  plata.
- **H-2** — `GET /shifts/{id}/tips` contaba la misma propina en efectivo dos
  veces, con dos fórmulas, dentro del mismo cuerpo.

Este archivo **no reemplaza** a los dos tests de la ronda 1 (que siguen en
`test_channels_money_invariants.py` y son los que mandan). Cobra lo que el
Maestro pidió verificar *además* de que esos dos den verde, y lo cobra **por
código, no por confianza**:

1. Que la fórmula heredada quedó intacta **letra por letra**: el `expected` de
   `compute_breakdown` y el `to_deposit` de `_finalize_close`. Si el arreglo
   los tocó, es hallazgo nuevo y bloqueante.
2. Que de verdad hay **una sola** función de clasificación y que los dos
   caminos la llaman: ni un `_OTHER_METHODS` duplicado, ni un bucle que
   reclasifique a mano en `app/shifts/tips.py`.
3. Que la plata **no desapareció** al sacarla de `.cash`: el renglón de
   domicilio es entero, sin costo ni comisión, y venta+propina de lo pendiente
   sigue coincidiendo con `delivery_cash_pending` del desglose.
4. Que la anulación deja el esperado **exactamente** donde estaba.
5. Y el invariante que cierra H-1 donde la plata se ve de verdad: **el mismo
   billete abre la misma brecha de arqueo, venga por el canal que venga**.

Ninguna aserción de acá se ablandó respecto de la ronda 1: todas son
igualdades exactas.
"""

from __future__ import annotations

import ast
from typing import Any

from tests.audit.conftest import (
    add_items,
    app_source_files,
    cash_movements_of,
    create_order,
    deep_keys,
    get_order,
    idem_headers,
    pay,
)

API = "/api/v1"
PHOTO = "data:image/png;base64,AAAA"

#: La fórmula heredada de 1b, escrita acá **letra por letra**. No es una
#: paráfrasis: es el texto exacto que tiene que seguir teniendo
#: `app/shifts/service.py`. El pedido 2c existe para agregar plata por caminos
#: nuevos SIN tocarla.
#:
#: **Movida a propósito el 2026-09-24, por decisión del dueño**: la venta sin
#: consignar se queda en el cajón (`docs/SPEC-NEGOCIO.md` §3.2, `docs/ESTADO.md`
#: §39). Dos términos nuevos, y ninguno es de domicilios ni de propinas (eso
#: lo sigue cobrando el test de abajo): `deposits` —lo consignado desde el
#: cajón en el POS, que ya no está en el cajón— resta del esperado, y
#: `carried_still_in_drawer` —la plata de días anteriores que sigue en el
#: cajón, que es saldo de su turno de origen— resta de lo que este turno
#: debe consignar. Sin el segundo, la venta de ayer se contaría dos veces.
#:
#: **Movida otra vez a propósito el 2026-09-26, por decisión del dueño**
#: (`docs/SPEC-NEGOCIO.md` §3.2, `docs/ESTADO.md` §46): el cajón abre SÓLO con
#: los sobres por consignar que se eligen y se cuentan, y la «base» es una
#: sola cosa —la base de respaldo, aparte del cajón—. Tres cambios, y ninguno
#: es de domicilios ni de propinas (eso lo sigue cobrando el test de abajo):
#: `reserve_loan` —lo que el cajón tomó prestado de la base de respaldo y no
#: devolvió— SUMA al esperado, porque esa plata está en el cajón; la base fija
#: que resta `to_deposit` pasa a ser la que el TURNO congeló al abrir
#: (`shift.opening_fixed_base`: la de la sede para los turnos de la regla
#: anterior, 0 con la regla de sobres) en vez de la de la sede en vivo —así un
#: cambio de configuración nunca reescribe la cuenta de un turno—; y el
#: préstamo sin devolver resta de lo que se consigna, porque vuelve a la
#: base, no al banco (es la resta que el café no hizo: $697.900 en vez de
#: $197.900).
EXPECTED_FORMULA = "expected = base + sales.cash + incomes - expenses - pickups - deposits + reserve_loan"
TO_DEPOSIT_FORMULA = (
    "to_deposit = count.counted_cash_total - shift.opening_fixed_base - (count.tips_cash_out or 0)"
    " - carried_still_in_drawer(db, shift) - reserve.loan_outstanding(db, shift.id)"
)


def _source_tree(path: str) -> ast.AST:
    for ruta, arbol in app_source_files():
        if ruta == path:
            return arbol
    raise AssertionError(f"no se encontró {path}")


def _function(tree: ast.AST, name: str) -> ast.FunctionDef:
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    raise AssertionError(f"no se encontró la función {name!r}")


def _single_assignment(func: ast.FunctionDef, target: str) -> ast.Assign:
    asignaciones = [
        n
        for n in ast.walk(func)
        if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == target for t in n.targets)
    ]
    assert len(asignaciones) == 1, (
        f"`{target}` se asigna {len(asignaciones)} veces dentro de `{func.name}`: hay dos matemáticas "
        "donde la spec exige una"
    )
    return asignaciones[0]


# ---------------------------------------------------------------------------
# 1. La fórmula heredada, letra por letra
# ---------------------------------------------------------------------------


def test_the_inherited_expected_formula_is_intact_letter_by_letter() -> None:
    """**Lo primero que hay que cobrar de la ronda 2.** El Maestro decidió que
    el esperado heredado NO se toca: el arreglo de H-1 tenía que cambiar
    **cuánto** escribe la liquidación, no **cómo** se calcula el esperado.

    Si esta aserción se pone roja, el arreglo movió la fórmula de 1b y eso es
    un hallazgo nuevo y bloqueante: el esperado del turno es el número contra
    el que se cuenta a ciegas en todo el producto, no sólo en los caminos que
    2c agrega.
    """
    servicio = _source_tree("app/shifts/service.py")

    breakdown = _function(servicio, "compute_breakdown")
    expected_src = ast.unparse(_single_assignment(breakdown, "expected"))
    assert expected_src == EXPECTED_FORMULA, (
        "la fórmula del esperado cambió en la ronda 2.\n"
        f"  esperado (1b): {EXPECTED_FORMULA}\n"
        f"  encontrado   : {expected_src}\n"
        "El arreglo de H-1 no podía tocar `compute_breakdown` (app/shifts/service.py:226-270)"
    )

    finalize = _function(servicio, "_finalize_close")
    to_deposit_src = ast.unparse(_single_assignment(finalize, "to_deposit"))
    assert to_deposit_src == TO_DEPOSIT_FORMULA, (
        "la fórmula de `to_deposit` cambió en la ronda 2.\n"
        f"  esperado (1b): {TO_DEPOSIT_FORMULA}\n"
        f"  encontrado   : {to_deposit_src}\n"
        "Es la que saca la propina en efectivo del cajón al cierre (app/shifts/service.py:1035)"
    )


def test_the_expected_never_gained_a_delivery_term_anywhere_in_the_module() -> None:
    """El corolario del anterior, por si la fórmula se deja intacta y el
    término nuevo se agrega en otra línea del mismo módulo: ninguna asignación
    a `expected` de `app/shifts/service.py` puede nombrar el efectivo de
    domicilios ni las propinas."""
    servicio = _source_tree("app/shifts/service.py")
    for node in ast.walk(servicio):
        if not isinstance(node, ast.Assign):
            continue
        if not any(isinstance(t, ast.Name) and t.id in ("expected", "to_deposit") for t in node.targets):
            continue
        texto = ast.dump(node)
        for prohibido in ("delivery_cash", "delivery_cash_pending", "tips_delivery", "tips_delivery_pending"):
            assert prohibido not in texto, (
                f"una asignación a `expected`/`to_deposit` pasó a nombrar {prohibido!r}: "
                "es plata que no está en el cajón (o propina que no es del cajón), y meterla "
                "en el esperado es exactamente el defecto que H-1 denunció, del otro lado"
            )


# ---------------------------------------------------------------------------
# 2. Una sola función clasifica el bolsillo de un `Payment`
# ---------------------------------------------------------------------------


def test_only_one_function_in_the_backend_classifies_a_payment_into_its_pocket() -> None:
    """Cierre estructural de H-2. La pregunta «¿en qué bolsillo cae este
    cobro?» tiene que tener **una sola** respuesta en todo `app/**`:

    - `_OTHER_METHODS` se define **una vez**, y sólo en `app/shifts/hooks.py`.
    - `payment_bucket` se define **una vez**.
    - `app/shifts/tips.py` **no** vuelve a nombrar `_OTHER_METHODS` ni a
      comparar contra nombres de medios de pago: llama a `payment_bucket`.

    Un `_OTHER_METHODS` duplicado o un `if method == "cash"` suelto en
    `tips.py` es H-2 volviendo, y el typecheck no lo vería.
    """
    definiciones_other: list[str] = []
    definiciones_bucket: list[str] = []
    for ruta, arbol in app_source_files():
        for node in ast.walk(arbol):
            if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == "_OTHER_METHODS" for t in node.targets
            ):
                definiciones_other.append(ruta)
            if isinstance(node, ast.FunctionDef) and node.name == "payment_bucket":
                definiciones_bucket.append(ruta)

    assert definiciones_other == ["app/shifts/hooks.py"], (
        f"`_OTHER_METHODS` se define en {definiciones_other}: la lista de medios que NO entran al "
        "cajón tiene que vivir en un solo lugar (H-2 nació de responder la misma pregunta dos veces)"
    )
    assert definiciones_bucket == ["app/shifts/hooks.py"], (
        f"`payment_bucket` se define en {definiciones_bucket}: tiene que haber UNA sola función "
        "que decida el bolsillo de un cobro"
    )


def test_both_readers_of_the_shift_money_call_the_single_classifier() -> None:
    """La otra mitad del cierre de H-2: que los **dos** caminos la llamen.

    `get_sales_totals` (`app/shifts/hooks.py`) alimenta `by_method`/`cash_out`
    y el esperado; `get_shift_tips` (`app/shifts/tips.py`) alimenta
    `by_employee`. En la ronda 1 el segundo reclasificaba a mano y las dos
    mitades del mismo JSON se separaron.
    """
    hooks_tree = _source_tree("app/shifts/hooks.py")
    tips_tree = _source_tree("app/shifts/tips.py")

    def _llama_a_payment_bucket(func: ast.FunctionDef) -> bool:
        for node in ast.walk(func):
            if not isinstance(node, ast.Call):
                continue
            objetivo = node.func
            if isinstance(objetivo, ast.Name) and objetivo.id == "payment_bucket":
                return True
            if isinstance(objetivo, ast.Attribute) and objetivo.attr == "payment_bucket":
                return True
        return False

    totals = _function(hooks_tree, "get_sales_totals")
    tips = _function(tips_tree, "get_shift_tips")
    assert _llama_a_payment_bucket(totals), (
        "`get_sales_totals` dejó de llamar a `payment_bucket`: volvió a clasificar por su cuenta"
    )
    assert _llama_a_payment_bucket(tips), (
        "`get_shift_tips` (app/shifts/tips.py) no llama a `payment_bucket`: si reclasifica a mano, "
        "H-2 vuelve — el mismo cuerpo diría dos números distintos para la misma propina"
    )


def test_the_tips_module_never_reclassifies_a_payment_method_by_hand() -> None:
    """El candado fino sobre `app/shifts/tips.py`: ni un nombre de medio de
    pago escrito a mano en una comparación, una pertenencia, un literal de
    conjunto/lista o una clave de `dict` **usada para clasificar**.

    Se permiten los nombres de los BOLSILLOS como claves del acumulador
    (`{"cash": 0, "card": 0, ...}`), que es la forma del resultado, no la
    regla: lo que se prohíbe es decidir con ellos.
    """
    tips_tree = _source_tree("app/shifts/tips.py")
    tips = _function(tips_tree, "get_shift_tips")
    medios = {"platform", "voucher", "cash", "card", "transfer"}

    for node in ast.walk(tips):
        if isinstance(node, ast.Compare):
            textos = {
                n.value
                for n in [node.left, *node.comparators]
                if isinstance(n, ast.Constant) and isinstance(n.value, str)
            }
            colision = textos & medios
            assert not colision, (
                f"`get_shift_tips` compara contra {sorted(colision)}: está reclasificando el medio de "
                "pago a mano en vez de preguntarle a `hooks.payment_bucket` (H-2)"
            )
        if isinstance(node, (ast.Set, ast.List, ast.Tuple)):
            textos = {n.value for n in node.elts if isinstance(n, ast.Constant) and isinstance(n.value, str)}
            colision = textos & medios
            assert not colision, (
                f"`get_shift_tips` arma un literal con {sorted(colision)}: una segunda lista de medios "
                "es exactamente el `_OTHER_METHODS` duplicado que H-2 prohíbe"
            )


# ---------------------------------------------------------------------------
# Armado de un turno con propinas por TODOS los bolsillos
# ---------------------------------------------------------------------------


def _product(db: Any, store: Any, *, name: str, price: int = 100_000) -> Any:
    from app.catalog.models import Category, Product
    from app.core import clock as clock_module

    now = clock_module.now_utc()
    category = Category(
        organization_id=store.organization_id,
        store_id=store.id,
        name=f"Ronda 2 — {name}",
        sort_order=95,
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
        price_delivery=price,
        price_platform=price,
        tax_code="inc_8",
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


def _sale(
    client: Any,
    db: Any,
    store: Any,
    *,
    method: str,
    tip: int,
    channel: str = "counter",
    courier: Any = None,
    platform: Any = None,
    pin: str = "1111",
    price: int = 100_000,
    name: str | None = None,
) -> dict[str, Any]:
    """Una venta cobrada por `method`, con propina, por el canal pedido."""
    producto = _product(db, store, name=name or f"Plato {method} {channel}", price=price)
    body: dict[str, Any] = {}
    if channel == "delivery":
        body["delivery"] = {
            "address": "Calle Falsa 123",
            "phone": "3001234567",
            "courier_employee_id": courier.id,
        }
    if channel == "platform":
        body["platform"] = {"platform_id": platform.id, "external_id": f"R2-{method}-{tip}"}
    resp = create_order(client, channel=channel, **body)
    assert resp.status_code in (200, 201), resp.text
    order = resp.json()
    add_items(client, order, [{"product_id": producto.id, "qty": 1}])
    order = get_order(client, order["id"])
    total = order["totals"]["total"]
    split: dict[str, Any] = {"method": method, "amount": total + tip}
    if method == "cash":
        split["tendered"] = total + tip
    if method == "transfer":
        # `transfer` exige referencia (app/stores/service.py:24).
        split["reference"] = f"REF-{order['id']}"
    resp = pay(
        client,
        order["id"],
        splits=[split],
        tip={"asked": True, "accepted": tip > 0, "modified": False, "amount": tip},
        expected_version=order["version"],
        pin=pin,
    )
    assert resp.status_code in (200, 201), resp.text
    return {"order_id": order["id"], "total": total, "tip": tip}


# ---------------------------------------------------------------------------
# 3. `by_method == cash_out == sum(by_employee)` para TODOS los bolsillos
# ---------------------------------------------------------------------------


def test_the_shift_tips_body_answers_every_bucket_with_one_and_the_same_formula(
    device_client: Any,
    admin_client: Any,
    identify: Any,
    employees: dict[str, Any],
    enable_2c: Any,
    open_shift: Any,
    db: Any,
    store: Any,
    courier: Any,
    platform: Any,
    delivery_fee_product: Any,
) -> None:
    """**El invariante que cobra H-2 por código y no por confianza**, con
    propinas de mostrador y de domicilio **mezcladas en el mismo turno**, dos
    empleados que cobran, y los cuatro medios:

        by_method.X == sum(e[X] for e in by_employee)   para X en cash/card/transfer/other
        by_method.cash == cash_out
        electronic_liability == card + transfer + other

    Si `by_employee` volviera a calcularse con otra regla, alguna de estas
    cuatro igualdades se rompe. En la ronda 1 se rompía la primera: el mismo
    cuerpo decía 10.000 y 20.000.
    """
    shift = open_shift()
    enable_2c()

    # Un segundo cobrador, para que `by_employee` tenga más de una fila y la
    # suma no sea trivialmente igual al total de una sola persona.
    segundo = employees["operator2"]
    segundo.can_charge = True
    db.commit()

    identify(device_client, employees["cashier"])
    _sale(device_client, db, store, method="cash", tip=10_000, channel="counter", name="A")
    _sale(
        device_client, db, store, method="cash", tip=10_000, channel="delivery", courier=courier, name="B"
    )
    _sale(device_client, db, store, method="card", tip=7_000, channel="counter", name="C")

    identify(device_client, segundo)
    _sale(device_client, db, store, method="transfer", tip=3_000, channel="counter", pin="3333", name="D")
    _sale(
        device_client,
        db,
        store,
        method="platform",
        tip=4_000,
        channel="platform",
        platform=platform,
        pin="3333",
        name="E",
    )
    _sale(
        device_client,
        db,
        store,
        method="cash",
        tip=5_000,
        channel="delivery",
        courier=courier,
        pin="3333",
        name="F",
    )

    resp = admin_client.get(f"{API}/shifts/{shift['id']}/tips")
    assert resp.status_code == 200, resp.text
    cuerpo = resp.json()
    por_metodo = cuerpo["by_method"]
    por_empleado = cuerpo["by_employee"]

    assert len(por_empleado) >= 2, (
        f"el reparto por empleado trajo {len(por_empleado)} fila(s): el test necesita dos cobradores "
        "para que la igualdad no sea trivial"
    )

    for bolsillo in ("cash", "card", "transfer", "other"):
        suma = sum(fila[bolsillo] for fila in por_empleado)
        assert por_metodo[bolsillo] == suma, (
            f"`by_method.{bolsillo}` = {por_metodo[bolsillo]} y `sum(by_employee[*].{bolsillo})` = {suma} "
            "en el MISMO cuerpo de `GET /shifts/{id}/tips`. Es H-2: la misma pregunta respondida dos "
            "veces con dos fórmulas (app/shifts/hooks.py::payment_bucket vs. una reclasificación a mano "
            "en app/shifts/tips.py). Es propina de un empleado (Ley 1935 de 2018)"
        )

    assert cuerpo["cash_out"] == por_metodo["cash"], (
        f"`cash_out` = {cuerpo['cash_out']} y `by_method.cash` = {por_metodo['cash']}: `cash_out` es lo "
        "que se autoriza a sacar del cajón y tiene que ser exactamente la propina en efectivo del cajón"
    )
    assert cuerpo["electronic_liability"] == (
        por_metodo["card"] + por_metodo["transfer"] + por_metodo["other"]
    ), cuerpo

    # Y la propina de domicilio no se coló al bolsillo del cajón: 10.000 + 5.000.
    #
    # RONDA 3: la clave se llama `delivery_tips` desde el cierre de H-7 (el
    # renombre que este mismo informe prescribió). Cambia el NOMBRE, no el
    # hecho medido: 15.000 de propina de domicilio, y el renglón por empleado
    # tiene que sumar exactamente eso. La afirmación de `cash_out` de arriba
    # queda intacta, letra por letra.
    assert cuerpo["delivery_tips"] == 15_000, cuerpo
    assert sum(fila["delivery"] for fila in por_empleado) == cuerpo["delivery_tips"], (
        "el renglón de domicilio por empleado no suma el del cuerpo: es el mismo defecto de H-2 "
        "en el campo nuevo"
    )
    # Y la razón por la que `cash_out == by_method.cash` sigue valiendo ACÁ:
    # en este turno nadie liquidó, así que no hay propina de domicilio en el
    # cajón. Se MIDE, no se razona (ronda 3).
    assert cuerpo["delivery_tips_settled"] == 0, (
        f"nadie liquidó en este turno y `delivery_tips_settled` = {cuerpo['delivery_tips_settled']}: "
        "si no es 0, la igualdad `cash_out == by_method.cash` de arriba dejó de medir lo que dice medir"
    )
    assert por_metodo["cash"] == 10_000, (
        f"`by_method.cash` = {por_metodo['cash']}: la propina en efectivo del CAJÓN son los 10.000 de "
        "mostrador; los 15.000 de domicilio los tiene el domiciliario"
    )


# ---------------------------------------------------------------------------
# 4. La plata no desapareció al sacarla de `.cash`
# ---------------------------------------------------------------------------


def test_the_delivery_tip_row_is_a_whole_number_without_cost_or_commission(
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
    """El renglón nuevo de `ShiftTipsOut`/`TipsByEmployeeOut` no puede
    convertirse en un agujero nuevo:

    - **entero, jamás `float`** (regla dura del proyecto y renglón #13 del
      checklist), verificado sobre el JSON real y no sobre el esquema;
    - **sin costo ni comisión**: es una pantalla de propinas;
    - y `total` por empleado sigue sumando los cinco bolsillos, así que la
      plata que salió de `.cash` **se ve**, no desapareció.
    """
    shift = open_shift()
    identify(device_client, employees["cashier"])
    enable_2c()

    _sale(device_client, db, store, method="cash", tip=10_000, channel="counter", name="G")
    _sale(
        device_client, db, store, method="cash", tip=9_000, channel="delivery", courier=courier, name="H"
    )

    resp = admin_client.get(f"{API}/shifts/{shift['id']}/tips")
    assert resp.status_code == 200, resp.text
    cuerpo = resp.json()

    def _sin_float(valor: Any, camino: str) -> None:
        if isinstance(valor, dict):
            for k, v in valor.items():
                _sin_float(v, f"{camino}.{k}")
        elif isinstance(valor, list):
            for i, v in enumerate(valor):
                _sin_float(v, f"{camino}[{i}]")
        else:
            assert not isinstance(valor, float), (
                f"{camino} viaja como `float` ({valor!r}) en `GET /shifts/{{id}}/tips`: la plata del "
                "sistema es entera (renglón #13 del checklist)"
            )

    _sin_float(cuerpo, "tips")

    claves = deep_keys(cuerpo)
    for prohibida in claves:
        bajo = prohibida.lower()
        assert "cost" not in bajo and "margin" not in bajo and "commission" not in bajo, (
            f"`GET /shifts/{{id}}/tips` publica la clave {prohibida!r}: es una pantalla de propinas, "
            "no de costos ni de comisiones"
        )

    # RONDA 3: `delivery_cash`/`delivery_cash_pending` de ESTA respuesta se
    # llaman `delivery_tips`/`delivery_tips_pending` desde el cierre de H-7.
    # Mismos montos, mismo hecho.
    assert cuerpo["delivery_tips"] == 9_000, cuerpo
    assert cuerpo["delivery_tips_pending"] == 9_000, (
        "la propina de domicilio todavía no liquidada tiene que verse como pendiente; si no, la plata "
        "que salió de `.cash` desapareció de la pantalla"
    )
    for fila in cuerpo["by_employee"]:
        esperado = fila["cash"] + fila["card"] + fila["transfer"] + fila["other"] + fila["delivery"]
        assert fila["total"] == esperado, (
            f"el `total` de {fila['employee_name']} ({fila['total']}) no suma sus cinco bolsillos "
            f"({esperado}): el renglón de domicilio quedó fuera del total y la plata desaparece"
        )


def test_the_pending_delivery_cash_of_the_breakdown_is_sale_plus_tip_of_what_is_pending(
    device_client: Any,
    admin_client: Any,
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
    """El puente entre las dos lecturas, que es donde una plata se pierde sin
    que nadie lo note:

        GET /delivery-settlements/pending  ->  amount + tip_amount == total
        GET /shifts/{id}  ->  breakdown.delivery_cash_pending == ese total
        GET /shifts/{id}/tips -> delivery_cash_pending == la parte de PROPINA

    Y al liquidar, el esperado sube **exactamente por `amount`** (la venta
    sola): es el cierre de H-1 medido en el número, no en el docstring.
    """
    shift = open_shift()
    identify(device_client, employees["cashier"])
    enable_2c()

    _sale(
        device_client, db, store, method="cash", tip=12_000, channel="delivery", courier=courier, name="I"
    )

    pendiente = device_client.get(f"{API}/delivery-settlements/pending")
    assert pendiente.status_code == 200, pendiente.text
    pend = pendiente.json()
    assert pend["total"] == pend["amount"] + pend["tip_amount"], pend
    assert pend["tip_amount"] == 12_000, pend

    resumen = admin_client.get(f"{API}/shifts/{shift['id']}")
    assert resumen.status_code == 200, resumen.text
    desglose = resumen.json()
    assert desglose["delivery_cash_pending"] == pend["total"], (
        f"el desglose del turno dice que hay {desglose['delivery_cash_pending']} de domicilios "
        f"pendientes y la lista de pendientes dice {pend['total']}: son dos matemáticas de la misma "
        "plata (venta + propina es lo que sostiene el domiciliario)"
    )

    tips = admin_client.get(f"{API}/shifts/{shift['id']}/tips")
    assert tips.status_code == 200, tips.text
    # RONDA 3: en `GET /shifts/{id}/tips` la clave es `delivery_tips_pending`
    # (cierre de H-7). El desglose de arriba conserva `delivery_cash_pending`
    # con su significado de siempre: venta + propina.
    assert tips.json()["delivery_tips_pending"] == pend["tip_amount"], (
        "la parte de PROPINA de lo pendiente tiene que ser la misma en las dos lecturas"
    )

    antes = expected_of(shift["id"])
    liquidacion = device_client.post(
        f"{API}/delivery-settlements", json={"courier_employee_id": courier.id}, headers=idem_headers()
    )
    assert liquidacion.status_code in (200, 201), liquidacion.text
    cuerpo = liquidacion.json()
    despues = expected_of(shift["id"])

    assert cuerpo["total"] == cuerpo["amount"] + cuerpo["tip_amount"], cuerpo
    assert cuerpo["tip_amount"] == 12_000, cuerpo
    assert despues - antes == cuerpo["amount"], (
        f"la liquidación movió el esperado {despues - antes} y la VENTA liquidada es {cuerpo['amount']} "
        f"(la propina fue {cuerpo['tip_amount']}). El `INCOME` de la liquidación tiene que escribirse "
        "por la venta sola: si incluye la propina, el mismo billete mueve el esperado distinto según "
        "el canal por el que entró (H-1)"
    )

    movimientos = [
        m
        for m in cash_movements_of(db, shift["id"])
        if getattr(m.cause, "value", str(m.cause)) == "delivery_settlement"
    ]
    assert len(movimientos) == 1, f"la liquidación escribió {len(movimientos)} movimientos: {movimientos}"
    assert movimientos[0].amount == cuerpo["amount"], (
        f"el `CashMovement` de la liquidación vale {movimientos[0].amount} y la venta liquidada "
        f"{cuerpo['amount']}: el movimiento tiene que ser por la venta sola"
    )

    desglose2 = admin_client.get(f"{API}/shifts/{shift['id']}").json()
    assert desglose2["delivery_cash_pending"] == 0, (
        "después de liquidar no queda efectivo de domicilios pendiente, y el desglose tiene que decirlo"
    )


# ---------------------------------------------------------------------------
# 5. La anulación deja el esperado exactamente donde estaba
# ---------------------------------------------------------------------------


def test_settling_and_voiding_leaves_the_expected_exactly_where_it_was(
    device_client: Any,
    admin_client: Any,
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
    """Liquidar → deshacer → **el mismo número**. Con el arreglo de H-1 el
    espejo tiene que moverse por el mismo término que la ida (la venta sola):
    si la ida cambió a `amount` y el espejo se quedó en `amount + tip`, el
    deshacer **fabrica un faltante** del valor de la propina — que es
    literalmente H-1 de 2b en la otra dirección.
    """
    shift = open_shift()
    identify(device_client, employees["cashier"])
    enable_2c()

    _sale(
        device_client, db, store, method="cash", tip=11_000, channel="delivery", courier=courier, name="J"
    )

    antes = expected_of(shift["id"])
    liquidacion = device_client.post(
        f"{API}/delivery-settlements", json={"courier_employee_id": courier.id}, headers=idem_headers()
    )
    assert liquidacion.status_code in (200, 201), liquidacion.text
    settlement = liquidacion.json()
    durante = expected_of(shift["id"])
    assert durante != antes, "la liquidación no movió el esperado: no entró la plata"

    anulacion = device_client.post(
        f"{API}/delivery-settlements/{settlement['id']}/void",
        json={"reason": "El domiciliario entregó de menos"},
        headers=idem_headers(),
    )
    assert anulacion.status_code in (200, 201), anulacion.text
    despues = expected_of(shift["id"])

    assert despues == antes, (
        f"liquidar y deshacer dejó el esperado en {despues} cuando antes era {antes} "
        f"(diferencia {despues - antes}). La ida movió {durante - antes} y la vuelta "
        f"{despues - durante}: el espejo tiene que ser EXACTAMENTE el espejo"
    )

    movimientos = [
        m
        for m in cash_movements_of(db, shift["id"])
        if getattr(m.cause, "value", str(m.cause)) == "delivery_settlement"
    ]
    assert len(movimientos) == 2, f"se esperaban el ingreso y su espejo; hay {len(movimientos)}"
    montos = sorted(m.amount for m in movimientos)
    assert montos[0] == montos[1] == settlement["amount"], (
        f"los dos movimientos valen {montos} y la venta liquidada {settlement['amount']}: "
        "la ida y la vuelta tienen que moverse por el mismo término"
    )
    clases = {getattr(m.kind, "value", str(m.kind)) for m in movimientos}
    assert clases == {"income", "expense"}, clases

    cuerpo = anulacion.json()
    assert cuerpo["status"] == "voided", cuerpo
    assert cuerpo["cash_movement_id"] is not None, (
        "el `CashMovement` del ingreso original tiene que quedar VIVO: nada financiero se borra"
    )
    assert cuerpo["void_cash_movement_id"] is not None, cuerpo

    pendiente = device_client.get(f"{API}/delivery-settlements/pending").json()
    assert pendiente["total"] == settlement["total"], (
        "al deshacer, los cobros vuelven a estar pendientes de liquidar por el mismo total "
        "(venta + propina: es lo que sostiene el domiciliario)"
    )


# ---------------------------------------------------------------------------
# 6. Donde la plata se ve de verdad: la brecha del arqueo, por canal
# ---------------------------------------------------------------------------


def test_the_same_cash_opens_the_same_arqueo_gap_whatever_channel_it_came_through(
    device_client: Any,
    admin_client: Any,
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
    """**El cierre de H-1 medido donde duele: el conteo a ciegas.**

    Para cada canal se mide la brecha que su plata abre en el arqueo:

        brecha = (efectivo que ENTRÓ físicamente al cajón) − (lo que subió el esperado)

    En mostrador el cliente paga venta + propina y el esperado sube por la
    venta: la brecha es la propina. En domicilio el domiciliario entrega venta
    + propina al liquidar y el esperado tiene que subir por la venta: la
    brecha tiene que ser **la misma propina**.

    En la ronda 1 no lo era: el `INCOME` entraba por venta + propina, la
    brecha del domicilio era 0 y la del mostrador la propina entera. Quien
    contaba a ciegas veía una diferencia que cambiaba según el canal y tenía
    que justificarla con causa tipada.

    El test termina cerrando el turno de verdad y comprobando que la
    diferencia del paso 2 es **exactamente la suma de las dos brechas**: una
    sola matemática, de punta a punta.
    """
    from tests.audit.conftest import OPENING_FIXED, denoms

    shift = open_shift()
    identify(device_client, employees["cashier"])
    enable_2c()

    propina = 10_000

    e0 = expected_of(shift["id"])
    mostrador = _sale(
        device_client, db, store, method="cash", tip=propina, channel="counter", name="K"
    )
    e1 = expected_of(shift["id"])
    efectivo_mostrador = mostrador["total"] + mostrador["tip"]
    brecha_mostrador = efectivo_mostrador - (e1 - e0)

    _sale(
        device_client,
        db,
        store,
        method="cash",
        tip=propina,
        channel="delivery",
        courier=courier,
        name="L",
    )
    liquidacion = device_client.post(
        f"{API}/delivery-settlements", json={"courier_employee_id": courier.id}, headers=idem_headers()
    )
    assert liquidacion.status_code in (200, 201), liquidacion.text
    settlement = liquidacion.json()
    e2 = expected_of(shift["id"])
    efectivo_domicilio = settlement["amount"] + settlement["tip_amount"]
    brecha_domicilio = efectivo_domicilio - (e2 - e1)

    assert brecha_mostrador == brecha_domicilio, (
        f"la misma propina de ${propina} abre una brecha de {brecha_mostrador} cuando entra por "
        f"mostrador y de {brecha_domicilio} cuando entra por domicilio. Es H-1: dos matemáticas del "
        "esperado para la misma plata, y la diferencia del arqueo a ciegas cambia según el canal "
        "(app/channels/service.py::settle_delivery_cash + app/shifts/hooks.py::get_sales_totals)"
    )
    assert brecha_mostrador == propina, (
        f"la brecha de mostrador es {brecha_mostrador} y la propina {propina}: cambió el trato "
        "heredado de la propina en efectivo, que NO entra al esperado y se salda por `tips_cash_out`"
    )

    # Y el arqueo real, con el efectivo físico que hay en el cajón.
    contado = OPENING_FIXED + efectivo_mostrador + efectivo_domicilio
    conteo = device_client.post(
        f"{API}/shifts/{shift['id']}/close/count",
        json={"counted_cash": denoms(contado), "tips_cash_out": 0, "photo": PHOTO},
        headers=idem_headers(),
    )
    assert conteo.status_code in (200, 201), conteo.text
    count_id = conteo.json()["count_id"]

    review = device_client.get(f"{API}/shifts/{shift['id']}/close/{count_id}/review")
    assert review.status_code == 200, review.text
    cuerpo = review.json()
    assert cuerpo["difference"] == brecha_mostrador + brecha_domicilio, (
        f"el paso 2 del cierre a ciegas acusa {cuerpo['difference']} y las brechas medidas suman "
        f"{brecha_mostrador + brecha_domicilio}: hay una tercera matemática en el camino del arqueo"
    )
    assert cuerpo["difference"] == 2 * propina, (
        f"la diferencia del arqueo es {cuerpo['difference']} y las dos propinas en efectivo del turno "
        f"suman {2 * propina}: con `tips_cash_out = 0` el sobrante del cajón ES la propina que todavía "
        "no se repartió, y tiene que ser la misma venga por el canal que venga"
    )


def test_a_settled_delivery_tip_becomes_payable_from_the_drawer(
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
    """**HALLAZGO H-8 (BLOQUEANTE).** Una vez que el domiciliario liquidó, su
    propina en efectivo **está en el cajón** — y `cash_out` no la deja salir.

    Medido corriendo, con una propina de mostrador de $10.000 y una de
    domicilio de $10.000:

        [LIQUIDACIÓN]  amount 105.000 + tip 10.000 = total 115.000  (todo al cajón)
        [ANTES]  cash_out = 10.000   delivery_cash = 10.000   pending = 10.000
        [DESPUÉS] cash_out = 10.000   delivery_cash = 10.000   pending = 0

    El `pending` baja a 0 —la plata llegó— y `cash_out` **no se mueve**. Pero
    `cash_out` es, por contrato publicado (`app/shifts/schemas.py:545-547`),
    «efectivo: sale del cajón al cierre», y `to_deposit` es
    `contado − base fija − tips_cash_out` (`app/shifts/service.py:1035`): si
    quien cierra le hace caso a `cash_out`, los $10.000 de propina del
    domiciliario **se consignan como venta** en vez de pagarse a la persona.
    Es pasivo con el personal (Ley 1935 de 2018).

    `app/shifts/hooks.py::payment_bucket` clasifica por `courier_employee_id`
    y **nunca** mira `delivery_settlement_id`; su propio docstring
    (`hooks.py:98-100`) dice que liquidado/pendiente «se deriva de
    `delivery_settlement_id`, aparte» — y nadie lo deriva. El docstring de
    `app/shifts/tips.py:58-60` promete que la propina de domicilio «no se
    puede pagar del cajón **hasta que entre**»; el código no la deja pagar
    nunca.

    **No es regresión del arreglo de H-1/H-2**: el bolsillo `delivery` excluía
    la propina de `tips_cash` desde la ronda 1. En la ronda 1 quedaba tapado
    porque `by_employee` la contaba igual (eso ERA H-2) y el reparto por
    persona ofrecía la plata; cerrada esa contradicción, el hueco queda a la
    vista y sin compensación.

    **Remedio (una decisión, después una línea)**: o `cash_out` suma las
    propinas de domicilio **ya liquidadas** (`tips_delivery − tips_delivery_pending`),
    o la liquidación deja de recibir la propina y el domiciliario se la queda
    —y entonces `DeliverySettlement.tip_amount` y el `total` de la pantalla
    tienen que dejar de decir que la entrega—. Lo que no puede quedar es que
    la plata entre al cajón y ninguna lectura autorice sacarla.
    **Dueño**: `backend-dinero-canales`.

    ---

    **RONDA 3.** El Maestro eligió la opción (a): `cash_out` suma la propina
    de domicilio ya liquidada, y el servidor PUBLICA esa cifra en
    `ShiftTipsOut.delivery_tips_settled` para que ningún cliente la derive
    restando. El cuerpo de este test se reexpresó contra ese contrato —el
    mismo escenario, los mismos $10.000 + $10.000— y quedó **más exigente**
    que en la ronda 2: la cifra se lee DEL CUERPO (si no está publicada,
    `KeyError` y el hallazgo sigue rojo), se exige que cierre con
    `delivery_tips − delivery_tips_pending`, y se mide en el mismo cuerpo
    que cerrar H-8 **no reabrió H-2**. El hallazgo conserva su número, su
    historia y su dueño.
    """
    shift = open_shift()
    identify(device_client, employees["cashier"])
    enable_2c()

    _sale(device_client, db, store, method="cash", tip=10_000, channel="counter", name="O1")
    _sale(
        device_client, db, store, method="cash", tip=10_000, channel="delivery", courier=courier, name="O2"
    )

    liquidacion = device_client.post(
        f"{API}/delivery-settlements", json={"courier_employee_id": courier.id}, headers=idem_headers()
    )
    assert liquidacion.status_code in (200, 201), liquidacion.text
    entregado = liquidacion.json()
    assert entregado["tip_amount"] == 10_000, entregado
    assert entregado["total"] == entregado["amount"] + entregado["tip_amount"], (
        "la liquidación dice que el domiciliario entrega venta + propina: esa propina está en el cajón"
    )

    cuerpo = admin_client.get(f"{API}/shifts/{shift['id']}/tips").json()

    # RONDA 3 — REEXPRESADO, NO ABLANDADO. El contrato que fijó el Maestro
    # al cerrar H-7 renombró las claves de ESTA respuesta
    # (`delivery_cash*` → `delivery_tips*`), así que la forma vieja de este
    # test explotaba por `KeyError` del renombre y no por el producto. El
    # hecho medido es el mismo —y más exigente en dos puntos—:
    #
    #   1. `delivery_tips_settled` se lee DEL CUERPO. No se deriva acá. Si
    #      el servidor no la publica, esto es `KeyError` y H-8 sigue rojo:
    #      que el cliente tenga que restar dos campos para saber cuánta
    #      plata puede sacar del cajón ES media matemática del lado del
    #      cliente, y la regla dura dice una sola y en el backend.
    #   2. Se exige además que esa cifra publicada CIERRE con las otras dos
    #      (`settled == tips − pending`), para que no pueda publicarse un
    #      número decorativo que no corresponda a nada.
    assert cuerpo["delivery_tips_pending"] == 0, (
        "después de liquidar no puede quedar propina de domicilio pendiente: "
        f"`delivery_tips_pending` = {cuerpo['delivery_tips_pending']}"
    )
    liquidada = cuerpo["delivery_tips_settled"]
    assert liquidada == cuerpo["delivery_tips"] - cuerpo["delivery_tips_pending"], (
        f"el servidor publica `delivery_tips_settled` = {liquidada} y sus propias cifras dicen "
        f"{cuerpo['delivery_tips']} − {cuerpo['delivery_tips_pending']} = "
        f"{cuerpo['delivery_tips'] - cuerpo['delivery_tips_pending']}: el campo nuevo no cierra con "
        "el resto del cuerpo, y entonces no sirve para autorizar un retiro del cajón"
    )
    assert liquidada == 10_000, (
        f"el domiciliario entregó $10.000 de propina y `delivery_tips_settled` dice {liquidada}"
    )
    assert cuerpo["cash_out"] == cuerpo["by_method"]["cash"] + liquidada, (
        f"`cash_out` = {cuerpo['cash_out']} y en el cajón hay {cuerpo['by_method']['cash']} de propina "
        f"de mostrador MÁS {liquidada} de propina de domicilio ya liquidada "
        f"(esperado {cuerpo['by_method']['cash'] + liquidada}). `cash_out` es lo que sale del cajón al "
        "cierre (app/shifts/schemas.py:545-547) y `to_deposit` resta exactamente eso "
        "(app/shifts/service.py:1035): la propina del domiciliario se consigna como venta en vez de "
        "pagarse a la persona (Ley 1935 de 2018). `payment_bucket` (app/shifts/hooks.py:74) nunca mira "
        "`delivery_settlement_id`, aunque su propio docstring diga que de ahí se deriva"
    )
    assert cuerpo["cash_out"] == 20_000, (
        f"las dos propinas en efectivo del turno son $10.000 de mostrador y $10.000 de domicilio ya "
        f"entregada: del cajón salen $20.000 y `cash_out` dice {cuerpo['cash_out']}"
    )
    # Y lo que NO puede pasar al cerrar H-8: mover la propina de domicilio a
    # `by_method.cash` reabriría H-2 (`by_method` dejaría de coincidir con
    # `by_employee`). Se mide acá mismo, en el mismo cuerpo.
    assert cuerpo["by_method"]["cash"] == 10_000, (
        f"`by_method.cash` = {cuerpo['by_method']['cash']}: `by_method` dice por qué MEDIO entró la "
        "propina, no cuánto se puede sacar del cajón. Meter ahí la de domicilio reabre H-2"
    )
    assert sum(fila["cash"] for fila in cuerpo["by_employee"]) == cuerpo["by_method"]["cash"], (
        "cerrar H-8 no puede reabrir H-2: `by_method.cash` y `sum(by_employee[*].cash)` tienen que "
        "seguir siendo el mismo número"
    )


def test_delivery_cash_pending_means_the_same_thing_in_every_response_that_publishes_it(
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
    """**HALLAZGO H-7 (ADVERTENCIA), nacido en la ronda 2.**

    El arreglo de H-2 agregó `delivery_cash_pending` a `ShiftTipsOut`
    (`app/shifts/schemas.py:555`) con un significado **distinto** del que ya
    tenía el mismo nombre en el desglose del turno
    (`BreakdownOut.delivery_cash_pending`, `app/shifts/schemas.py:178`, y
    `ShiftSummaryOut.delivery_cash_pending`, `:367`):

    - desglose del turno: **venta + propina** pendientes de liquidar
      (`app/shifts/service.py:269`);
    - `GET /shifts/{id}/tips`: **sólo la propina** pendiente
      (`app/shifts/tips.py:112`).

    Es el patrón de «conjunto publicado que el cliente duplica» en su forma
    más silenciosa: la misma clave, dos cantidades, y ningún typecheck que lo
    vea porque los dos son `int`. Quien lea `delivery_cash_pending` sin mirar
    de qué respuesta vino va a mostrar un número por otro.

    No es plata mal calculada —los dos números son correctos— así que es
    ADVERTENCIA, no bloqueante. **Remedio**: renombrar el de propinas a
    `delivery_tips_pending` (o el del desglose a `delivery_cash_pending_total`)
    antes de que alguien construya la pantalla. **Dueño**:
    `backend-dinero-canales`.

    ---

    **RONDA 3.** El remedio se aplicó por la primera vía, con el contrato
    que fijó el Maestro: en `ShiftTipsOut`, `delivery_cash` →
    `delivery_tips` y `delivery_cash_pending` → `delivery_tips_pending`; el
    desglose del turno (`GET /shifts/{id}` y `ShiftSummaryOut`) **conserva**
    `delivery_cash_pending` con su significado de siempre (venta + propina).
    El cuerpo de este test se reexpresó contra ese contrato. Medía una
    igualdad entre dos cantidades distintas —comparar los dos valores ya no
    tiene sentido, y compararlos sería ablandar el hallazgo a nada—; ahora
    afirma sobre las CLAVES del JSON (un servidor que publicara las dos a la
    vez sigue rojo), que el nombre nuevo vale SÓLO la propina, que el
    desglose no cambió de significado, y que el puente entre las dos
    lecturas cierra con dos números que en este escenario son distintos.
    Mismo escenario, mismos montos, mismo número de hallazgo.
    """
    shift = open_shift()
    identify(device_client, employees["cashier"])
    enable_2c()

    _sale(
        device_client, db, store, method="cash", tip=12_000, channel="delivery", courier=courier, name="N"
    )

    # RONDA 3 — REEXPRESADO, NO ABLANDADO. Mismo escenario y mismos montos.
    # El hallazgo era «el mismo nombre publicado con dos significados»; el
    # contrato que fijó el Maestro lo cierra renombrando el de propinas. El
    # test ya no puede medirlo comparando dos valores (compararía peras con
    # manzanas): ahora mide lo que el cierre exige, que es MÁS estricto —
    # afirma sobre las CLAVES del JSON, no sobre un valor, así que un
    # servidor que publicara las dos claves a la vez seguiría rojo.
    pendiente = device_client.get(f"{API}/delivery-settlements/pending")
    assert pendiente.status_code == 200, pendiente.text
    pend = pendiente.json()
    assert pend["tip_amount"] == 12_000, pend
    venta_pendiente = pend["amount"]
    assert venta_pendiente > 0, (
        f"el escenario necesita una VENTA de domicilio además de la propina para que los dos números "
        f"sean distintos; `amount` = {venta_pendiente}"
    )

    desglose = admin_client.get(f"{API}/shifts/{shift['id']}").json()
    propinas = admin_client.get(f"{API}/shifts/{shift['id']}/tips").json()

    # (a) La respuesta de PROPINAS ya no publica el nombre ambiguo. Sobre las
    #     claves, no sobre un valor.
    for ambigua in ("delivery_cash_pending", "delivery_cash"):
        assert ambigua not in propinas, (
            f"`GET /shifts/{{id}}/tips` todavía publica la clave `{ambigua}`, que en el desglose del "
            f"turno significa otra cosa (venta + propina). Claves publicadas: {sorted(propinas)}"
        )

    # (b) Publica el nombre nuevo, y vale SÓLO la propina.
    assert propinas["delivery_tips_pending"] == pend["tip_amount"], (
        f"`delivery_tips_pending` = {propinas['delivery_tips_pending']} y la propina que sostiene el "
        f"domiciliario es {pend['tip_amount']}: el renglón de propinas tiene que ser sólo propina"
    )

    # (c) El desglose del turno CONSERVA su clave y su significado de siempre.
    assert desglose["delivery_cash_pending"] == pend["total"], (
        f"`GET /shifts/{{id}}` dice {desglose['delivery_cash_pending']} y lo que sostiene el "
        f"domiciliario es {pend['total']} (venta + propina): el renombre del renglón de propinas no "
        "puede haberle cambiado el significado al desglose"
    )

    # (d) El puente entre las dos lecturas CIERRA, y con dos números que son
    #     distintos — que es lo que hacía peligroso al nombre repetido.
    assert (
        desglose["delivery_cash_pending"] - propinas["delivery_tips_pending"] == venta_pendiente
    ), (
        f"el desglose ({desglose['delivery_cash_pending']}) menos la propina pendiente "
        f"({propinas['delivery_tips_pending']}) tiene que dar la VENTA pendiente ({venta_pendiente}): "
        "si no cierra, las dos respuestas están contando plata distinta"
    )
    assert desglose["delivery_cash_pending"] != propinas["delivery_tips_pending"], (
        "los dos números son distintos a propósito en este escenario; si fueran iguales el test no "
        "estaría midiendo la ambigüedad que H-7 denunció"
    )


def test_a_platform_sale_still_does_not_move_the_expected_after_the_round_2_fix(
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
    """Regresión de la ronda 2 sobre el renglón #2, que era el que ya estaba
    verde: tocar el clasificador de bolsillos es tocar el camino por el que la
    venta de plataforma se mantiene FUERA del cajón. Se vuelve a medir."""
    shift = open_shift()
    identify(device_client, employees["cashier"])
    enable_2c()

    antes = expected_of(shift["id"])
    _sale(
        device_client,
        db,
        store,
        method="platform",
        tip=0,
        channel="platform",
        platform=platform,
        name="M",
    )
    despues = expected_of(shift["id"])
    assert despues == antes, (
        f"una venta cobrada por plataforma movió el esperado de {antes} a {despues}: es una cuenta "
        "por cobrar, no plata en el cajón (checklist #2)"
    )

    resumen = admin_client.get(f"{API}/shifts/{shift['id']}").json()
    assert resumen["sales"]["cash"] == 0, resumen["sales"]
    assert resumen["sales"]["other"] > 0, resumen["sales"]


# ---------------------------------------------------------------------------
# 8. RONDA 3 — la MITAD DE VUELTA del cierre de H-8
#
# El arreglo de H-8 hizo que `cash_out` crezca cuando el domiciliario liquida.
# Los cinco hallazgos de cruce de 2b fueron, los cinco, «la mitad de ida
# construida sin la mitad de vuelta», así que la pregunta obligatoria es:
# ¿qué pasa cuando la liquidación se DESHACE? La plata sale del cajón por el
# movimiento espejo; si `cash_out` no baja con ella, el sistema autoriza a
# sacar del cajón una propina que ya no está — y eso es un faltante fabricado,
# exactamente el defecto que H-1 de 2b denunció en la otra dirección.
# ---------------------------------------------------------------------------


def test_voiding_a_settlement_takes_the_delivery_tip_back_out_of_cash_out(
    device_client: Any,
    admin_client: Any,
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
    """Liquidar → deshacer → `cash_out` vuelve **exactamente** a donde estaba.

    Nace en la ronda 3 y no existía antes porque antes `cash_out` no se movía
    nunca con la liquidación. Mide la mitad de vuelta del cierre de H-8:

        antes de liquidar   cash_out == propina de mostrador
        después de liquidar cash_out == mostrador + domicilio liquidada
        después de anular   cash_out == propina de mostrador   (otra vez)

    y lo mismo, renglón por renglón, para `delivery_tips_settled` y
    `delivery_tips_pending`. Si el `void` no devuelve los pagos a
    `delivery_settlement_id = NULL`, la propina queda contada como «ya está en
    el cajón» cuando el movimiento espejo acaba de sacarla: el cierre
    autorizaría un retiro contra plata que no está.
    """
    shift = open_shift()
    identify(device_client, employees["cashier"])
    enable_2c()

    _sale(device_client, db, store, method="cash", tip=10_000, channel="counter", name="V1")
    _sale(
        device_client, db, store, method="cash", tip=10_000, channel="delivery", courier=courier, name="V2"
    )

    def propinas() -> dict[str, Any]:
        resp = admin_client.get(f"{API}/shifts/{shift['id']}/tips")
        assert resp.status_code == 200, resp.text
        return dict(resp.json())

    esperado_antes = expected_of(shift["id"])
    antes = propinas()
    assert antes["cash_out"] == 10_000, antes
    assert antes["delivery_tips_settled"] == 0, antes
    assert antes["delivery_tips_pending"] == 10_000, antes

    liquidacion = device_client.post(
        f"{API}/delivery-settlements", json={"courier_employee_id": courier.id}, headers=idem_headers()
    )
    assert liquidacion.status_code in (200, 201), liquidacion.text
    settlement = liquidacion.json()

    durante = propinas()
    assert durante["cash_out"] == 20_000, (
        f"después de liquidar, `cash_out` tiene que incluir la propina entregada: {durante}"
    )
    assert durante["delivery_tips_settled"] == 10_000, durante
    assert durante["delivery_tips_pending"] == 0, durante

    anulacion = device_client.post(
        f"{API}/delivery-settlements/{settlement['id']}/void",
        json={"reason": "El domiciliario entregó de menos"},
        headers=idem_headers(),
    )
    assert anulacion.status_code in (200, 201), anulacion.text

    esperado_despues = expected_of(shift["id"])
    despues = propinas()
    assert despues["delivery_tips_pending"] == 10_000, (
        f"anular la liquidación devuelve la propina a PENDIENTE (el domiciliario la tiene otra vez): "
        f"`delivery_tips_pending` = {despues['delivery_tips_pending']}. Si se queda en 0, "
        "`delivery_settlement_id` no volvió a NULL en los pagos (app/channels/service.py:608-612)"
    )
    assert despues["delivery_tips_settled"] == 0, (
        f"`delivery_tips_settled` = {despues['delivery_tips_settled']} después de anular: el "
        "movimiento espejo sacó esa plata del cajón, así que ya no está liquidada"
    )
    assert despues["cash_out"] == antes["cash_out"], (
        f"liquidar y deshacer dejó `cash_out` en {despues['cash_out']} cuando antes era "
        f"{antes['cash_out']}. La ida lo subió {durante['cash_out'] - antes['cash_out']} y la vuelta "
        f"lo bajó {durante['cash_out'] - despues['cash_out']}: el cierre estaría autorizando a sacar "
        "del cajón una propina que el movimiento espejo ya se llevó — un faltante fabricado"
    )
    assert despues["cash_out"] == despues["by_method"]["cash"] + despues["delivery_tips_settled"], (
        "la identidad publicada del esquema tiene que seguir cerrando después de anular"
    )
    # Y la mitad de vuelta del ESPERADO, en el mismo escenario: `cash_out` es
    # una lectura de consejo, pero el esperado es el número contra el que se
    # cuenta a ciegas. Los dos tienen que volver, y volver juntos.
    assert esperado_despues == esperado_antes, (
        f"liquidar y deshacer dejó el esperado en {esperado_despues} cuando antes era "
        f"{esperado_antes}: el movimiento espejo no compensó la ida"
    )
