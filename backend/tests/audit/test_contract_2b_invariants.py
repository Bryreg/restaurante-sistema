"""Invariantes de CONTRATO del pedido 2b: la jerarquía de costo, la escala
publicada, `format` en los listados, la lectura agregada de consumo, la deuda
declarada de 2a, y que nada nuevo viaje como `float`.

Son los renglones del checklist que no se prueban con un flujo de negocio sino
con el **documento publicado** y con el código: un contrato que dice una cosa y
un servidor que hace otra es un bug que ningún test de comportamiento ve.
"""

from __future__ import annotations

import ast
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from tests.audit.conftest import (
    API_V1,
    NO_TIP,
    add_items,
    apply_count,
    create_order,
    idem_headers,
    make_ingredient,
    make_supplier,
    open_count,
    pay,
    post_reception,
    put_recipe,
    reception_line,
    save_count_lines,
    send,
)

API = API_V1
APP_DIR = Path(__file__).resolve().parents[2] / "app"


def _ingredient(admin_client: Any, store: Any, ingredient_id: int) -> dict[str, Any]:
    rows = admin_client.get(f"{API}/admin/ingredients?store_id={store.id}").json()
    return next(r for r in rows if r["id"] == ingredient_id)


# ---------------------------------------------------------------------------
# (a) Los CINCO escalones de la jerarquía de costo (§4.1), uno por test.
# ---------------------------------------------------------------------------


def test_rung_5_with_nothing_the_cost_is_null_with_source_none_never_zero(
    admin_client: Any, store: Any
) -> None:
    ing = make_ingredient(admin_client, store, name="Sin nada", official_cost=None, min_stock="1000")
    fila = _ingredient(admin_client, store, ing["id"])
    assert fila["cost"] is None, f"un insumo sin costo publicó {fila['cost']!r}"
    assert fila["cost"] != 0 and fila["cost"] != "0"
    assert fila["cost_source"] == "none"


def test_rung_4_with_only_an_estimate_the_source_is_estimated(admin_client: Any, store: Any) -> None:
    ing = make_ingredient(
        admin_client, store, name="Sólo estimado", official_cost=None, estimated_cost="7", min_stock="1000"
    )
    fila = _ingredient(admin_client, store, ing["id"])
    assert fila["cost_source"] == "estimated", fila
    assert fila["cost"] == "7", fila


def test_rung_3_without_purchases_since_the_last_full_count_the_last_purchase_rules(
    admin_client: Any, store: Any, db: Any, clock: Any
) -> None:
    """«sin compras desde el último conteo completo manda la última compra».

    Es el escalón que sólo se puede probar con un conteo completo APLICADO en
    el medio: la compra queda del lado viejo del corte, así que el promedio
    ponderado no tiene con qué calcularse y la jerarquía baja un escalón sin
    caer hasta `estimated`.
    """
    ing = make_ingredient(
        admin_client, store, name="Compra vieja", official_cost=None, estimated_cost="1", min_stock="1000"
    )
    supplier = make_supplier(admin_client, store)

    clock.set(datetime(2026, 1, 16, 12, 0, tzinfo=timezone.utc))
    post_reception(
        admin_client, store, [reception_line(ing["id"], qty_received="1000", purchase_unit_price="12000", tax_amount=0, tax_base=0, tax_rate=0)],
        supplier_id=supplier["id"], invoice_date="2026-01-16", confirm_price=True,
    )
    antes = _ingredient(admin_client, store, ing["id"])
    assert antes["cost_source"] == "weighted_average", f"con una compra reciente manda el promedio: {antes}"

    # Un conteo completo aplicado CORTA la ventana del promedio.
    clock.set(datetime(2026, 1, 17, 12, 0, tzinfo=timezone.utc))
    count = open_count(admin_client, store, scope="full")
    save_count_lines(admin_client, store, count["id"], [{"ingredient_id": ing["id"], "qty_counted": "900", "was_counted": True}])
    apply_count(admin_client, store, count["id"])

    despues = _ingredient(admin_client, store, ing["id"])
    assert despues["cost_source"] == "last_purchase", (
        f"con la única compra ANTERIOR al último conteo completo, la jerarquía tiene que caer a "
        f"`last_purchase`, no a `{despues['cost_source']}`"
    )
    assert despues["cost"] == antes["cost"], "el valor de la última compra cambió al cambiar de escalón"
    assert despues["cost"] != "1", "cayó hasta `estimated` saltándose `last_purchase`"


def test_rung_2_without_an_official_cost_the_weighted_average_rules(
    admin_client: Any, store: Any, clock: Any
) -> None:
    ing = make_ingredient(admin_client, store, name="Promediado", official_cost=None, min_stock="1000")
    supplier = make_supplier(admin_client, store)
    clock.set(datetime(2026, 1, 16, 12, 0, tzinfo=timezone.utc))
    post_reception(
        admin_client, store, [reception_line(ing["id"], qty_received="1000", purchase_unit_price="10000", tax_amount=0, tax_base=0, tax_rate=0)],
        supplier_id=supplier["id"], invoice_date="2026-01-16",
    )
    clock.set(datetime(2026, 1, 17, 12, 0, tzinfo=timezone.utc))
    post_reception(
        admin_client, store, [reception_line(ing["id"], qty_received="3000", purchase_unit_price="11000", tax_amount=0, tax_base=0, tax_rate=0)],
        supplier_id=supplier["id"], invoice_date="2026-01-17", confirm_price=True,
    )

    fila = _ingredient(admin_client, store, ing["id"])
    assert fila["cost_source"] == "weighted_average", fila
    # (1.000 × $10 + 3.000 × $11) ÷ 4.000 = $10,75 — ponderado, no promedio simple.
    assert fila["cost"] == "10.75", f"el promedio no está ponderado por cantidad: {fila['cost']}"


