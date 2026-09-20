"""`GET /shifts/{id}/tips` responde la misma pregunta UNA vez.

Ronda 2 del pedido 2c — cierre del **hallazgo H-2 (bloqueante)** del auditor.

El hallazgo era que el MISMO cuerpo de la respuesta contaba la propina en
efectivo con dos fórmulas distintas:

- `by_method.cash` y `cash_out` salían de `hooks.get_sales_totals().tips_cash`,
  que desde 2c **excluye** la propina en efectivo de un domicilio (la tiene el
  domiciliario, no el cajón);
- `by_employee[*].cash` se recalculaba **aparte**, en `app/shifts/tips.py`,
  releyendo `Payment` sin esa exclusión.

Con $10.000 de propina de mostrador y $10.000 de domicilio, el mismo JSON
decía `by_method.cash = 10.000` y `sum(by_employee[*].cash) = 20.000`. Es
propina de un empleado (Ley 1935 de 2018, pasivo con el personal): el reparto
por persona ofrecía plata que `cash_out` no autoriza a sacar del cajón. Es
**H-4 de 2b en su forma exacta** —la misma pregunta con dos fórmulas— ahora
dentro de una sola respuesta.

El cierre: **una sola función decide el bolsillo de un `Payment`**,
`app.shifts.hooks.payment_bucket`, y los dos lados la llaman. Y para que la
propina de domicilio no DESAPAREZCA de la pantalla al dejar de contarse en
`.cash`, se publica en su propio renglón, aditivo.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.catalog.models import Product
from app.shifts.hooks import payment_bucket
from app.stores.models import Store
from tests.channels.test_expected_cash_parity import (
    PROPINA,
    VENTA,
    _counter_sale,
    _delivery_sale,
    _settle,
)


def _tips(admin_client: Any, shift_id: int) -> dict[str, Any]:
    resp = admin_client.get(f"/api/v1/shifts/{shift_id}/tips")
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] = resp.json()
    return body


def test_the_shift_tips_reading_counts_the_same_cash_tip_once(
    device_client: Any,
    admin_client: Any,
    identify: Any,
    employees: dict,
    open_shift: Any,
    channels_on: None,
    delivery_fee_product: Product,
    db: Session,
    store: Store,
) -> None:
    """**Cierre de H-2.** Billete por billete, en los cuatro bolsillos:

        by_method.X == sum(by_employee[*].X)

    y la identidad que publica el servidor (ronda 3, H-8):

        cash_out == by_method.cash + delivery_tips_settled

    Acá nadie liquidó todavía, así que `delivery_tips_settled == 0` y
    `cash_out` es exactamente la propina de mostrador. La propina de
    domicilio no está en ninguno de los dos lados de `cash`: está en su
    propio renglón.
    """
    shift = open_shift()
    identify(device_client, employees["cashier"])

    _counter_sale(device_client, db, store, tip=PROPINA)
    _delivery_sale(device_client, db, store, employees, tip=PROPINA)

    cuerpo = _tips(admin_client, shift["id"])

    for bolsillo in ("cash", "card", "transfer", "other"):
        por_metodo = cuerpo["by_method"][bolsillo]
        por_empleado = sum(fila[bolsillo] for fila in cuerpo["by_employee"])
        assert por_metodo == por_empleado, (
            f"el mismo cuerpo de `GET /shifts/{{id}}/tips` cuenta la propina `{bolsillo}` de dos "
            f"maneras: `by_method.{bolsillo}` = {por_metodo} y la suma de `by_employee[*].{bolsillo}` "
            f"= {por_empleado}. Los dos lados tienen que salir de `hooks.payment_bucket`"
        )

    assert cuerpo["delivery_tips_settled"] == 0, (
        "nadie liquidó todavía: no puede haber propina de domicilio liquidada"
    )
    assert cuerpo["cash_out"] == cuerpo["by_method"]["cash"] + cuerpo["delivery_tips_settled"], (
        f"`cash_out` ({cuerpo['cash_out']}) tiene que ser `by_method.cash` "
        f"({cuerpo['by_method']['cash']}) + `delivery_tips_settled` "
        f"({cuerpo['delivery_tips_settled']}): es la identidad publicada del esquema"
    )
    assert cuerpo["cash_out"] == sum(fila["cash"] for fila in cuerpo["by_employee"]), (
        f"`cash_out` ({cuerpo['cash_out']}) no alcanza para pagar lo que el reparto por empleado "
        f"declara ({sum(fila['cash'] for fila in cuerpo['by_employee'])})"
    )
    assert cuerpo["cash_out"] == PROPINA, (
        f"sin liquidar, del cajón sale SÓLO la propina de mostrador ({PROPINA}); la del domicilio "
        f"la tiene el domiciliario. `cash_out` = {cuerpo['cash_out']}"
    )


def test_the_delivery_cash_tip_is_published_in_its_own_row_and_never_disappears(
    device_client: Any,
    admin_client: Any,
    identify: Any,
    employees: dict,
    open_shift: Any,
    channels_on: None,
    delivery_fee_product: Product,
    db: Session,
    store: Store,
) -> None:
    """La propina en efectivo de un domicilio sale de `cash` pero **no
    desaparece**: se ve por persona (`delivery`) y en el cuerpo
    (`delivery_tips` / `delivery_tips_pending` / `delivery_tips_settled`).

    **Ronda 3, cierre de H-8.** Este test afirmaba antes que después de
    liquidar `cash_out` seguía siendo sólo la propina de mostrador. Era el
    contrario exacto de lo que pasa físicamente: el domiciliario entrega
    venta **+ propina** (`DeliverySettlement.tip_amount`), así que una vez
    liquidada esa propina ESTÁ en el cajón, y la lectura que autoriza
    sacarla tiene que decirlo — si no, `to_deposit` la manda a consignar
    como si fuera venta y la propina de una persona termina en el banco
    (Ley 1935 de 2018). Ahora, después de liquidar:

        cash_out == propina de mostrador + propina de domicilio liquidada

    y `by_method.cash` **se queda en la de mostrador**, porque `by_method`
    dice por qué medio entró la propina y tiene que seguir cumpliendo
    `by_method.cash == sum(by_employee[*].cash)` — meter la de domicilio ahí
    reabriría H-2.
    """
    shift = open_shift()
    identify(device_client, employees["cashier"])

    _counter_sale(device_client, db, store, tip=PROPINA)
    _delivery_sale(device_client, db, store, employees, tip=PROPINA)

    cuerpo = _tips(admin_client, shift["id"])
    # Los números impresos, a propósito: son los mismos que mira el
    # invariante H-8 del auditor (mostrador 10.000 + domicilio 10.000), y
    # son lo que hay que pegar en el entregable. Un renglón del checklist
    # que pasa sin ver las cifras no convence a nadie.
    print(
        "[propinas ANTES de liquidar] by_method.cash=%s cash_out=%s delivery_tips=%s "
        "delivery_tips_pending=%s delivery_tips_settled=%s"
        % (
            cuerpo["by_method"]["cash"],
            cuerpo["cash_out"],
            cuerpo["delivery_tips"],
            cuerpo["delivery_tips_pending"],
            cuerpo["delivery_tips_settled"],
        )
    )
    assert cuerpo["delivery_tips"] == PROPINA, (
        f"la propina en efectivo del domicilio ({PROPINA}) desapareció del cuerpo: "
        f"`delivery_tips` = {cuerpo['delivery_tips']}"
    )
    assert cuerpo["delivery_tips_pending"] == PROPINA, (
        "mientras el domiciliario no liquida, su propina está PENDIENTE: "
        f"`delivery_tips_pending` = {cuerpo['delivery_tips_pending']}"
    )
    assert cuerpo["delivery_tips_settled"] == 0, (
        "todavía no liquidó: nada de esa propina está en el cajón"
    )
    assert cuerpo["cash_out"] == PROPINA, (
        f"antes de liquidar, `cash_out` es sólo la propina de mostrador ({PROPINA}); "
        f"vale {cuerpo['cash_out']}"
    )
    assert sum(fila["delivery"] for fila in cuerpo["by_employee"]) == PROPINA, (
        "la propina de domicilio tiene que verse también por persona"
    )
    # El total por persona no pierde plata: cash + card + transfer + other + delivery.
    for fila in cuerpo["by_employee"]:
        assert fila["total"] == fila["cash"] + fila["card"] + fila["transfer"] + fila["other"] + fila["delivery"], (
            f"el total de {fila['employee_name']} ({fila['total']}) no cierra con sus renglones"
        )
    total_por_persona = sum(fila["total"] for fila in cuerpo["by_employee"])
    assert total_por_persona == PROPINA * 2, (
        f"las dos propinas de {PROPINA} tienen que seguir viéndose: el reparto por persona suma "
        f"{total_por_persona}"
    )

    _settle(device_client, employees)
    despues = _tips(admin_client, shift["id"])
    print(
        "[propinas DESPUES de liquidar] by_method.cash=%s cash_out=%s delivery_tips=%s "
        "delivery_tips_pending=%s delivery_tips_settled=%s"
        % (
            despues["by_method"]["cash"],
            despues["cash_out"],
            despues["delivery_tips"],
            despues["delivery_tips_pending"],
            despues["delivery_tips_settled"],
        )
    )
    assert despues["delivery_tips"] == PROPINA
    assert despues["delivery_tips_pending"] == 0, "ya la entregó: deja de estar pendiente"
    assert despues["delivery_tips_settled"] == PROPINA, (
        "el servidor publica la propina de domicilio ya liquidada; nadie la deriva restando "
        f"del lado del cliente. `delivery_tips_settled` = {despues['delivery_tips_settled']}"
    )
    assert despues["by_method"]["cash"] == PROPINA, (
        "liquidar NO mueve la propina a `by_method.cash`: `by_method` dice por qué medio entró "
        "la propina, y tiene que seguir cumpliendo `by_method.cash == sum(by_employee[*].cash)` "
        "(H-2). Lo que cambia es `cash_out`, que es otra pregunta"
    )
    assert sum(fila["cash"] for fila in despues["by_employee"]) == despues["by_method"]["cash"], (
        "liquidar no puede separar `by_method` de `by_employee`: sería H-2 otra vez"
    )
    assert despues["cash_out"] == PROPINA * 2, (
        f"después de liquidar, del cajón salen las DOS propinas: la de mostrador ({PROPINA}) y la "
        f"de domicilio ya entregada ({PROPINA}). `cash_out` = {despues['cash_out']}"
    )
    assert despues["cash_out"] == despues["by_method"]["cash"] + despues["delivery_tips_settled"], (
        "la identidad publicada del esquema: `cash_out == by_method.cash + delivery_tips_settled`"
    )


def test_payment_bucket_is_the_single_place_that_decides_the_pocket() -> None:
    """La función, mirada sola. `platform`/`voucher`/`other` colapsan en
    `other` (cuentas por cobrar, no plata en el cajón); el efectivo con
    domiciliario es `delivery`; un medio desconocido cae en `other` antes
    que romper el esperado del turno con un `KeyError`."""
    assert payment_bucket("cash", None) == "cash"
    assert payment_bucket("card", None) == "card"
    assert payment_bucket("transfer", None) == "transfer"
    for medio in ("platform", "voucher", "other"):
        assert payment_bucket(medio, None) == "other", f"`{medio}` no entra al cajón"
    assert payment_bucket("cash", 7) == "delivery", "efectivo que tiene el domiciliario"
    # Un domiciliario en un cobro que no es efectivo no cambia el bolsillo:
    # sólo el efectivo se arquea aparte.
    assert payment_bucket("card", 7) == "card"
    assert payment_bucket("transfer", 7) == "transfer"
    assert payment_bucket("platform", 7) == "other"
    assert payment_bucket("medio_que_no_existe", None) == "other"


def test_tips_by_employee_and_by_method_agree_with_no_delivery_at_all(
    device_client: Any,
    admin_client: Any,
    identify: Any,
    employees: dict,
    open_shift: Any,
    channels_on: None,
    delivery_fee_product: Product,
    db: Session,
    store: Store,
) -> None:
    """El refactor es refactor: sin un solo domicilio, el cuerpo da
    exactamente lo mismo que daba en 1b, y los renglones nuevos son `0`
    (no `null`: acá `0` SÍ quiere decir «no hubo»)."""
    shift = open_shift()
    identify(device_client, employees["cashier"])
    _counter_sale(device_client, db, store, tip=PROPINA)

    cuerpo = _tips(admin_client, shift["id"])
    assert cuerpo["by_method"] == {"cash": PROPINA, "card": 0, "transfer": 0, "other": 0}
    assert cuerpo["cash_out"] == PROPINA
    assert cuerpo["electronic_liability"] == 0
    assert cuerpo["delivery_tips"] == 0
    assert cuerpo["delivery_tips_pending"] == 0
    assert cuerpo["delivery_tips_settled"] == 0
    assert sum(fila["cash"] for fila in cuerpo["by_employee"]) == PROPINA
    assert sum(fila["delivery"] for fila in cuerpo["by_employee"]) == 0
    assert VENTA == 100_000  # el número del contrato, por si alguien lo mueve
