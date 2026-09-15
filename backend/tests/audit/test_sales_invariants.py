"""Invariantes de plata de la venta — cada test es un enunciado de regla.

Auditor del pedido 1b-1 (rol Contador + Legal). Esto no prueba "que el cobro
responda": prueba que **la plata cierre**, que la propina no se disfrace de
venta, que el consumo de personal no infle las ventas y que anular lo enviado
no fabrique inventario. Las reglas salen de `docs/SPEC-NEGOCIO.md §3.3, §3.4,
§6.2, §8.2, §11`, del contrato de API de `features/fase-1b-venta/spec.md` y de
`features/fase-1b-venta/CONTRATO-INTERNO-1b-1.md §5.1–5.3, §5.5–5.7`; ninguna
sale de leer la implementación.

Convención: el nombre del test dice la regla, el docstring la cita.
"""

from __future__ import annotations

import random
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select

from app.orders.money import LineInput, compute_totals
from tests.audit.conftest import (
    NO_TIP,
    add_items,
    create_order,
    get_order,
    idem_headers,
    pay,
)

API = "/api/v1"

# Semilla fija: un invariante que sólo falla un martes no es un invariante.
SEED = 20260915
SAMPLE_ORDERS = 1_000


# ---------------------------------------------------------------------------
# Helpers de lectura (ninguno calcula plata: sólo suma lo que el backend dijo
# para comprobar que sus propias partes cierran entre sí)
# ---------------------------------------------------------------------------


def _assert_totals_close(payload: dict[str, Any], *, where: str) -> None:
    """Las cuatro identidades del contrato §5.1 sobre cualquier documento de
    plata que traiga `lines` + totales (`OrderOut.totals` con sus ítems,
    `PreBillOut`, `DocumentPrintableOut`)."""
    totals = payload.get("totals", payload)
    lines = payload["lines"] if "lines" in payload else payload["items"]
    vivos = [line for line in lines if line.get("status") not in ("voided",)]

    assert sum(line["net"] for line in vivos) == totals["total"], (
        f"{where}: Σ líneas.net ≠ total (la venta no cierra)"
    )
    assert sum(line["discount"] for line in vivos) == totals["discount_total"], (
        f"{where}: Σ descuentos de línea ≠ discount_total"
    )
    assert sum(line["gross"] for line in vivos) == totals["subtotal"], (
        f"{where}: Σ brutos ≠ subtotal"
    )
    assert sum(t["tax"] for t in totals["tax_lines"]) == totals["tax_total"], (
        f"{where}: Σ tax_lines.tax ≠ tax_total"
    )
    for line in vivos:
        assert line["discount"] <= line["gross"], (
            f"{where}: la línea {line} tiene más descuento que bruto"
        )


def _shift_view(admin_client: Any, shift_id: int) -> dict[str, Any]:
    """El turno visto por el administrador: con `cash.blind_close` encendida
    (default del perfil `full`) es el único actor que ve `sales`/`tips`."""
    resp = admin_client.get(f"{API}/shifts/{shift_id}")
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] = resp.json()
    return body


# ---------------------------------------------------------------------------
# (a) La identidad de la venta sobre 1.000 comandas aleatorias (§5.1)
# ---------------------------------------------------------------------------


def _expected_order_discount(
    subtotal: int, sum_item_discount: int, order_discounts: list[tuple[str, int]]
) -> int:
    """Re-deriva el total de descuentos de comanda **desde el enunciado de la
    regla** (`CONTRATO-INTERNO-1b-1.md §2.3` y `SPEC-NEGOCIO §3.4`), no desde
    el código: cada descuento se calcula sobre lo que queda después de los
    descuentos de línea y de los descuentos de comanda anteriores, tope en esa
    base, `percent` con redondeo half-up."""
    remaining = subtotal - sum_item_discount
    applied = 0
    for kind, value in order_discounts:
        amount = (remaining * value + 50) // 100 if kind == "percent" else value
        amount = min(amount, remaining)
        applied += amount
        remaining -= amount
    return applied