def test_rung_1_with_an_official_cost_the_average_never_rules(
    admin_client: Any, store: Any, clock: Any
) -> None:
    """«con oficial puesto el promedio no manda»: el costo oficial lo fija el
    dueño y pisa cualquier derivado."""
    ing = make_ingredient(admin_client, store, name="Con oficial", official_cost="100", min_stock="1000")
    supplier = make_supplier(admin_client, store)
    clock.set(datetime(2026, 1, 16, 12, 0, tzinfo=timezone.utc))
    post_reception(
        admin_client, store, [reception_line(ing["id"], qty_received="1000", purchase_unit_price="100000", tax_amount=0, tax_base=0, tax_rate=0)],
        supplier_id=supplier["id"], invoice_date="2026-01-16",
    )
    fila = _ingredient(admin_client, store, ing["id"])
    assert fila["cost_source"] == "official", fila
    assert fila["cost"] == "100", fila


def test_a_purchase_before_the_last_full_count_does_not_move_the_average(
    admin_client: Any, store: Any, db: Any, clock: Any
) -> None:
    """Checklist 2b: «El promedio ponderado se calcula **desde el último
    conteo completo**: una compra anterior a ese conteo no lo mueve»."""
    from app.inventory import hooks as inventory_hooks

    ing = make_ingredient(admin_client, store, name="Arroz", official_cost=None, min_stock="1000")
    supplier = make_supplier(admin_client, store)

    clock.set(datetime(2026, 1, 16, 12, 0, tzinfo=timezone.utc))
    post_reception(
        admin_client, store, [reception_line(ing["id"], qty_received="1000", purchase_unit_price="10000", tax_amount=0, tax_base=0, tax_rate=0)],
        supplier_id=supplier["id"], invoice_date="2026-01-16",
    )

    clock.set(datetime(2026, 1, 17, 12, 0, tzinfo=timezone.utc))
    count = open_count(admin_client, store, scope="full")
    save_count_lines(admin_client, store, count["id"], [{"ingredient_id": ing["id"], "qty_counted": "1000", "was_counted": True}])
    apply_count(admin_client, store, count["id"])

    clock.set(datetime(2026, 1, 18, 12, 0, tzinfo=timezone.utc))
    post_reception(
        admin_client, store, [reception_line(ing["id"], qty_received="1000", purchase_unit_price="20000", tax_amount=0, tax_base=0, tax_rate=0)],
        supplier_id=supplier["id"], invoice_date="2026-01-18", confirm_price=True,
    )

    db.expire_all()
    promedio = inventory_hooks.weighted_average_cost_micros(db, store_id=store.id, ingredient_id=ing["id"])
    from app.core.quantity import COST_SCALE

    assert promedio == 20 * COST_SCALE, (
        f"el promedio es {promedio} micros: la compra ANTERIOR al conteo completo sigue empujándolo "
        f"(si promediara las dos daría {15 * COST_SCALE})"
    )


# ---------------------------------------------------------------------------
# (b) La lectura agregada de consumo: agrega al leer, no fusiona al escribir.
# ---------------------------------------------------------------------------


