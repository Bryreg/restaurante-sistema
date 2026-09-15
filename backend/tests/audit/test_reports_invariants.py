"""Invariantes de los reportes del administrador (pedido 1b-2).

Rol Contador. Tres reglas que los reportes rompen más fácil que cualquier
otra parte del sistema, porque son la parte que nadie mira hasta el día que
el contador pregunta:

1. **La propina nunca entra en el `net`** de ningún reporte, ni en la venta
   ni en el impuesto (`docs/SPEC-NEGOCIO.md §3.4`, §6.2, §8.2 y §10; Ley 1935
   de 2018, art. 512-9 ET). «No es ingreso, no causa impuesto, no entra en
   ventas netas ni en margen». Es la regla que la referencia rompió durante
   siete meses contando el impuesto como utilidad.
2. **Los reportes leen los SNAPSHOTS**, nunca la carta actual (§11.2,
   `AGENTS.md`): «Ninguna consulta de reportes vuelve a la carta actual para
   valorar una venta pasada». Una venta de marzo vale lo que valía en marzo.
3. **`null` no es 0** (§6.1, §11.13): «"sin datos" se dice, no se dibuja como
   cero». «Nadie vendió» y «vendió $0» son cosas distintas.

Más lo transversal del pedido: aislamiento por organización y sede (`404`),
y `format=csv` en todo listado.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import func, select

from tests.audit.conftest import (
    NO_TIP,
    add_items,
    create_order,
    idem_headers,
    pay,
)

API = "/api/v1"


def _sell(client: Any, product_id: int, *, qty: int = 1, tip: int = 0, method: str = "cash") -> dict[str, Any]:
    order = create_order(client, channel="counter").json()
    order = add_items(client, order, [{"product_id": product_id, "qty": qty}]).json()
    total = order["totals"]["total"]
    resp = pay(
        client,
        order["id"],
        splits=[{"method": method, "amount": total + tip}],
        tip=(
            {"asked": True, "accepted": True, "modified": True, "amount": tip}
            if tip
            else NO_TIP
        ),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _today(admin_client: Any, store_id: int) -> dict[str, Any]:
    resp = admin_client.get(f"{API}/admin/today", params={"store_id": store_id})
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] = resp.json()
    return body


def _sales(admin_client: Any, store_id: int, *, group_by: str = "business_date", **extra: Any) -> dict[str, Any]:
    params = {"store_id": store_id, "from": "2020-01-01", "to": "2099-12-31", "group_by": group_by}
    params.update(extra)
    resp = admin_client.get(f"{API}/admin/sales", params=params)
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] = resp.json()
    return body


# ---------------------------------------------------------------------------
# (a) La propina, fuera del net de todos los reportes (§6.2, §8.2, §10)
# ---------------------------------------------------------------------------


def test_the_tip_never_enters_net_gross_or_tax_of_any_report(
    device_client: Any, admin_client: Any, store: Any, open_shift: Any, sales_products: Any
) -> None:
    """§10: «Ventas netas = ventas cobradas − impuesto; **sin propina**»;
    §6.2: la propina es «100 % para los trabajadores», así que ni siquiera es
    ingreso del establecimiento.

    Se miden **todas** las representaciones a la vez: `GET /admin/today`,
    `GET /admin/sales` (agrupado y total) y el informe del contador. Con un
    solo reporte auditado la regla se cumple por casualidad; con los tres, se
    cumple por diseño. La propina sí tiene que aparecer — en su propia
    columna, discriminada por medio: ocultarla sería el error opuesto (§6.2:
    «se reporta por turno, por persona y por medio de pago»).
    """
    open_shift()
    propina = 7_000
    venta = _sell(device_client, sales_products["inc8"].id, tip=propina)
    total = venta["total"]
    impuesto = admin_client.get(f"{API}/documents/{venta['document']['id']}").json()["tax_total"]

    hoy = _today(admin_client, store.id)
    assert hoy["gross"] == total, "el bruto es lo cobrado de la VENTA, sin propina"
    assert hoy["net"] == total - impuesto
    assert hoy["tax"] == impuesto
    assert hoy["tips_total"] == propina, "y la propina se reporta aparte, nunca se esconde"
    assert sum(t["amount"] for t in hoy["tips_by_method"]) == propina
    for bucket in hoy["sales_by_hour"]:
        assert bucket["gross"] <= total, f"la propina se coló en las ventas por hora: {bucket}"

    ventas = _sales(admin_client, store.id)
    for fila in ventas["rows"] + [ventas["total"]]:
        assert fila["gross"] == total, f"la propina entró en `gross`: {fila}"
        assert fila["net"] == total - impuesto, f"la propina entró en `net`: {fila}"
        assert fila["tax"] == impuesto, f"la propina causó impuesto: {fila}"
        assert fila["tips"] == propina

    # Por medio de pago, que es donde más fácil se mezcla (un solo pago cubre
    # venta + propina y hay que partirlo).
    por_medio = _sales(admin_client, store.id, group_by="method")
    assert len(por_medio["rows"]) == 1
    fila = por_medio["rows"][0]
    assert fila["gross"] == total, "el split se anotó completo (venta + propina) como venta"
    assert fila["tips"] == propina

    from datetime import date as _date

    hoy_fecha = _date.fromisoformat(ventas["rows"][0]["key"])
    contador = admin_client.get(
        f"{API}/admin/accountant-report",
        params={"store_id": store.id, "year": hoy_fecha.year, "month": hoy_fecha.month},
    )
    assert contador.status_code == 200, contador.text
    informe = contador.json()
    assert informe["documents_total_base"] + informe["documents_total_tax"] == total, (
        "la base + el impuesto del informe del contador tienen que reproducir la venta, sin propina"
    )
    assert informe["documents_total_tax"] == impuesto
    assert informe["tips_total"] == propina, "la propina va en el informe como **informativa** (§8.2)"
    for fila in informe["rows"]:
        for tarifa in fila["by_rate"]:
            assert tarifa["documents_base"] + tarifa["documents_tax"] <= total, tarifa

    # Y los totales por medio del informe tampoco la suman.
    assert sum(m["amount"] for m in informe["totals_by_method"]) == total, (
        "`totals_by_method` es lo cobrado de la venta; la propina no es ingreso (§6.2)"
    )


def test_a_mixed_payment_never_gives_a_method_more_tax_than_its_own_share(
    device_client: Any, admin_client: Any, store: Any, open_shift: Any, sales_products: Any
) -> None:
    """§8.2: el impuesto se reparte por línea y por tarifa; agrupado por medio
    de pago, un documento con pagos mixtos es el ÚNICO caso donde el reporte
    tiene que repartir un número que el documento trae entero.

    El invariante contable: la suma de los medios reproduce el documento y
    ningún medio puede llevar más impuesto del que le toca por su parte de la
    venta. Es el caso donde el tope de A-12 (`share <= weight`) entra de
    verdad con plata real, no con pesos de juguete.
    """
    open_shift()
    order = create_order(device_client, channel="counter").json()
    order = add_items(
        device_client,
        order,
        [
            {"product_id": sales_products["inc8"].id, "qty": 2},
            {"product_id": sales_products["iva19"].id, "qty": 1},
        ],
    ).json()
    total = order["totals"]["total"]
    en_efectivo = total // 3
    cobro = pay(
        device_client,
        order["id"],
        splits=[
            {"method": "cash", "amount": en_efectivo},
            {"method": "card", "amount": total - en_efectivo},
        ],
        tip=NO_TIP,
    )
    assert cobro.status_code == 201, cobro.text
    impuesto = admin_client.get(f"{API}/documents/{cobro.json()['document']['id']}").json()["tax_total"]

    por_medio = _sales(admin_client, store.id, group_by="method")
    filas = {fila["key"]: fila for fila in por_medio["rows"]}
    assert set(filas) == {"cash", "card"}, filas
    assert sum(f["gross"] for f in filas.values()) == total, "la suma de los medios reproduce el documento"
    assert sum(f["tax"] for f in filas.values()) == impuesto, "y el impuesto se reparte sin perder un peso"
    for clave, fila in filas.items():
        assert 0 <= fila["tax"] <= fila["gross"], (
            f"el medio `{clave}` quedó con más impuesto del que cobró: {fila}"
        )
        assert fila["net"] == fila["gross"] - fila["tax"] >= 0

    assert por_medio["total"]["gross"] == total, (
        "el total nunca puede diferir de la suma de sus filas (una sola matemática)"
    )
    assert por_medio["total"]["tax"] == impuesto


# ---------------------------------------------------------------------------
# (b) Snapshots: una venta pasada no se revalora (§11.2)
# ---------------------------------------------------------------------------


def test_changing_the_menu_price_today_does_not_revalue_yesterdays_sale(
    device_client: Any, admin_client: Any, db: Any, store: Any, open_shift: Any, sales_products: Any
) -> None:
    """§11.2 y `AGENTS.md`: «Precio, impuesto, costo, receta, modificadores,
    curso y estación se congelan en el ítem… Ninguna consulta de reportes
    vuelve a la carta actual para valorar una venta pasada».

    Es el invariante que hace que el informe del contador sea reproducible:
    si el reporte leyera la carta, el mismo bimestre daría un número distinto
    cada vez que alguien sube un precio, y ninguna declaración presentada se
    podría volver a armar.
    """
    open_shift()
    venta = _sell(device_client, sales_products["inc8"].id, qty=2)
    total_original = venta["total"]

    antes_hoy = _today(admin_client, store.id)
    antes_ventas = _sales(admin_client, store.id)
    documento_antes = admin_client.get(f"{API}/documents/{venta['document']['id']}").json()

    # El dueño sube el precio un 60 % y cambia la tarifa del producto.
    producto = sales_products["inc8"]
    producto.price_dine_in = int(producto.price_dine_in * 1.6)
    producto.price_takeout = producto.price_dine_in
    producto.tax_code = "iva_19"
    producto.name = "Bandeja (nombre nuevo)"
    db.commit()

    assert _today(admin_client, store.id) == antes_hoy, (
        "cambiar la carta movió el reporte de hoy: la venta se revaloró con el precio nuevo"
    )
    assert _sales(admin_client, store.id) == antes_ventas
    assert admin_client.get(f"{API}/documents/{venta['document']['id']}").json() == documento_antes, (
        "el comprobante emitido cambió al cambiar la carta: dejó de ser evidencia"
    )
    assert antes_ventas["total"]["gross"] == total_original


def test_a_note_takes_the_original_out_of_the_period_and_stands_on_its_own_line(
    device_client: Any, admin_client: Any, store: Any, open_shift: Any, sales_products: Any
) -> None:
    """§10: «Ventas cobradas = Σ documentos **no anulados ni reversados**», y
    §8.2: el informe bimestral lleva «base, impuesto, cantidad de documentos,
    **notas**, propinas».

    Las dos columnas separadas son deliberadas y contables: netear la nota
    contra la venta dentro de la misma cifra esconde el hecho de que hubo una
    corrección. El contador tiene que ver las dos y decidir; el sistema no
    decide por él (§8.2: «El sistema no genera formularios»).
    """
    open_shift()
    primera = _sell(device_client, sales_products["inc8"].id)
    segunda = _sell(device_client, sales_products["iva19"].id)
    total_dos = primera["total"] + segunda["total"]

    antes = _sales(admin_client, store.id)
    assert antes["total"]["gross"] == total_dos

    printable = admin_client.get(f"{API}/documents/{primera['document']['id']}").json()
    nota = admin_client.post(
        f"{API}/admin/documents/{primera['document']['id']}/notes",
        json={
            "kind": "adjustment",
            "reason": "Devolución del cliente",
            "lines": [{"item_id": line["item_id"], "used": True} for line in printable["lines"]],
        },
        headers=idem_headers(),
    )
    assert nota.status_code == 201, nota.text

    despues = _sales(admin_client, store.id)
    assert despues["total"]["gross"] == segunda["total"], (
        "el documento reversado tiene que salir de «ventas cobradas» (§10)"
    )

    from datetime import date as _date

    fecha = _date.fromisoformat(despues["rows"][0]["key"])
    informe = admin_client.get(
        f"{API}/admin/accountant-report",
        params={"store_id": store.id, "year": fecha.year, "month": fecha.month},
    ).json()
    assert informe["notes_total_base"] + informe["notes_total_tax"] == primera["total"], (
        "la nota tiene su propia fila en el informe, con su base y su impuesto"
    )
    assert informe["documents_total_base"] + informe["documents_total_tax"] == segunda["total"]
    assert sum(r["notes_count"] for r in informe["rows"]) == 1


def test_no_data_is_reported_as_null_and_never_as_zero(
    admin_client: Any, store: Any
) -> None:
    """§6.1 y §9.3: «`null` no es 0», «"sin datos" se dice, no se dibuja como
    cero».

    Sin ventas, un ticket promedio de `$0` es una mentira aritmética (dividir
    por cero comandas) que además le dice al dueño que su restaurante vende
    $0 por mesa, cuando lo cierto es que todavía no vendió. Y sin turno
    abierto, `expected_cash` es «nadie contó», no «el cajón está vacío».
    """
    hoy = _today(admin_client, store.id)
    assert hoy["orders"] == 0
    assert hoy["avg_ticket"] is None, "ticket promedio sin comandas es `null`, nunca 0"
    assert hoy["avg_per_cover"] is None
    assert hoy["expected_cash"] is None, "sin turno abierto nadie contó: `null`, no $0"

    ventas = _sales(admin_client, store.id)
    assert ventas["rows"] == []
    assert ventas["total"]["avg_ticket"] is None and ventas["total"]["avg_per_cover"] is None


# ---------------------------------------------------------------------------
# (c) Aislamiento, exportación y costos (§1.1, §9.3, AGENTS.md)
# ---------------------------------------------------------------------------


def test_every_admin_report_of_another_organization_is_a_404(
    admin_client: Any, other_org: Any
) -> None:
    """§1.1, §2.2 y §11.19: «toda consulta se acota por organización y sede;
    un id ajeno es `404`» — nunca `403` (delata que existe) ni `200` (entrega
    las ventas del vecino). Sobre reportes es la fuga más valiosa que existe:
    es el estado de resultados del competidor de al lado.
    """
    ajena = other_org["store"].id
    rutas = [
        (f"{API}/admin/today", {"store_id": ajena}),
        (f"{API}/admin/sales", {"store_id": ajena, "from": "2020-01-01", "to": "2099-12-31", "group_by": "business_date"}),
        (f"{API}/admin/accountant-report", {"store_id": ajena, "year": 2026, "month": 1}),
        (f"{API}/admin/unavailable-log", {"store_id": ajena, "from": "2020-01-01", "to": "2099-12-31"}),
        (f"{API}/admin/fiscal/ranges", {"store_id": ajena}),
        (f"{API}/admin/fiscal/documents", {"store_id": ajena}),
        (f"{API}/admin/fiscal/export", {"store_id": ajena, "from": "2020-01-01", "to": "2099-12-31"}),
        (f"{API}/admin/notes", {"store_id": ajena}),
        (f"{API}/admin/pending-refunds", {"store_id": ajena}),
        (f"{API}/admin/documents", {"store_id": ajena, "from": "2020-01-01", "to": "2099-12-31"}),
        (f"{API}/admin/orders", {"store_id": ajena, "from": "2020-01-01", "to": "2099-12-31"}),
    ]
    for ruta, params in rutas:
        resp = admin_client.get(ruta, params=params)
        assert resp.status_code == 404, f"{ruta} con sede ajena devolvió {resp.status_code}: {resp.text[:200]}"
        assert resp.json()["error"]["code"], resp.text

    # Y en escritura: cargar un rango en la sede del vecino.
    escritura = admin_client.post(
        f"{API}/admin/fiscal/ranges",
        json={
            "store_id": ajena,
            "document_type": "pos_equivalent",
            "prefix": "ROB",
            "from_number": 1,
            "to_number": 10,
            "resolution_number": "1",
            "resolution_date": "2026-01-01",
            "valid_from": "2026-01-01",
            "valid_until": "2027-01-01",
        },
    )
    assert escritura.status_code == 404, escritura.text


def test_every_new_admin_list_exports_csv(
    device_client: Any, admin_client: Any, store: Any, open_shift: Any, sales_products: Any
) -> None:
    """Pedido 1b-2: «**Todo listado acepta `format=csv`**» y §9.3: «toda lista
    exporta».

    No es comodidad: el contador y el revisor fiscal trabajan fuera del
    sistema, y un reporte que sólo se puede mirar en pantalla obliga a
    transcribir a mano — que es exactamente de donde salen los números que no
    cuadran.
    """
    open_shift()
    venta = _sell(device_client, sales_products["inc8"].id)
    printable = admin_client.get(f"{API}/documents/{venta['document']['id']}").json()
    admin_client.post(
        f"{API}/admin/documents/{venta['document']['id']}/notes",
        json={
            "kind": "adjustment",
            "reason": "Para que el listado de notas tenga una fila",
            "lines": [{"item_id": line["item_id"], "used": True} for line in printable["lines"]],
        },
        headers=idem_headers(),
    )

    rango = {"from": "2020-01-01", "to": "2099-12-31"}
    listados = [
        (f"{API}/admin/sales", {"store_id": store.id, **rango, "group_by": "business_date"}),
        (f"{API}/admin/accountant-report", {"store_id": store.id, "year": 2026, "month": 1}),
        (f"{API}/admin/unavailable-log", {"store_id": store.id, **rango}),
        (f"{API}/admin/orders", {"store_id": store.id, **rango}),
        (f"{API}/admin/documents", {"store_id": store.id, **rango}),
        (f"{API}/admin/notes", {"store_id": store.id, **rango}),
        (f"{API}/admin/fiscal/ranges", {"store_id": store.id}),
        (f"{API}/admin/fiscal/documents", {"store_id": store.id}),
        (f"{API}/admin/pending-refunds", {"store_id": store.id}),
        (f"{API}/admin/customers", {}),
    ]
    for ruta, params in listados:
        resp = admin_client.get(ruta, params={**params, "format": "csv"})
        assert resp.status_code == 200, f"{ruta}: {resp.status_code} {resp.text[:200]}"
        assert "text/csv" in resp.headers.get("content-type", ""), (
            f"{ruta} ignoró `format=csv` y devolvió {resp.headers.get('content-type')!r}"
        )


def test_no_report_ever_exposes_a_cost_or_a_margin(
    device_client: Any, admin_client: Any, store: Any, open_shift: Any, sales_products: Any
) -> None:
    """`AGENTS.md` y §11.10: «El operador no ve costos ni márgenes; el backend
    no se los manda».

    En 1b-2 el costo todavía no existe (llega en fase 2), así que este
    invariante se escribe **antes** de que haya algo que filtrar: el día que
    `unit_cost` se llene de verdad, este test dice enseguida si alguno de los
    reportes nuevos lo arrastró hasta una respuesta que ve el salón.
    """
    from tests.audit.conftest import deep_keys

    open_shift()
    _sell(device_client, sales_products["inc8"].id)

    prohibidos = {"cost", "unit_cost", "margin", "food_cost", "recipe_version", "theoretical_cost"}
    rango = {"from": "2020-01-01", "to": "2099-12-31"}
    respuestas = [
        admin_client.get(f"{API}/admin/today", params={"store_id": store.id}),
        admin_client.get(f"{API}/admin/sales", params={"store_id": store.id, **rango, "group_by": "employee"}),
        admin_client.get(f"{API}/admin/accountant-report", params={"store_id": store.id, "year": 2026, "month": 1}),
        admin_client.get(f"{API}/admin/orders", params={"store_id": store.id, **rango}),
        admin_client.get(f"{API}/admin/unavailable-log", params={"store_id": store.id, **rango}),
        admin_client.get(f"{API}/admin/fiscal/documents", params={"store_id": store.id}),
    ]
    for resp in respuestas:
        assert resp.status_code == 200, resp.text
        filtradas = deep_keys(resp.json()) & prohibidos
        assert not filtradas, f"{resp.request.url} filtró {sorted(filtradas)}"


# ---------------------------------------------------------------------------
# (d) Propinas: fondo aparte, pasivo con el personal (§6.2, Ley 1935 de 2018)
# ---------------------------------------------------------------------------


def test_the_shift_tips_are_a_fund_apart_and_the_electronic_ones_are_a_liability(
    device_client: Any, admin_client: Any, store: Any, open_shift: Any, sales_products: Any
) -> None:
    """§6.2: «Fondo aparte por turno: recaudado por medio (efectivo /
    datáfono / transferencia), por persona que atendió, y por comanda… Las
    propinas en efectivo salen del cajón al cierre. Las **electrónicas**
    quedan como **pasivo con el personal**».

    La distinción no es contable-decorativa: la propina en efectivo ya está
    en el cajón y sale de ahí; la electrónica entró a la cuenta del dueño y
    él **la debe**. Confundirlas es la forma más común de que la propina
    electrónica nunca llegue al personal — que es exactamente lo que la Ley
    1935 de 2018 prohíbe («100 % para los trabajadores»).
    """
    turno = open_shift()
    _sell(device_client, sales_products["inc8"].id, tip=5_000, method="cash")
    _sell(device_client, sales_products["inc8"].id, tip=9_000, method="card")

    resp = admin_client.get(f"{API}/shifts/{turno['id']}/tips")
    assert resp.status_code == 200, resp.text
    propinas = resp.json()

    assert propinas["by_method"]["cash"] == 5_000
    assert propinas["by_method"]["card"] == 9_000
    assert propinas["cash_out"] == 5_000, "lo que sale del cajón al cierre es sólo lo de efectivo"
    assert propinas["electronic_liability"] == 9_000, (
        "lo electrónico queda como deuda con el personal, no como plata del dueño"
    )
    assert sum(e["total"] for e in propinas["by_employee"]) == 14_000, (
        "la propina se reporta por persona (§6.2): sin eso no se puede repartir"
    )

    # Y nada de eso entró en la venta del turno ni en el reporte de ventas.
    turno_resp = admin_client.get(f"{API}/shifts/{turno['id']}")
    assert turno_resp.status_code == 200, turno_resp.text
    cuerpo = turno_resp.json()
    assert cuerpo["sales"]["cash"] + cuerpo["sales"]["card"] == _sales(admin_client, store.id)["total"]["gross"], (
        "las ventas del turno y el reporte de ventas tienen que decir lo mismo, y ninguno incluir propina"
    )


def test_a_tip_payout_registers_who_got_what_and_never_invents_a_cash_movement(
    device_client: Any, admin_client: Any, db: Any, store: Any, employees: Any, open_shift: Any, sales_products: Any
) -> None:
    """§6.2: «El **registro del reparto** (quién, cuánto, cuándo) existe desde
    la fase 1b; el cálculo automático del reparto… en fase 3»; y el pedido
    1b-2: «registra el reparto; el cálculo es manual en esta fase».

    Lo que se audita es la frontera: registrar el reparto es un hecho
    administrativo, **no** un egreso de caja. Si el registro creara un
    `CashMovement` por su cuenta, el mismo pago se contaría dos veces el día
    que el dueño además lo saque del cajón con el movimiento `tip_payout` que
    ya existe desde 1b-1 — la llave anti doble conteo de §6.1.
    """
    from app.shifts.models import CashMovement

    turno = open_shift()
    _sell(device_client, sales_products["inc8"].id, tip=6_000, method="card")

    movimientos_antes = db.execute(select(func.count()).select_from(CashMovement)).scalar_one()

    reparto = admin_client.post(
        f"{API}/admin/tips/payouts",
        params={"store_id": store.id},
        json={
            "shift_ids": [turno["id"]],
            "distribution": [{"employee_id": employees["cashier"].id, "amount": 6_000}],
            "paid_at": "2026-01-15T20:00:00Z",
            "method": "cash",
        },
        headers=idem_headers(),
    )
    assert reparto.status_code == 201, reparto.text
    cuerpo = reparto.json()
    assert cuerpo["total_amount"] == 6_000
    assert cuerpo["distribution"][0]["employee_name"], (
        "el reparto queda a nombre congelado de quien lo recibió (§2.1, atribución)"
    )
    assert cuerpo["created_by"], "y de quien lo registró"

    db.expire_all()
    movimientos_despues = db.execute(select(func.count()).select_from(CashMovement)).scalar_one()
    assert movimientos_despues == movimientos_antes, (
        "registrar el reparto creó un movimiento de caja por su cuenta: el egreso `tip_payout` "
        "lo registra el responsable aparte, y contarlo dos veces fabrica un faltante (§6.1)"
    )


# ---------------------------------------------------------------------------
# (e) «Requiere tu atención»: lo que el dueño tiene que ver sin buscarlo
# ---------------------------------------------------------------------------


def test_a_contingency_document_reaches_requiere_tu_atencion_without_going_looking_for_it(
    device_client: Any, admin_client: Any, db: Any, store: Any, clock: Any, open_shift: Any, sales_products: Any
) -> None:
    """**ROJO A PROPÓSITO — hallazgo B-3 de 1b-2.**

    §9.3, banda «Requiere tu atención» de **Hoy**: entre sus alertas están
    «**documentos en contingencia o rechazados**, rango de numeración por
    agotarse, cierres sin revisar, devoluciones pendientes». §8.3: «los
    vencidos [48 h] aparecen en "Requiere tu atención"».

    El rechazo sí llega solo: `fiscal_rejected` se notifica al emitir. La
    contingencia no: `sweep_contingency_overdue` sólo corre cuando alguien
    **entra** a `GET /admin/fiscal/documents` o a `GET /admin/fiscal/export`
    (barrido perezoso, decisión declarada por `backend-fiscal` §4.5 por no
    haber scheduler). Como `GET /admin/today` no lo llama, el dueño que abre
    el sistema en «Hoy» —que es la pantalla que se abre— no ve ni el
    documento en contingencia ni el vencimiento del plazo del art. 616-1 ET,
    hasta que entra a una pantalla que sólo mira si ya sospecha algo.

    Es exactamente el mecanismo que la alerta existe para evitar: enterarse
    de que un documento no se transmitió cuando la DIAN pregunta.
    """
    from app.fiscal.provider import FakeProvider, set_provider_override

    open_shift()

    # (1) Un rechazo sí llega solo a «Requiere tu atención».
    try:
        set_provider_override(FakeProvider(outcome="reject"))
        _sell(device_client, sales_products["inc8"].id)
    finally:
        set_provider_override(None)
    hoy = _today(admin_client, store.id)
    assert any(a["type"] == "fiscal_rejected" for a in hoy["alerts"]), (
        f"un documento rechazado tiene que aparecer en Hoy sin buscarlo: {hoy['alerts']}"
    )

    # (2) La contingencia, después de las 48 h, no.
    try:
        set_provider_override(FakeProvider(outcome="contingency"))
        contingente = _sell(device_client, sales_products["inc8"].id)
    finally:
        set_provider_override(None)
    assert contingente["document"]["dian_status"] == "contingency"

    clock.advance(hours=49)
    hoy = _today(admin_client, store.id)
    tipos = {a["type"] for a in hoy["alerts"]}
    assert "fiscal_contingency_overdue" in tipos, (
        "pasadas las 48 h, el documento en contingencia tiene que aparecer en «Requiere tu "
        f"atención» de Hoy (§8.3, §9.3) sin que nadie vaya a buscarlo: {sorted(tipos)}. "
        "Hoy `sweep_contingency_overdue` sólo corre al entrar a `GET /admin/fiscal/documents`"
    )


# ---------------------------------------------------------------------------
# (g) RONDA 2 — contraprueba del cierre B-3
# ---------------------------------------------------------------------------


def test_the_contingency_sweep_does_not_duplicate_the_alert_nor_replace_the_lazy_one(
    device_client: Any, admin_client: Any, db: Any, store: Any, clock: Any, open_shift: Any, sales_products: Any
) -> None:
    """**Contraprueba de B-3.** El cierre agregó
    `fiscal_service.sweep_contingency_overdue(db, store_id=store.id)` dentro
    de `today_report` (`app/reports/service.py:520`). Un barrido perezoso que
    corre en cada entrada a la pantalla más visitada del sistema tiene dos
    riesgos propios, y ninguno lo cubre el test de B-3:

    1. **Que duplique.** «Hoy» se abre muchas veces al día. Si `notify(...)`
       no dedupeara por `fiscal_contingency_overdue:{document_id}`, la banda
       «Requiere tu atención» se llenaría de copias de la misma alerta y
       dejaría de servir para lo que existe (§9.3: es una lista de acciones,
       no un historial).
    2. **Que el punto viejo se haya movido en vez de sumarse.** El barrido de
       `GET /admin/fiscal/documents` y `GET /admin/fiscal/export` es el que
       tenía `backend-fiscal` y sigue siendo necesario: el contador que entra
       derecho a Documentos fiscales o al paquete de evidencia tiene que ver
       el vencimiento ahí, sin pasar por Hoy.

    El test hace las dos cosas sobre **dos** documentos distintos, para que
    cada punto de barrido se pruebe solo.
    """
    from app.fiscal.models import DianStatus, FiscalDocument
    from app.fiscal.provider import FakeProvider, set_provider_override
    from app.notifications.models import Notification

    open_shift()

    try:
        set_provider_override(FakeProvider(outcome="contingency"))
        primero = _sell(device_client, sales_products["inc8"].id)
        segundo = _sell(device_client, sales_products["inc8"].id)
    finally:
        set_provider_override(None)
    doc_a = primero["document"]["id"]
    doc_b = segundo["document"]["id"]
    assert primero["document"]["dian_status"] == "contingency"
    assert segundo["document"]["dian_status"] == "contingency"

    def _overdue() -> list[Notification]:
        db.expire_all()
        return list(
            db.execute(
                select(Notification).where(Notification.type == "fiscal_contingency_overdue")
            ).scalars()
        )

    # Antes de las 48 h no hay nada que avisar, por ninguno de los dos caminos.
    _today(admin_client, store.id)
    assert _overdue() == [], "antes de las 48 h el documento en contingencia no está vencido (§8.3)"

    clock.advance(hours=49)

    # (1) El barrido perezoso de Documentos fiscales sigue vivo por su cuenta.
    listado = admin_client.get(f"{API}/admin/fiscal/documents", params={"store_id": store.id})
    assert listado.status_code == 200, listado.text
    tras_listado = _overdue()
    assert {n.payload["document_id"] for n in tras_listado} == {doc_a, doc_b}, (
        "`GET /admin/fiscal/documents` tiene que seguir barriendo la contingencia vencida: "
        f"el cierre de B-3 suma un punto de barrido en Hoy, no lo reemplaza. Alertas: {tras_listado}"
    )

    # (2) Entrar a Hoy dos veces no duplica nada (dedupe_key por documento).
    for _ in range(2):
        hoy = _today(admin_client, store.id)
    despues = _overdue()
    assert len(despues) == 2, (
        "dos documentos vencidos, dos alertas — una por documento, sin importar cuántas veces "
        f"se abra Hoy o Documentos fiscales: hay {len(despues)}. El `dedupe_key` "
        "`fiscal_contingency_overdue:{document_id}` es lo que lo garantiza"
    )
    claves = {n.dedupe_key for n in despues}
    assert claves == {f"fiscal_contingency_overdue:{doc_a}", f"fiscal_contingency_overdue:{doc_b}"}, claves

    # (3) Y la alerta llega a la banda «Requiere tu atención», una vez por documento.
    vencidas = [a for a in hoy["alerts"] if a["type"] == "fiscal_contingency_overdue"]
    assert len(vencidas) == 2, (
        f"«Requiere tu atención» muestra una alerta por documento vencido: {hoy['alerts']}"
    )

    # (4) Los documentos siguen en contingencia: el barrido avisa, no cambia el estado.
    db.expire_all()
    for doc_id in (doc_a, doc_b):
        fila = db.get(FiscalDocument, doc_id)
        assert fila is not None and fila.dian_status == DianStatus.CONTINGENCY, (
            "barrer el vencimiento no puede mover el estado DIAN del documento: un documento "
            "emitido es inmutable y sólo el proveedor decide su estado (§8.3)"
        )