def _random_order(rng: random.Random) -> tuple[list[LineInput], list[tuple[str, int]]]:
    """Una comanda plausible: entre 1 y 8 líneas, precios reales en pesos,
    las tres tarifas del país, cortesías (bruto 0), combos (sin descuento de
    línea, §3.4) y descuentos de línea y de comanda."""
    n = rng.randint(1, 8)
    lines: list[LineInput] = []
    for item_id in range(1, n + 1):
        is_courtesy = rng.random() < 0.12
        is_combo = rng.random() < 0.15
        qty = rng.randint(1, 4)
        unit = rng.choice([3_500, 4_000, 6_900, 8_500, 12_000, 18_000, 25_000, 43_900, 61_000])
        gross = 0 if is_courtesy else unit * qty
        # Los combos no aceptan descuento de línea (§3.4); una cortesía no
        # tiene nada que descontar.
        if is_combo or is_courtesy or rng.random() < 0.6:
            item_discount = 0
        else:
            item_discount = min(gross, rng.randint(1, max(1, gross // 2)))
        lines.append(
            LineInput(
                item_id=item_id,
                gross=gross,
                tax_rate=rng.choice([8, 8, 8, 19, 0]),
                item_discount=item_discount,
                is_combo=is_combo,
                # `price_includes_tax` es de la configuración fiscal de la
                # sede, igual para toda la comanda.
                price_includes_tax=True,
            )
        )

    includes_tax = rng.random() < 0.8
    lines = [
        LineInput(
            item_id=line.item_id,
            gross=line.gross,
            tax_rate=line.tax_rate,
            item_discount=line.item_discount,
            is_combo=line.is_combo,
            price_includes_tax=includes_tax,
        )
        for line in lines
    ]

    order_discounts: list[tuple[str, int]] = []
    for _ in range(rng.choice([0, 0, 0, 1, 1, 2])):
        if rng.random() < 0.6:
            order_discounts.append(("percent", rng.randint(1, 30)))
        else:
            order_discounts.append(("amount", rng.randint(500, 40_000)))
    return lines, order_discounts


def test_the_money_identities_hold_on_a_thousand_random_orders() -> None:
    """`CONTRATO-INTERNO-1b-1.md §5.1` y el checklist de
    `features/fase-1b-venta/spec.md`: «Invariante de redondeo Σ líneas = total
    y prorrateo de descuento sin perder un peso, sobre 1.000 comandas
    aleatorias (test de propiedad)».

    Cinco identidades, todas sobre `app.orders.money.compute_totals`, que es
    **la única matemática de la venta** (§6.1 del contrato: el frontend no
    calcula y `backend-cobro` no reimplementa):

    1. Σ `lines.net` == `total` — si no cierra, el documento miente.
    2. Σ prorrateo == descuento de comanda aplicado — el prorrateo no puede
       perder ni fabricar un peso (§3.4: «residuo en la línea mayor»).
    3. Σ `tax_lines.tax` == `tax_total` — la DIAN lee esta tabla (§8.2).
    4. `tip_base` == `total` − `tax_total` — la propina se calcula sobre el
       neto sin impuesto (§3.4, Ley 1935 de 2018).
    5. Ningún descuento supera el bruto de su línea (§3.4) y ningún `net`
       queda negativo.

    Sin `hypothesis` (nadie instala nada en este pedido): `random.Random` con
    semilla fija, que además hace el fallo reproducible con el índice.
    """
    rng = random.Random(SEED)

    for case in range(SAMPLE_ORDERS):
        lines, order_discounts = _random_order(rng)
        totals = compute_totals(lines, order_discounts)
        ctx = f"caso {case} (semilla {SEED}): lines={lines} order_discounts={order_discounts}"

        assert sum(line.net for line in totals.lines) == totals.total, f"Σ net ≠ total — {ctx}"

        sum_item_discount = sum(line.item_discount for line in lines)
        prorated = sum(lt.discount for lt in totals.lines) - sum_item_discount
        expected = _expected_order_discount(totals.subtotal, sum_item_discount, order_discounts)
        assert prorated == expected, f"el prorrateo perdió o fabricó pesos — {ctx}"
        assert totals.discount_total == sum_item_discount + expected, (
            f"discount_total ≠ descuentos de línea + de comanda — {ctx}"
        )

        assert sum(t.tax for t in totals.tax_lines) == totals.tax_total, (
            f"Σ tax_lines.tax ≠ tax_total — {ctx}"
        )
        assert sum(t.base for t in totals.tax_lines) == sum(lt.base for lt in totals.lines), (
            f"Σ tax_lines.base ≠ Σ líneas.base — {ctx}"
        )
        assert totals.tip_base == totals.total - totals.tax_total, (
            f"tip_base ≠ total − impuesto — {ctx}"
        )

        for lt in totals.lines:
            assert lt.discount <= lt.gross, f"descuento mayor que el bruto de la línea — {ctx}"
            assert lt.net >= 0, f"una línea quedó en negativo — {ctx}"
            assert lt.base + lt.tax == lt.net, f"base + impuesto ≠ net de la línea — {ctx}"
            assert lt.tax >= 0 and lt.base >= 0, f"impuesto o base negativos — {ctx}"


def test_prorating_never_loses_a_peso_even_on_the_hardest_remainders() -> None:
    """La misma regla en el punto donde el redondeo duele: `prorate` reparte
    montos que no son divisibles entre pesos de líneas iguales. Σ siempre es
    el monto y el residuo cae en la línea mayor (primer máximo), como manda
    `CONTRATO-INTERNO-1b-1.md §2.3`."""
    from app.orders.money import prorate

    rng = random.Random(SEED + 1)
    for _ in range(500):
        amount = rng.randint(0, 200_000)
        weights = [rng.choice([0, 1_000, 3_333, 7_777, 25_000]) for _ in range(rng.randint(1, 6))]
        shares = prorate(amount, weights)
        if sum(weights) == 0:
            assert shares == [0] * len(weights)
            continue
        assert sum(shares) == amount, f"prorate perdió pesos: {amount} entre {weights} → {shares}"
        for weight, share in zip(weights, shares):
            if weight == 0:
                assert share == 0, "un peso 0 no puede recibir parte del descuento"


# ---------------------------------------------------------------------------
# (b) La misma identidad, de punta a punta por la API (§5.1, §6.1)
# ---------------------------------------------------------------------------


def test_the_same_identity_holds_in_the_order_the_prebill_and_the_document(
    device_client: Any, open_shift: Any, sales_products: Any
) -> None:
    """Una comanda con dos tarifas (INC 8 % e IVA 19 %), una línea excluida y
    un descuento de comanda: la identidad de §5.1 tiene que valer **en las
    tres representaciones** que ve el cliente (`OrderOut.totals`, la precuenta
    y el documento) y las tres tienen que decir exactamente lo mismo.

    Tres números distintos en tres pantallas para la misma comanda es el
    reclamo que ningún restaurante puede responder: si la precuenta dice
    $83.700 y el documento $83.690, el que pierde es el negocio o el cliente,
    nunca el software.
    """
    open_shift()
    order = create_order(device_client, channel="counter").json()
    order = add_items(
        device_client,
        order,
        [
            {"product_id": sales_products["inc8"].id, "qty": 2},
            {"product_id": sales_products["iva19"].id, "qty": 3},
            {"product_id": sales_products["excluded"].id, "qty": 1},
        ],
    ).json()

    descuento = device_client.post(
        f"{API}/orders/{order['id']}/discounts",
        json={
            "expected_version": order["version"],
            "scope": "order",
            "kind": "percent",
            "value": 7,
            "reason": "promo",
        },
    )
    assert descuento.status_code == 200, descuento.text
    order = descuento.json()

    _assert_totals_close(order, where="OrderOut")
    totals = order["totals"]
    assert {t["rate"] for t in totals["tax_lines"]} == {0, 8, 19}, (
        "las tres tarifas tienen que aparecer discriminadas (§8.2)"
    )
    assert order["tip"]["base"] == totals["total"] - totals["tax_total"], (
        "la base de la propina es el neto sin impuesto (§3.4)"
    )

    precuenta = device_client.post(
        f"{API}/orders/{order['id']}/bill/present",
        json={"expected_version": order["version"]},
        headers=idem_headers(),
    )
    assert precuenta.status_code == 200, precuenta.text
    bill = precuenta.json()
    assert bill["legend"] == "NO ES FACTURA — documento informativo", (
        "la precuenta lleva la leyenda de §3.3 (la SIC reprochó las «prefacturas»)"
    )
    assert "number" not in bill and "prefix" not in bill, "la precuenta no tiene consecutivo"
    for campo in ("subtotal", "discount_total", "tax_total", "total"):
        assert bill[campo] == totals[campo], f"la precuenta cambió {campo} respecto de la comanda"
    assert bill["tax_lines"] == totals["tax_lines"]
    assert sum(line["net"] for line in bill["lines"]) == bill["total"], (
        "la precuenta tiene que cerrar sola: es lo que el cliente mira antes de pagar"
    )

    order = get_order(device_client, order["id"])
    cobro = pay(
        device_client,
        order["id"],
        splits=[{"method": "cash", "amount": totals["total"], "tendered": totals["total"]}],
        tip=NO_TIP,
    )
    assert cobro.status_code == 201, cobro.text
    documento = device_client.get(f"{API}/documents/{cobro.json()['document']['id']}")
    assert documento.status_code == 200, documento.text
    doc = documento.json()

    _assert_totals_close(doc, where="DocumentPrintableOut")
    for campo in ("subtotal", "discount_total", "tax_total", "total"):
        assert doc[campo] == totals[campo], f"el documento cambió {campo} respecto de la precuenta"
    assert doc["tax_lines"] == totals["tax_lines"]


# ---------------------------------------------------------------------------
# (c) La propina nunca es venta (§5.3, SPEC §3.4 y §6.2, Ley 1935 de 2018)
# ---------------------------------------------------------------------------


def test_the_tip_never_enters_the_sale_the_tax_or_the_shift_sales(
    device_client: Any, admin_client: Any, open_shift: Any, sales_products: Any
) -> None:
    """§3.4 y §6.2: la propina «va separada de la venta: no es ingreso, no
    causa impuesto, no entra en ventas netas ni en margen, y se reporta por
    turno, por persona y por medio de pago».

    Se mira en los dos lugares donde podría colarse: el documento (si sumara
    al total, el cliente pagaría impuesto sobre la propina, que es ilegal) y
    los totales del turno (si sumara a `sales`, el esperado de caja mandaría
    a la persona a responder por plata que no es del negocio, y el reporte
    bimestral declararía base de más).
    """
    turno = open_shift()
    order = create_order(device_client, channel="counter").json()
    order = add_items(
        device_client, order, [{"product_id": sales_products["inc8"].id, "qty": 2}]
    ).json()

    totales_antes = order["totals"]
    propina = 6_000
    venta = totales_antes["total"]

    cobro = pay(
        device_client,
        order["id"],
        splits=[
            {"method": "cash", "amount": venta},
            {"method": "card", "amount": propina},
        ],
        tip={"asked": True, "accepted": True, "modified": True, "amount": propina},
    )
    assert cobro.status_code == 201, cobro.text
    assert cobro.json()["tip_amount"] == propina
    assert cobro.json()["total"] == venta, "«total» del cobro es la venta, sin propina"

    doc = device_client.get(f"{API}/documents/{cobro.json()['document']['id']}").json()
    assert doc["total"] == venta, "la propina no entra en el total del documento"
    assert doc["subtotal"] == totales_antes["subtotal"]
    assert doc["tax_total"] == totales_antes["tax_total"], (
        "la propina no causa impuesto (art. 512-9 ET)"
    )
    assert sum(t["tax"] for t in doc["tax_lines"]) == doc["tax_total"]
    assert doc["tip"]["amount"] == propina, "pero sí se imprime, en línea separada (§8.3)"
    assert sum(line["net"] for line in doc["lines"]) == doc["total"], (
        "las líneas del documento siguen cerrando contra el total, sin la propina"
    )
    assert sum(p["amount"] for p in doc["payments"]) == doc["total"], (
        "la columna «venta» de los pagos suma la venta…"
    )
    assert sum(p["tip_amount"] for p in doc["payments"]) == propina, (
        "…y la columna «propina» suma la propina, cada una por su medio"
    )

    vista = _shift_view(admin_client, turno["id"])
    assert vista["sales"]["cash"] == venta, "la venta en efectivo entra a `sales.cash`"
    assert vista["sales"]["card"] == 0, "el datáfono sólo llevó propina: cero venta"
    assert vista["tips"]["card"] == propina, "y la propina entra sólo a `tips.card`"
    assert vista["tips"]["cash"] == 0


# ---------------------------------------------------------------------------
# (d) División de cuenta (§5.2, SPEC §3.4)
# ---------------------------------------------------------------------------


def test_splitting_by_items_keeps_the_total_and_issues_one_document_per_sub_account(
    device_client: Any, open_shift: Any, sales_products: Any
) -> None:
    """§3.4: «por ítems o por asiento = N sub-cuentas, cada una con su propio
    documento (impuesto por tasa, pregunta de propina y consecutivo propios)».

    Dos invariantes en uno (§5.2): Σ totales de las sub-cuentas == total de la
    comanda —dividir no puede cambiar lo que paga la mesa— y N documentos con
    N consecutivos **distintos y seguidos**, porque el consecutivo sin huecos
    es el que la DIAN mira (§8.3).
    """
    open_shift()
    order = create_order(device_client, channel="counter").json()
    order = add_items(
        device_client,
        order,
        [
            {"product_id": sales_products["inc8"].id, "qty": 1},
            {"product_id": sales_products["iva19"].id, "qty": 1},
            {"product_id": sales_products["excluded"].id, "qty": 1},
        ],
    ).json()
    total_comanda = order["totals"]["total"]
    item_ids = [item["id"] for item in order["items"]]

    division = device_client.post(
        f"{API}/orders/{order['id']}/bill/split",
        json={
            "expected_version": order["version"],
            "mode": "items",
            "groups": [
                {"label": "Uno", "item_ids": [item_ids[0]]},
                {"label": "Dos", "item_ids": [item_ids[1], item_ids[2]]},
            ],
        },
    )
    assert division.status_code == 200, division.text
    sub_accounts = division.json()["sub_accounts"]
    assert len(sub_accounts) == 2

    assert sum(sub["totals"]["total"] for sub in sub_accounts) == total_comanda, (
        "dividir la cuenta no puede cambiar lo que paga la mesa"
    )
    for sub in sub_accounts:
        assert sum(t["tax"] for t in sub["totals"]["tax_lines"]) == sub["totals"]["tax_total"], (
            "cada sub-cuenta discrimina su propio impuesto por tarifa"
        )

    numeros: list[int] = []
    for sub in sub_accounts:
        cobro = pay(
            device_client,
            order["id"],
            splits=[{"method": "cash", "amount": sub["totals"]["total"]}],
            tip=NO_TIP,
            sub_account_id=sub["id"],
        )
        assert cobro.status_code == 201, cobro.text
        documento = cobro.json()["document"]
        assert documento is not None, "cada sub-cuenta pagada emite su propio documento"
        numeros.append(documento["number"])

    assert len(set(numeros)) == len(numeros), "dos sub-cuentas no pueden compartir consecutivo"
    assert numeros == list(range(numeros[0], numeros[0] + len(numeros))), (
        f"los consecutivos de una misma mesa tienen que ser seguidos: {numeros}"
    )
    assert get_order(device_client, order["id"])["status"] == "paid", (
        "con todas las sub-cuentas pagadas la comanda queda pagada"
    )


def test_splitting_in_equal_parts_issues_one_document_with_n_payments(
    device_client: Any, open_shift: Any, sales_products: Any
) -> None:
    """§3.4: «partes iguales = un solo documento con N pagos». El caso
    contrario al anterior, y el que más fácil se implementa mal: si «partes
    iguales» emitiera N documentos, el restaurante estaría fraccionando una
    venta y el reporte contaría N tiquetes donde hubo uno."""
    open_shift()
    order = create_order(device_client, channel="counter").json()
    order = add_items(
        device_client, order, [{"product_id": sales_products["inc8"].id, "qty": 3}]
    ).json()

    division = device_client.post(
        f"{API}/orders/{order['id']}/bill/split",
        json={"expected_version": order["version"], "mode": "equal", "parts": 3},
    )
    assert division.status_code == 200, division.text
    partes = division.json()
    assert partes["mode"] == "equal"
    assert sum(partes["per_part"]) == partes["total"] == order["totals"]["total"], (
        "las partes iguales tienen que sumar exactamente el total (el residuo no se pierde)"
    )

    cobro = pay(
        device_client,
        order["id"],
        splits=[{"method": "cash", "amount": partes["per_part"][0]}]
        + [{"method": "card", "amount": amount} for amount in partes["per_part"][1:]],
        tip=NO_TIP,
    )
    assert cobro.status_code == 201, cobro.text
    doc = device_client.get(f"{API}/documents/{cobro.json()['document']['id']}").json()
    assert len(doc["payments"]) == 3, "un solo documento con los tres pagos"
    assert sum(p["amount"] for p in doc["payments"]) == doc["total"]

    documentos = device_client.get(f"{API}/documents/last").json()
    assert documentos["id"] == doc["id"], "no se emitió ningún documento adicional"


# ---------------------------------------------------------------------------
# (e) Consumo de personal: no es venta (§5.5, SPEC §3.3 y §8.2)
# ---------------------------------------------------------------------------


def test_a_staff_meal_is_free_untaxed_untipped_and_leaves_no_document(
    device_client: Any, admin_client: Any, open_shift: Any, sales_products: Any, employees: Any
) -> None:
    """§3.3: `staff_meal` «quién consumió, precio 0, sin impuesto ni propina»;
    §8.2: «cortesía y consumo de personal, sin precio, no generan base bajo
    INC».

    Cinco cosas a la vez, porque cualquiera que falle convierte una comida de
    empleado en una venta fantasma: `unit_price` 0, `tax_rate` 0, `tip` nulo,
    total 0, **sin documento** y sin sumar a `sales.*` del turno. El
    `consumed_by` queda, que es el dato con el que el mes que viene se
    reporta el consumo por persona.
    """
    turno = open_shift()
    creada = create_order(
        device_client, channel="staff_meal", consumed_by_employee_id=employees["operator"].id
    )
    assert creada.status_code == 201, creada.text
    order = creada.json()
    assert order["consumed_by"]["id"] == employees["operator"].id, (
        "sin `consumed_by` el consumo de personal no se puede reportar por persona"
    )

    order = add_items(
        device_client, order, [{"product_id": sales_products["inc8"].id, "qty": 2}]
    ).json()
    item = order["items"][0]
    assert item["unit_price"] == 0, "el consumo de personal no tiene precio"
    assert item["list_price"] > 0, "pero conserva el precio de carta, para valorizarlo"
    assert item["tax_rate"] == 0, "y no genera base de impuesto (§8.2)"
    assert order["totals"]["total"] == 0
    assert order["totals"]["tax_total"] == 0
    assert order["tip"] is None, "no se pregunta propina por una comida de personal"

    cobro = pay(device_client, order["id"], splits=[])
    assert cobro.status_code == 201, cobro.text
    assert cobro.json()["document"] is None, (
        "un consumo de personal no emite documento fiscal: no hubo venta"
    )
    assert cobro.json()["total"] == 0

    vista = _shift_view(admin_client, turno["id"])
    assert vista["sales"] == {"cash": 0, "card": 0, "transfer": 0, "other": 0}, (
        "el consumo de personal no suma a las ventas del turno"
    )
    assert vista["expected_cash"] == 200_000, "ni al esperado del cajón"


# ---------------------------------------------------------------------------
# (f) Con la cocina apagada no hay envío, pero sí rastro (§5.6, spec 1b)
# ---------------------------------------------------------------------------


def test_with_kitchen_view_off_send_is_refused_and_payment_serves_the_items(
    device_client: Any, open_shift: Any, sales_products: Any, set_feature: Any
) -> None:
    """Checklist de `features/fase-1b-venta/spec.md`: «con `kitchen.view`
    apagado no hay ronda y el cobro deja los ítems `served`».

    Y la segunda mitad, que es la que importa para el control (§3.3): esos
    ítems se marcan `sent_at_payment`. Sin esa marca, la sede sin cocina
    aparecería con 100 % de cobros «sin enviar» en el reporte por persona y
    la señal quedaría inservible justo donde sí significa algo.
    """
    set_feature("kitchen.view", False)
    open_shift()
    order = create_order(device_client, channel="counter").json()
    assert order["kitchen_view_enabled"] is False, (
        "la comanda congela el estado de la cocina al abrirse: el reporte no puede "
        "castigar hoy a una sede que ayer no tenía cocina"
    )
    order = add_items(
        device_client, order, [{"product_id": sales_products["inc8"].id, "qty": 1}]
    ).json()

    envio = device_client.post(
        f"{API}/orders/{order['id']}/send",
        json={"expected_version": order["version"]},
        headers=idem_headers(),
    )
    assert envio.status_code == 400, envio.text
    assert envio.json()["error"]["code"] == "FEATURE_DISABLED"

    cocina = device_client.get(f"{API}/kitchen/rounds")
    assert cocina.status_code == 400, "la vista de cocina tampoco existe con la flag apagada"
    assert cocina.json()["error"]["code"] == "FEATURE_DISABLED"

    cobro = pay(
        device_client,
        order["id"],
        splits=[{"method": "cash", "amount": order["totals"]["total"]}],
        tip=NO_TIP,
    )
    assert cobro.status_code == 201, cobro.text
    pagada = cobro.json()["order"]
    assert [item["status"] for item in pagada["items"]] == ["served"], (
        "sin cocina, cobrar entrega el ítem"
    )
    assert all(item["sent_at_payment"] for item in pagada["items"]), (
        "y deja el rastro `sent_at_payment`"
    )


# ---------------------------------------------------------------------------
# (g) Anular lo enviado no repone nada (§5.7, SPEC §3.3 y §5.5)
# ---------------------------------------------------------------------------


def test_voiding_a_sent_item_never_restores_the_counter_and_creates_a_waste_stub(
    device_client: Any, db: Any, open_shift: Any, sales_products: Any
) -> None:
    """§3.3: «Anular un ítem ya enviado **no devuelve el insumo**: genera
    merma. Es lo contrario de la referencia, que reponía siempre».

    El contador de porciones del día es el caso visible de la misma regla: si
    anular repusiera el contador, dos personas podrían vender veinte
    sancochos, anular diez y seguir vendiendo, y el inventario de fase 2
    acusaría un robo que nunca existió. La merma queda con `ingredient_id`
    NULL: es el gancho que fase 2 resuelve, no un dato que falte
    (`CONTRATO-INTERNO-1b-1.md §2.2`, `WasteStub`).
    """
    from app.orders.models import WasteStub

    producto = sales_products["inc8"]
    producto.daily_count = 2
    producto.daily_remaining = 2
    db.commit()

    open_shift()
    order = create_order(device_client, channel="counter").json()
    order = add_items(device_client, order, [{"product_id": producto.id, "qty": 2}]).json()
    envio = device_client.post(
        f"{API}/orders/{order['id']}/send",
        json={"expected_version": order["version"]},
        headers=idem_headers(),
    )
    assert envio.status_code == 200, envio.text
    order = envio.json()

    db.expire_all()
    assert producto.daily_remaining == 0, "enviar descuenta el contador de porciones"
    assert producto.available is False, "al llegar a cero el producto queda agotado"

    item_id = order["items"][0]["id"]
    anulacion = device_client.post(
        f"{API}/orders/{order['id']}/items/{item_id}/void",
        json={
            "expected_version": order["version"],
            "reason": "kitchen_error",
            "authorizer_pin": "5555",
        },
    )
    assert anulacion.status_code == 200, anulacion.text

    db.expire_all()
    assert producto.daily_remaining == 0, "anular lo enviado NO repone el contador"
    assert producto.available is False, "ni lo desagota"

    stubs = list(db.execute(select(WasteStub).where(WasteStub.order_id == order["id"])).scalars())
    assert len(stubs) == 1, "el ítem enviado y anulado deja exactamente una merma"
    stub = stubs[0]
    assert stub.ingredient_id is None, "sin insumo: la receta llega en fase 2"
    assert stub.resolved is False
    assert stub.qty == 2 and stub.reason.value == "kitchen_error"
    assert stub.product_name == producto.name, "con el nombre congelado del producto"

    anulado = get_order(device_client, order["id"])["items"][0]
    assert anulado["status"] == "voided"
    assert anulado["void"]["minutes_since_sent"] is not None, (
        "los minutos desde el envío son la señal del reporte de anulaciones (§3.5)"
    )
    assert anulado["net"] == 0, "y el ítem anulado deja de sumar a la venta"


# ---------------------------------------------------------------------------
# (h) Fecha de negocio: la venta pertenece al día operativo, no al UTC
# ---------------------------------------------------------------------------


def test_a_sale_at_00_30_belongs_to_the_business_date_of_its_shift(
    device_client: Any, open_shift: Any, sales_products: Any, clock: Any, identify: Any, employees: Any
) -> None:
    """Checklist del pedido 1b: «venta a las 00:30 en el día del turno».
    §3.1: la fecha de negocio se calcula en `America/Bogota` con la hora de
    corte de la sede (6:00), nunca derivada de UTC.

    A las 00:30 de Bogotá el turno de anoche sigue siendo el de anoche: si la
    venta se sellara con el día del calendario, el cierre de caja de la noche
    partiría en dos y las ventas después de medianoche caerían en un día que
    todavía no abrió.
    """
    # 2026-03-10 18:00 en Bogotá (UTC-5): día operativo 2026-03-10.
    clock.set(datetime(2026, 3, 10, 23, 0, tzinfo=timezone.utc))
    turno = open_shift()
    assert turno["business_date"] == "2026-03-10"

    # 2026-03-11 00:30 en Bogotá: todavía antes de la hora de corte (6:00).
    clock.set(datetime(2026, 3, 11, 5, 30, tzinfo=timezone.utc))
    identify(device_client, employees["cashier"])

    order = create_order(device_client, channel="counter").json()
    assert order["business_date"] == "2026-03-10", (
        "la comanda de las 00:30 pertenece al día operativo del turno abierto"
    )
    order = add_items(
        device_client, order, [{"product_id": sales_products["inc8"].id, "qty": 1}]
    ).json()
    cobro = pay(
        device_client,
        order["id"],
        splits=[{"method": "cash", "amount": order["totals"]["total"]}],
        tip=NO_TIP,
    )
    assert cobro.status_code == 201, cobro.text
    doc = device_client.get(f"{API}/documents/{cobro.json()['document']['id']}").json()
    assert doc["business_date"] == "2026-03-10", (
        "y el documento se sella con la misma fecha de negocio, no con la del calendario UTC"
    )


def test_a_sale_on_a_shift_past_the_cutoff_is_stamped_with_today(
    device_client: Any, open_shift: Any, sales_products: Any, clock: Any, identify: Any, employees: Any
) -> None:
    """La otra mitad del checklist: «a las 10:00 sobre turno pasado de la hora
    de corte, sellada con hoy» (§3.1: un turno abierto pasada la hora de corte
    del día siguiente es un turno abandonado).

    Sin esta regla, un turno que nadie cerró arrastraría las ventas de hoy al
    día de ayer para siempre, y el reporte bimestral declararía base en un
    período que ya se presentó.
    """
    clock.set(datetime(2026, 3, 10, 23, 0, tzinfo=timezone.utc))  # 18:00 local
    turno = open_shift()
    assert turno["business_date"] == "2026-03-10"

    # 2026-03-11 10:00 local: pasada la hora de corte (6:00) del día siguiente.
    clock.set(datetime(2026, 3, 11, 15, 0, tzinfo=timezone.utc))
    identify(device_client, employees["cashier"])

    order = create_order(device_client, channel="counter").json()
    assert order["business_date"] == "2026-03-11", (
        "sobre un turno abandonado la venta se sella con el día operativo de hoy"
    )
    order = add_items(
        device_client, order, [{"product_id": sales_products["inc8"].id, "qty": 1}]
    ).json()
    cobro = pay(
        device_client,
        order["id"],
        splits=[{"method": "cash", "amount": order["totals"]["total"]}],
        tip=NO_TIP,
    )
    assert cobro.status_code == 201, cobro.text
    doc = device_client.get(f"{API}/documents/{cobro.json()['document']['id']}").json()
    assert doc["business_date"] == "2026-03-11"