def test_the_order_consumption_read_aggregates_while_the_ledger_keeps_one_row_per_item(
    admin_client: Any, store: Any, db: Any, device_client: Any, identify: Any,
    employees: Any, open_shift: Any, sales_products: Any,
) -> None:
    """Checklist 2b: «`GET /admin/orders/{id}/consumption` da **un renglón por
    insumo** sumando las filas por ítem, y el libro sigue guardando una fila
    por ítem (test: la lectura agrega, la escritura no fusiona)».

    Es la corrección a §5.3 hecha realidad: el libro tiene que poder desarmar
    qué consumió cada ítem (para revertir una nota «vuelve» y para resolver
    el `waste_stub` de un ítem anulado), así que la fusión es de LECTURA.

    **RONDA 2 — re-apuntado al contrato que sobrevivió.** En la ronda 1 esta
    lectura estaba montada DOS veces (`app/orders/router.py` y
    `app/inventory/router.py`) con semánticas distintas; el orquestador
    resolvió H-2 dejando **la de `app.orders`** y borrando la de
    `app.inventory` entera (esquema, servicio y `tests/inventory/
    test_order_consumption.py`). Este test ahora fija ese contrato, campo por
    campo, para que la mitad que se borró no vuelva por la ventana:

    - **sin `store_id` en la ruta** (ni en el path ni en la query): la sede
      sale de `order.store_id`, que es la única que puede estar bien;
    - `qty_base` es **texto decimal** (`app.core.quantity.format_qty_base`),
      nunca milésimas crudas, y **puede ser negativo** — las filas de venta
      son salidas;
    - `cost` es **entero de pesos** o `None` (nunca un `0` mudo, nunca un
      texto), y viene con `cost_source`;
    - hay `unit` y **no** hay `item_count`: `item_count` era del esquema
      borrado, y si reaparece es que alguien resucitó la implementación que
      se descartó.
    """
    from sqlalchemy import select

    from app.inventory.models import MovementCause, StockMovement
    from app.orders.models import OrderItem

    ing = make_ingredient(admin_client, store, name="Arroz", official_cost="5", min_stock="100")
    put_recipe(admin_client, sales_products["inc8"].id, [{"ingredient_id": ing["id"], "qty": "100", "unit": "g"}])
    put_recipe(admin_client, sales_products["iva19"].id, [{"ingredient_id": ing["id"], "qty": "50", "unit": "g"}])

    open_shift()
    identify(device_client, employees["operator"])
    order = create_order(device_client, channel="counter").json()
    order = add_items(
        device_client,
        order,
        [{"product_id": sales_products["inc8"].id, "qty": 1}, {"product_id": sales_products["iva19"].id, "qty": 1}],
    ).json()
    assert send(device_client, order).status_code == 200

    items = list(db.execute(select(OrderItem).where(OrderItem.order_id == order["id"])).scalars())
    assert len(items) == 2, "el caso no se armó: hacen falta dos ítems del MISMO insumo"

    # El LIBRO: una fila por `order_item`, atribuida y desarmable.
    filas = list(
        db.execute(
            select(StockMovement).where(
                StockMovement.store_id == store.id,
                StockMovement.ingredient_id == ing["id"],
                StockMovement.cause == MovementCause.SALE,
            )
        ).scalars()
    )
    assert len(filas) == 2, f"el libro fusionó los dos ítems en {len(filas)} fila(s): deja de ser desarmable"
    assert {f.ref_id for f in filas} == {i.id for i in items}
    assert all(f.ref_type == "order_item" for f in filas)

    # La LECTURA: un renglón por insumo, sumando las dos filas, SIN `store_id`.
    resp = admin_client.get(f"{API}/admin/orders/{order['id']}/consumption")
    assert resp.status_code == 200, (
        "la lectura agregada exige `store_id`: la sede sale de `order.store_id`, no del llamador — "
        f"{resp.status_code} {resp.text}"
    )
    body = resp.json()
    assert body["order_id"] == order["id"]
    del_insumo = [r for r in body["rows"] if r.get("ingredient_id") == ing["id"]]
    assert len(del_insumo) == 1, f"la lectura no agregó: {body['rows']}"
    fila = del_insumo[0]

    # Forma del contrato que sobrevivió (`app.orders.schemas.OrderConsumptionRowOut`).
    assert "item_count" not in fila, (
        "`item_count` es del esquema de `app.inventory` que el orquestador borró al resolver H-2: "
        f"si volvió, hay dos implementaciones otra vez — {sorted(fila)}"
    )
    assert "unit" in fila and isinstance(fila["unit"], str) and fila["unit"], f"falta `unit`: {sorted(fila)}"
    assert isinstance(fila["qty_base"], str), (
        f"`qty_base` viaja como {type(fila['qty_base']).__name__}: el contrato es TEXTO decimal, "
        "nunca milésimas crudas (deuda A-5 de 2a, cerrada en este pedido)"
    )
    assert fila["qty_base"].lstrip("-").replace(".", "").isdigit(), f"`qty_base` no es decimal: {fila['qty_base']!r}"
    assert float(fila["qty_base"]) < 0, (
        f"`qty_base` salió {fila['qty_base']}: las filas de venta son SALIDAS y el neto de esta comanda "
        "tiene que ser negativo — un valor absoluto acá esconde el signo del libro"
    )
    assert fila["cost"] is None or (
        isinstance(fila["cost"], int) and not isinstance(fila["cost"], bool)
    ), f"`cost` viaja como {type(fila['cost']).__name__}: enteros de pesos o `null`, nunca texto ni float"
    assert fila["cost"] != 0, "`cost` cero mudo: con costo oficial puesto tiene que haber plata (§4.1)"
    assert fila["cost_source"] == "official"

    total = sum(f.qty_base for f in filas)
    assert round(float(fila["qty_base"]) * 1000) == total, (
        f"la lectura agregada publica {fila['qty_base']} y el libro suma {total} milésimas"
    )


def test_the_order_consumption_read_sums_sale_and_note_return_with_the_frozen_cost(
    admin_client: Any, store: Any, db: Any, device_client: Any, identify: Any,
    employees: Any, open_shift: Any, sales_products: Any,
) -> None:
    """**RONDA 2, invariante nuevo**: las dos mitades del contrato de
    `app.orders.service.order_consumption` que ningún test de la ronda 1
    tocaba, y que son justamente las que distinguían la implementación que
    sobrevivió de la que se borró.

    1. **Suma `SALE` + `NOTE_RETURN`**, no sólo `SALE`. La versión de
       `app.inventory` que el orquestador descartó filtraba por
       `cause == SALE`: con una nota «vuelve» de por medio, publicaba el
       consumo COMO SI el plato no hubiera vuelto. El consumo de una comanda
       es el NETO, y si la nota revirtió todo el renglón tiene que decir
       `0`, que no es lo mismo que decir lo que se descontó al enviar.
    2. **El costo es el CONGELADO del libro**, nunca el de hoy. Cambio el
       costo oficial del insumo ×10 DESPUÉS de vender y vuelvo a leer: si
       alguien revalorara con `resolve_ingredient_cost`, este test se pone
       rojo. Es la regla dura del snapshot aplicada a la lectura agregada —
       la misma que ya protege `unit_cost` en el ítem.
    """
    from sqlalchemy import select

    from app.inventory.models import MovementCause, StockMovement

    ing = make_ingredient(admin_client, store, name="Arroz", official_cost="5", min_stock="100")
    put_recipe(admin_client, sales_products["inc8"].id, [{"ingredient_id": ing["id"], "qty": "1000", "unit": "g"}])

    open_shift()
    identify(device_client, employees["operator"])
    order = create_order(device_client, channel="counter").json()
    order = add_items(device_client, order, [{"product_id": sales_products["inc8"].id, "qty": 1}]).json()
    assert send(device_client, order).status_code == 200

    def leer() -> dict[str, Any]:
        resp = admin_client.get(f"{API}/admin/orders/{order['id']}/consumption")
        assert resp.status_code == 200, resp.text
        filas = [r for r in resp.json()["rows"] if r.get("ingredient_id") == ing["id"]]
        assert len(filas) == 1, f"la lectura no agregó en un solo renglón: {resp.json()['rows']}"
        return filas[0]

    tras_enviar = leer()
    costo_congelado = tras_enviar["cost"]
    assert costo_congelado is not None and costo_congelado != 0
    assert float(tras_enviar["qty_base"]) < 0

    # (2) El costo del insumo cambia DESPUÉS de la venta: la lectura no se mueve.
    subida = admin_client.patch(
        f"{API}/admin/ingredients/{ing['id']}?store_id={store.id}", json={"official_cost": "50"}
    )
    assert subida.status_code == 200, subida.text
    tras_subir = leer()
    assert tras_subir["cost"] == costo_congelado, (
        f"la lectura agregada REVALORÓ la comanda: publicaba {costo_congelado} y después de subir el costo "
        f"oficial ×10 publica {tras_subir['cost']}. El costo de una venta pasada es el que `record_movement` "
        "congeló en el movimiento (`cost_micros`/`cost_source`), nunca el de hoy (regla dura: snapshot)"
    )
    assert tras_subir["cost_source"] == tras_enviar["cost_source"]

    # (1) Una nota «vuelve» escribe `NOTE_RETURN`, y el neto lo refleja.
    identify(device_client, employees["cashier"])
    cobro = pay(
        device_client,
        order["id"],
        splits=[{"method": "cash", "amount": order["totals"]["total"]}],
        tip=NO_TIP,
    )
    assert cobro.status_code == 201, cobro.text
    doc_id = cobro.json()["document"]["id"]
    printable = admin_client.get(f"{API}/documents/{doc_id}")
    assert printable.status_code == 200, printable.text
    nota = admin_client.post(
        f"{API}/admin/documents/{doc_id}/notes",
        json={
            "kind": "adjustment",
            "reason": "El plato volvió entero a la cocina",
            "lines": [{"item_id": line["item_id"], "used": True, "returns_to_stock": True}
                      for line in printable.json()["lines"]],
        },
        headers=idem_headers(),
    )
    assert nota.status_code in (200, 201), nota.text

    devoluciones = list(
        db.execute(
            select(StockMovement).where(
                StockMovement.store_id == store.id,
                StockMovement.ingredient_id == ing["id"],
                StockMovement.cause == MovementCause.NOTE_RETURN,
            )
        ).scalars()
    )
    assert devoluciones, "el caso no se armó: la nota «vuelve» no escribió ninguna fila `note_return`"

    tras_nota = leer()
    assert float(tras_nota["qty_base"]) == 0.0, (
        f"la lectura agregada publica {tras_nota['qty_base']} después de una nota que revirtió TODO el "
        "renglón: está sumando sólo `sale` y no `note_return`, así que reporta un consumo que ya no existe "
        "(es el filtro que tenía la implementación descartada en H-2)"
    )


def test_the_order_consumption_operation_is_published_exactly_once(client: Any) -> None:
    """**RONDA 2, invariante nuevo (cierra H-2 en las dos direcciones).**

    En la ronda 1 `GET /admin/orders/{order_id}/consumption` estaba montada
    dos veces: despachaba `app.orders` y el OpenAPI publicaba `app.inventory`
    (la segunda ocurrencia del mismo path+método pisa a la primera al armar
    el documento), con `store_id` obligatorio y un cuerpo distinto del
    servido. El orquestador resolvió dejar `app.orders`.

    Este test fija las tres cosas que impiden que vuelva a pasar:

    1. **La ruta está registrada UNA sola vez** en el árbol real de FastAPI
       (`iter_api_routes`, que baja por `original_router.routes` porque
       FastAPI no clona las rutas al `include_router`).
    2. **Generar el OpenAPI no levanta ningún `UserWarning`** — en
       particular `Duplicate Operation ID`, que es el aviso que la ronda 1
       emitía en cada corrida que tocara el documento y que nadie leía
       porque los warnings no rompen nada. Acá sí rompe.
    3. **La operación publicada es la que se sirve**: viene de
       `app.orders.router`, no declara `store_id` como parámetro, y su
       esquema de respuesta trae `unit` y no trae `item_count`.
    """
    import warnings

    from app.main import app as fastapi_app

    from tests.audit.conftest import iter_api_routes

    ruta = f"{API}/admin/orders/{{order_id}}/consumption"
    registros = [(p, sorted(r.methods), r.endpoint.__module__) for p, r in iter_api_routes() if p == ruta]
    assert len(registros) == 1, (
        "la lectura agregada de consumo está montada más de una vez: "
        + "; ".join(f"{m} desde {mod}" for _, m, mod in registros)
    )
    assert registros[0][2] == "app.orders.router", (
        f"la lectura agregada se sirve desde {registros[0][2]}: la decisión de H-2 fue que sobrevive la "
        "implementación de `app.orders` (costo congelado, `SALE + NOTE_RETURN`)"
    )

    previo = fastapi_app.openapi_schema
    fastapi_app.openapi_schema = None
    try:
        with warnings.catch_warnings(record=True) as capturados:
            warnings.simplefilter("always")
            spec = fastapi_app.openapi()
        duplicados = [str(w.message) for w in capturados if "Duplicate Operation ID" in str(w.message)]
        assert not duplicados, (
            "generar el OpenAPI sigue emitiendo `Duplicate Operation ID` — dos rutas comparten path+método y "
            f"el documento publica una mientras el servidor sirve la otra: {duplicados}"
        )
    finally:
        fastapi_app.openapi_schema = previo

    item = spec["paths"].get(ruta)
    assert item is not None, f"{ruta} no está publicada en el OpenAPI"
    parametros = {p["name"] for p in item["get"].get("parameters", [])}
    assert "store_id" not in parametros, (
        "el contrato publicado exige `store_id`: ése era el de `app.inventory`, el que se borró. La sede "
        f"sale de `order.store_id` — parámetros publicados: {sorted(parametros)}"
    )
    from tests.audit.conftest import openapi_properties_reachable_from

    propiedades = {prop for _, prop in openapi_properties_reachable_from(spec, {ruta})}
    assert "unit" in propiedades, f"el esquema publicado no trae `unit`: {sorted(propiedades)}"
    assert "item_count" not in propiedades, (
        "el esquema publicado trae `item_count`: es el de `app.inventory`, que el orquestador borró al "
        f"resolver H-2 — {sorted(propiedades)}"
    )


# ---------------------------------------------------------------------------
# (c) La deuda declarada de 2a que 2b cierra.
# ---------------------------------------------------------------------------


def test_the_waste_over_purchases_kpi_stops_being_null_and_is_not_a_float(
    admin_client: Any, store: Any, db: Any, device_client: Any, identify: Any, employees: Any, open_shift: Any
) -> None:
    """Checklist 2b: «Mermas ÷ compras deja de ser `null` con compras en el
    período, sigue `null` sin ellas, y **no es un `float`**» (deuda O-6 de
    `outputs-2a/ENTREGA.md § 5`)."""
    from app.inventory.schemas import WasteKpiOut

    anotacion = WasteKpiOut.model_fields["ratio"].annotation
    assert "float" not in str(anotacion), f"el KPI de mermas sigue declarando `{anotacion}`"

    ing = make_ingredient(admin_client, store, name="Arroz", official_cost="5", min_stock="100")
    open_shift()
    identify(device_client, employees["operator"])
    merma = device_client.post(
        f"{API}/waste",
        headers=idem_headers(),
        json={"ingredient_id": ing["id"], "qty": "100", "type": "breakage", "employee_pin": "2222"},
    )
    assert merma.status_code == 201, merma.text

    sin_compras = admin_client.get(f"{API}/admin/waste?store_id={store.id}").json()["weekly_kpi"]
    assert sin_compras["ratio"] is None, f"sin compras el KPI tiene que ser `null`, no {sin_compras['ratio']!r}"
    assert sin_compras["ratio"] != 0
    assert sin_compras["label"], "el `null` vino sin etiqueta legible"

    supplier = make_supplier(admin_client, store)
    post_reception(
        admin_client, store, [reception_line(ing["id"], qty_received="1000", purchase_unit_price="10000", tax_amount=0, tax_base=0, tax_rate=0)],
        supplier_id=supplier["id"], confirm_price=True,
    )
    con_compras = admin_client.get(f"{API}/admin/waste?store_id={store.id}").json()["weekly_kpi"]
    assert con_compras["ratio"] is not None, "con compras en el período el KPI sigue siendo `null`"
    assert isinstance(con_compras["ratio"], int) and not isinstance(con_compras["ratio"], bool), (
        f"el KPI viaja como {type(con_compras['ratio']).__name__}: tiene que ser entero (puntos básicos)"
    )


def test_void_after_send_is_gone_from_the_enum_and_from_the_published_literal() -> None:
    """Checklist 2b: «`MovementCause.VOID_AFTER_SEND` **se produce o se
    saca**: hoy está declarada y nunca se emite, así que un reporte de merma
    por anulación agrupado por causa devuelve vacío».

    **RONDA 2 — el invariante cambió de enunciado por decisión del
    orquestador (H-3), no de severidad.** En la ronda 1 este test exigía
    «una de las dos salidas» y quedó rojo porque no se tomó ninguna. La
    decisión tomada fue **sacarla**, y el invariante correcto a partir de
    ahora es más simple y más estricto: la causa no existe en el enum, no
    existe en el `Literal` publicado, y **nadie la produce**.

    Por qué sacarla y no producirla (queda escrito acá porque es donde se
    va a leer el día que alguien la quiera devolver): producirla exigiría un
    par alta+baja que se cancela en el saldo agregado, y desde 2b la mitad
    negativa dispararía una **segunda depleción FEFO real** de
    `StockBatch.qty_remaining` (`app/inventory/hooks.py`) sobre cantidad que
    ya se consumió al vender. El saldo del libro quedaría exacto y la
    contabilidad por lote quedaría corrompida — que es peor que no tener la
    causa. El razonamiento vive en `app/orders/service.py::
    _resolve_waste_stub` y lo fija `tests/orders/test_consumption.py::
    test_void_after_send_writes_no_new_movement_and_the_cause_is_gone_from_the_enum`
    (territorio de `backend-lectura-contrato`).

    Qué deja de estar cubierto: nada. La merma por anulación después de
    enviar sigue existiendo y sigue siendo legible — se lee del
    `waste_stub` del ítem, no de una causa del libro. Lo que se perdió es
    una promesa que el contrato no cumplía.

    Este test es el guard de la decisión en las dos direcciones: si alguien
    vuelve a declararla sin producirla, se pone rojo otra vez.
    """
    from typing import get_args

    from app.inventory.models import MovementCause
    from app.inventory.schemas import MovementCauseLiteral

    assert not hasattr(MovementCause, "VOID_AFTER_SEND"), (
        "`MovementCause.VOID_AFTER_SEND` volvió al enum. Se sacó en la ronda 2 de 2b (H-3) porque estaba "
        "declarada y nunca se producía. Si ahora hay quien la escriba, hay que reintroducirla en el enum, "
        "en `MovementCauseLiteral` y en el productor, en el mismo pedido — nunca sólo en el enum"
    )
    valores = {c.value for c in MovementCause}
    assert "void_after_send" not in valores, f"el valor `void_after_send` sigue en el enum: {sorted(valores)}"
    publicadas = set(get_args(MovementCauseLiteral))
    assert "void_after_send" not in publicadas, (
        f"`MovementCauseLiteral` (el contrato publicado) sigue declarando `void_after_send`: {sorted(publicadas)}"
    )
    # Y nadie la produce: un barrido de texto sobre todo `app/` que caza el
    # regreso por la puerta de atrás (una constante, un `getattr`, un string
    # crudo pasado como causa). Los comentarios que EXPLICAN por qué se sacó
    # están permitidos; una referencia ejecutable, no.
    import ast

    from tests.audit.conftest import app_source_files

    ofensores: list[str] = []
    for ruta, arbol in app_source_files():
        for nodo in ast.walk(arbol):
            if isinstance(nodo, ast.Attribute) and nodo.attr == "VOID_AFTER_SEND":
                ofensores.append(f"{ruta}:{nodo.lineno}")
            elif isinstance(nodo, ast.Constant) and nodo.value == "void_after_send":
                ofensores.append(f"{ruta}:{nodo.lineno}")
    assert not ofensores, f"`void_after_send` volvió a aparecer como código ejecutable en app/: {ofensores}"


# ---------------------------------------------------------------------------
# (d) Una sola escala publicada, `format` en todo listado, y nada `float`.
# ---------------------------------------------------------------------------


def test_the_same_magnitude_is_never_published_in_two_scales(client: Any) -> None:
    """Checklist 2b: «Una sola escala de cantidad publicada: ningún esquema
    publica milésimas crudas mientras otro publica texto decimal para la misma
    magnitud» (deuda A-5 de `outputs-2a/ENTREGA.md § 5`)."""
    spec = client.get("/openapi.json").json()
    esquemas = spec["components"]["schemas"]

    # Magnitudes de CANTIDAD de insumo: milésimas de la unidad base. El
    # contrato de `app.core.quantity` las publica como TEXTO decimal.
    campos_de_cantidad = (
        "qty_base", "min_stock", "qty_counted", "qty_received", "qty_invoiced", "qty_remaining",
        "opening_qty", "closing_qty", "inflow_qty", "real_usage_qty", "theoretical_usage_qty", "variance_qty",
        "previous_qty_counted", "adjustment", "stock_before", "stock_after",
    )
    crudos: list[str] = []
    for nombre, esquema in esquemas.items():
        for campo, definicion in (esquema.get("properties") or {}).items():
            if campo not in campos_de_cantidad:
                continue
            tipos = {definicion.get("type")} | {
                variante.get("type") for variante in definicion.get("anyOf", []) if isinstance(variante, dict)
            }
            if "integer" in tipos:
                crudos.append(f"{nombre}.{campo}")
    assert not crudos, (
        "estos esquemas publican una cantidad de insumo como entero (milésimas crudas) mientras el resto "
        f"la publica como texto decimal — la pantalla que las pinte va a mostrar «117648 g»: {sorted(crudos)}"
    )


def test_every_listing_that_serves_csv_declares_format_in_the_contract(client: Any) -> None:
    """Checklist 2b: «Todo listado nuevo declara `format` en el contrato, y los
    cinco de 1b-2 que lo leen de `request.query_params` quedan arreglados».

    La spec dice «cinco»; el barrido no cuenta de memoria: recorre `app/`,
    encuentra CADA endpoint que llama `wants_csv(request)` y comprueba que su
    ruta declare `format` en el OpenAPI. Así el invariante sigue valiendo
    cuando aparezca el sexto.
    """
    sirven_csv: list[tuple[str, str]] = []
    for archivo in sorted(APP_DIR.rglob("router.py")):
        arbol = ast.parse(archivo.read_text(encoding="utf-8"), filename=str(archivo))
        for nodo in ast.walk(arbol):
            if not isinstance(nodo, ast.FunctionDef):
                continue
            usa_csv = any(
                isinstance(sub, ast.Call)
                and isinstance(sub.func, ast.Name)
                and sub.func.id == "wants_csv"
                for sub in ast.walk(nodo)
            )
            if not usa_csv:
                continue
            declara = any(a.arg == "format" for a in nodo.args.args + nodo.args.kwonlyargs)
            sirven_csv.append((f"{archivo.relative_to(APP_DIR.parent)}::{nodo.name}", "sí" if declara else "no"))

    assert len(sirven_csv) >= 20, f"el barrido encontró sólo {len(sirven_csv)} endpoints con CSV: algo se rompió"
    sin_declarar = [nombre for nombre, declara in sirven_csv if declara == "no"]
    assert not sin_declarar, (
        f"{len(sin_declarar)} de {len(sirven_csv)} endpoints sirven `format=csv` sin declararlo en su firma "
        f"(y por lo tanto sin publicarlo en el OpenAPI): {sin_declarar}"
    )


def test_no_new_model_or_schema_of_2b_declares_a_float(client: Any) -> None:
    """Checklist 2b: «Cantidades sin `float` en todo lo nuevo». Barrido de
    anotaciones sobre los modelos y esquemas de `purchases` e `inventory`: un
    `float` filtrado en un campo es un `0.1 + 0.2` esperando a pasar."""
    import app.inventory.models as inv_models
    import app.inventory.schemas as inv_schemas
    import app.purchases.models as pur_models
    import app.purchases.schemas as pur_schemas

    from pydantic import BaseModel

    culpables: list[str] = []
    for modulo in (pur_schemas, inv_schemas):
        for nombre in dir(modulo):
            objeto = getattr(modulo, nombre)
            if not (isinstance(objeto, type) and issubclass(objeto, BaseModel) and objeto is not BaseModel):
                continue
            for campo, info in objeto.model_fields.items():
                if "float" in str(info.annotation):
                    culpables.append(f"{modulo.__name__}.{nombre}.{campo}: {info.annotation}")

    for modulo in (pur_models, inv_models):
        ruta = Path(str(modulo.__file__))
        arbol = ast.parse(ruta.read_text(encoding="utf-8"), filename=str(ruta))
        for nodo in ast.walk(arbol):
            if isinstance(nodo, ast.AnnAssign) and "Float" in ast.dump(nodo):
                culpables.append(f"{modulo.__name__}:{nodo.lineno}")

    assert not culpables, f"hay `float` en lo nuevo de 2b: {culpables}"

    # Y sobre el documento publicado: ningún campo de cantidad/costo de las
    # rutas nuevas sale como `number`.
    spec = client.get("/openapi.json").json()
    numeros: list[str] = []
    for nombre, esquema in spec["components"]["schemas"].items():
        if not any(t in nombre for t in ("Reception", "Payable", "Payment", "Supplier", "Count", "Variance", "FoodCost", "Lot", "ControlHealth")):
            continue
        for campo, definicion in (esquema.get("properties") or {}).items():
            tipos = {definicion.get("type")} | {
                v.get("type") for v in definicion.get("anyOf", []) if isinstance(v, dict)
            }
            if "number" in tipos:
                numeros.append(f"{nombre}.{campo}")
    assert not numeros, f"el OpenAPI de 2b publica campos como `number` (float de JSON): {sorted(numeros)}"


def test_no_module_writes_a_stock_batch_outside_the_inventory_hooks() -> None:
    """El hermano del barrido de `StockMovement`: desde 2b hay un SEGUNDO
    libro (`StockBatch`, la trazabilidad por lote) y el mismo principio rige.
    `app/inventory/hooks.py` declara ser el único que lo escribe
    (`create_stock_batch`/`reverse_stock_batch`/`consume_lots_fefo`); si
    `purchases` o cualquier otro dominio construye un lote por su cuenta, FEFO
    y el promedio ponderado dejan de tener una sola fuente de verdad."""
    permitido = APP_DIR / "inventory" / "hooks.py"
    culpables: list[str] = []
    for archivo in sorted(APP_DIR.rglob("*.py")):
        if archivo == permitido:
            continue
        arbol = ast.parse(archivo.read_text(encoding="utf-8"), filename=str(archivo))
        for nodo in ast.walk(arbol):
            if isinstance(nodo, ast.Call):
                objetivo = nodo.func
                nombre = (
                    objetivo.id
                    if isinstance(objetivo, ast.Name)
                    else objetivo.attr
                    if isinstance(objetivo, ast.Attribute)
                    else None
                )
                if nombre == "StockBatch":
                    culpables.append(f"{archivo.relative_to(APP_DIR.parent)}:{nodo.lineno}")
    assert not culpables, (
        "alguien construye un `StockBatch` fuera de `app/inventory/hooks.py`: " + ", ".join(culpables)
    )


def test_the_new_2b_causes_are_produced_and_typed(
    admin_client: Any, store: Any, db: Any, clock: Any
) -> None:
    """§5.1 y convenciones de 2b: las causas nuevas (`purchase`,
    `count_adjustment`, `reception_reversal`) se producen de verdad y viajan
    siempre como enum — la causa **no se infiere de un texto**."""
    from sqlalchemy import select

    from app.inventory.models import MovementCause, StockMovement

    ing = make_ingredient(admin_client, store, name="Arroz", official_cost=None, min_stock="100")
    supplier = make_supplier(admin_client, store)

    clock.set(datetime(2026, 1, 16, 12, 0, tzinfo=timezone.utc))
    recepcion = post_reception(
        admin_client, store, [reception_line(ing["id"], qty_received="1000", purchase_unit_price="10000")],
        supplier_id=supplier["id"], invoice_date="2026-01-16",
    )
    clock.set(datetime(2026, 1, 17, 12, 0, tzinfo=timezone.utc))
    reversa = admin_client.request(
        "DELETE", f"{API}/admin/receptions/{recepcion['id']}", json={"authorizer_pin": "9999"}
    )
    assert reversa.status_code == 200, reversa.text

    clock.set(datetime(2026, 1, 18, 12, 0, tzinfo=timezone.utc))
    count = open_count(admin_client, store, scope="full")
    save_count_lines(admin_client, store, count["id"], [{"ingredient_id": ing["id"], "qty_counted": "800", "was_counted": True}])
    apply_count(admin_client, store, count["id"])

    db.expire_all()
    causas = {
        m.cause
        for m in db.execute(select(StockMovement).where(StockMovement.store_id == store.id)).scalars()
    }
    for esperada in (MovementCause.PURCHASE, MovementCause.COUNT_ADJUSTMENT, MovementCause.RECEPTION_REVERSAL):
        assert esperada in causas, f"2b declara `{esperada.value}` y nunca la produce: {sorted(c.value for c in causas)}"


def test_the_ledger_can_be_read_after_a_reception_is_reversed(
    admin_client: Any, store: Any, db: Any, clock: Any
) -> None:
    """**ROJO A PROPÓSITO — BLOQUEANTE: el libro de un insumo deja de poder
    leerse después de revertir una recepción.**

    `app/inventory/models.py:75` declara `MovementCause.RECEPTION_REVERSAL` y
    `app/purchases/service.py:485-499` la **produce** al revertir una
    recepción. Pero `app/inventory/schemas.py:18-30`
    (`MovementCauseLiteral`) se quedó con las once causas de 2a: **no incluye
    `"reception_reversal"`**.

    `StockMovementOut.cause` (`app/inventory/schemas.py:120`) está tipado con
    ese `Literal`, así que en cuanto el libro de un insumo contiene una fila
    de reversa, `GET /admin/ingredients/{id}/movements` no puede serializarla:
    revienta al construir la respuesta. No es una regla de negocio devuelta
    como `400` — es un error de servidor sobre la lectura del **libro**, que
    es la fuente de verdad del inventario, y aparece exactamente después de la
    operación que la spec manda soportar («eliminar una recepción es una
    reversa con causa»).

    Además, el filtro `?cause=` de esa misma ruta usa el mismo `Literal`: no
    hay forma de pedir las reversas aunque existan.

    Lo cazó el invariante heredado
    `tests/audit/test_inventory_invariants.py::test_the_cost_source_of_the_api_is_the_same_enum_as_the_model`,
    que compara el `Literal` publicado contra el enum del modelo — puesto en
    2a precisamente para esto («es el tipo de desfase que no falla en ningún
    test de comportamiento»). Este test es su mitad de comportamiento.

    Se cierra agregando `"reception_reversal"` a `MovementCauseLiteral`.
    """
    ing = make_ingredient(admin_client, store, name="Arroz", official_cost=None, min_stock="100")
    supplier = make_supplier(admin_client, store)

    clock.set(datetime(2026, 1, 16, 12, 0, tzinfo=timezone.utc))
    recepcion = post_reception(
        admin_client, store, [reception_line(ing["id"], qty_received="1000", purchase_unit_price="10000")],
        supplier_id=supplier["id"], invoice_date="2026-01-16",
    )
    antes = admin_client.get(f"{API}/admin/ingredients/{ing['id']}/movements?store_id={store.id}")
    assert antes.status_code == 200, antes.text

    reversa = admin_client.request(
        "DELETE", f"{API}/admin/receptions/{recepcion['id']}", json={"authorizer_pin": "9999"}
    )
    assert reversa.status_code == 200, reversa.text

    despues = admin_client.get(f"{API}/admin/ingredients/{ing['id']}/movements?store_id={store.id}")
    assert despues.status_code == 200, (
        "el libro del insumo dejó de poder leerse después de revertir una recepción "
        f"({despues.status_code}): `MovementCauseLiteral` no declara `reception_reversal`. "
        f"{despues.text[:300]}"
    )
    causas = {fila["cause"] for fila in despues.json()}
    assert "reception_reversal" in causas, f"la reversa no aparece en el libro publicado: {sorted(causas)}"
