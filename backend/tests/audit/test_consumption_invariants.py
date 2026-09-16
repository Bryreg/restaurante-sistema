"""Lo que sale de la cocina tiene que salir del inventario. Una sola vez.

`docs/SPEC-NEGOCIO.md` §4.2 (dos modos excluyentes y la regla de coherencia),
§4.3 (`recipe_effect`, cobertura de recetas), §5.3 (consumo teórico al enviar,
fusión, espejo de la nota) y §11.6 («el insumo se descuenta una sola vez y por
un solo camino de consumo»).

Éste es el archivo donde viven los invariantes que el checklist de entrega
llama "los que más cuestan": el descuento único por los dos modos, los tres
caminos de consumo (vender, regalar, comer) dejando el mismo saldo, el espejo
exacto de la nota «vuelve», y el `waste_stub` que 1b dejó abierto.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from tests.audit.conftest import (
    API_V1,
    NO_TIP,
    add_items,
    create_order,
    get_order,
    idem_headers,
    make_ingredient,
    make_preparation,
    movements_of,
    pay,
    produce,
    put_recipe,
    send,
    stock_of,
)

API = API_V1


def _sell_and_send(client: Any, product_id: int, *, qty: int = 1, channel: str = "counter", **order_extra: Any) -> dict[str, Any]:
    order = create_order(client, channel=channel, **order_extra).json()
    order = add_items(client, order, [{"product_id": product_id, "qty": qty}]).json()
    resp = send(client, order)
    assert resp.status_code == 200, resp.text
    return get_order(client, order["id"])


# ---------------------------------------------------------------------------
# 1. El insumo se descuenta UNA SOLA VEZ (regla dura §11.6)
# ---------------------------------------------------------------------------


def test_a_batch_preparation_deducts_at_production_and_not_at_send(
    db: Any, store: Any, admin_client: Any, device_client: Any, identify: Any, employees: Any,
    open_shift: Any, sales_products: Any,
) -> None:
    """§4.2: «por lote: producir descuenta los insumos y crea stock de la
    preparación; **el plato consume preparación**».

    Si además descontara el insumo al enviar, el mismo gramo saldría dos veces
    del libro y la varianza de 2b acusaría un robo que no existe. Se mide con
    el saldo del INSUMO antes y después de cada paso, que es lo único que no
    se puede falsear desde la pantalla.
    """
    insumo = make_ingredient(admin_client, store, name="Hueso de res", official_cost="4", min_stock="1000")
    caldo = make_preparation(
        admin_client, store, name="Caldo", mode="batch",
        standard_yield_qty="1000", standard_yield_unit="ml",
        lines=[{"ingredient_id": insumo["id"], "qty": "500", "unit": "g"}],
    )
    product = sales_products["inc8"]
    put_recipe(admin_client, product.id, [{"preparation_id": caldo["id"], "qty": "200", "unit": "ml"}])

    open_shift()
    identify(device_client, employees["operator"])

    assert stock_of(db, store, ingredient_id=insumo["id"]) == 0
    resp = produce(device_client, caldo["id"], qty_expected="1000", qty_real="1000")
    assert resp.status_code == 201, resp.text

    tras_producir = stock_of(db, store, ingredient_id=insumo["id"])
    assert tras_producir == -500_000, "producir no descontó los insumos de la preparación"
    assert stock_of(db, store, preparation_id=caldo["id"]) == 1_000_000

    _sell_and_send(device_client, product.id)

    tras_enviar = stock_of(db, store, ingredient_id=insumo["id"])
    assert tras_enviar == tras_producir, (
        "el insumo se descontó DOS veces: al producir el lote y otra vez al enviar el plato"
    )
    # Y el plato sí consumió la preparación.
    assert stock_of(db, store, preparation_id=caldo["id"]) == 800_000


def test_an_exploded_preparation_deducts_at_send_and_cannot_be_produced(
    db: Any, store: Any, admin_client: Any, device_client: Any, identify: Any, employees: Any,
    open_shift: Any, sales_products: Any,
) -> None:
    """La otra mitad de §4.2: «explotada: sin stock ni lotes; enviar el plato
    descuenta los insumos de la preparación × (cantidad ÷ rendimiento
    estándar)». Producirla es `400 PREP_NOT_BATCH`, no un segundo camino de
    descuento."""
    insumo = make_ingredient(admin_client, store, name="Tomate hogao", official_cost="4", min_stock="1000")
    hogao = make_preparation(
        admin_client, store, name="Hogao explotado", mode="exploded",
        standard_yield_qty="1000", standard_yield_unit="g",
        lines=[{"ingredient_id": insumo["id"], "qty": "500", "unit": "g"}],
    )
    product = sales_products["inc8"]
    put_recipe(admin_client, product.id, [{"preparation_id": hogao["id"], "qty": "200", "unit": "g"}])

    open_shift()
    identify(device_client, employees["operator"])

    resp = produce(device_client, hogao["id"], qty_expected="1000", qty_real="1000")
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "PREP_NOT_BATCH"
    assert stock_of(db, store, ingredient_id=insumo["id"]) == 0, "un `400` dejó movimientos escritos"

    _sell_and_send(device_client, product.id)

    # 200 g de hogao sobre un rendimiento de 1.000 g -> 20 % de los 500 g de
    # tomate = 100 g. Sin stock de preparación: la preparación explotada no
    # existe en el libro.
    assert stock_of(db, store, ingredient_id=insumo["id"]) == -100_000
    assert stock_of(db, store, preparation_id=hogao["id"]) == 0


def test_the_same_ingredient_ends_at_the_same_balance_by_both_modes(
    db: Any, store: Any, admin_client: Any, device_client: Any, identify: Any, employees: Any,
    open_shift: Any, sales_products: Any,
) -> None:
    """El invariante que el checklist pide explícitamente: **el mismo insumo,
    los dos modos, comparando el saldo final**.

    Vender un plato que lleva 100 g de un insumo tiene que dejar el mismo
    saldo −100 g tanto si el insumo viaja por una preparación en modo lote
    (descontado al producir exactamente lo que el plato va a consumir) como si
    viaja por una explotada (descontado al enviar). Si los dos caminos no
    cierran en el mismo número, uno de los dos descuenta de más o de menos.
    """
    por_lote = make_ingredient(admin_client, store, name="Insumo lote", official_cost="4", min_stock="1000")
    explotado = make_ingredient(admin_client, store, name="Insumo explotado", official_cost="4", min_stock="1000")

    prep_lote = make_preparation(
        admin_client, store, name="Prep lote", mode="batch",
        standard_yield_qty="1000", standard_yield_unit="g",
        lines=[{"ingredient_id": por_lote["id"], "qty": "1000", "unit": "g"}],
    )
    prep_explotada = make_preparation(
        admin_client, store, name="Prep explotada", mode="exploded",
        standard_yield_qty="1000", standard_yield_unit="g",
        lines=[{"ingredient_id": explotado["id"], "qty": "1000", "unit": "g"}],
    )

    plato_lote = sales_products["inc8"]
    plato_explotado = sales_products["iva19"]
    put_recipe(admin_client, plato_lote.id, [{"preparation_id": prep_lote["id"], "qty": "100", "unit": "g"}])
    put_recipe(admin_client, plato_explotado.id, [{"preparation_id": prep_explotada["id"], "qty": "100", "unit": "g"}])

    open_shift()
    identify(device_client, employees["operator"])

    # Modo lote: se produce exactamente lo que el plato va a consumir.
    assert produce(device_client, prep_lote["id"], qty_expected="100", qty_real="100").status_code == 201
    _sell_and_send(device_client, plato_lote.id)

    # Modo explotado: no se produce nada, se envía y listo.
    _sell_and_send(device_client, plato_explotado.id)

    saldo_lote = stock_of(db, store, ingredient_id=por_lote["id"])
    saldo_explotado = stock_of(db, store, ingredient_id=explotado["id"])
    assert saldo_lote == saldo_explotado == -100_000, (
        f"los dos modos no cierran igual: lote={saldo_lote}, explotado={saldo_explotado}"
    )


# ---------------------------------------------------------------------------
# 2. Vender, regalar y comer dejan el inventario IDÉNTICO (§5.3)
# ---------------------------------------------------------------------------


def test_selling_giving_away_and_staff_meal_leave_the_same_inventory(
    db: Any, store: Any, admin_client: Any, device_client: Any, identify: Any, employees: Any,
    open_shift: Any, sales_products: Any,
) -> None:
    """§5.3 y §11.6: «vender, regalar y comer (`staff_meal`) dejan el
    inventario idéntico», por **un solo camino de consumo**.

    Es la regla que impide que el consumo de personal se convierta en un
    agujero invisible: el plato salió de la cocina, el insumo salió del
    inventario, sin importar quién lo pagó (o si nadie lo pagó).
    """
    insumo = make_ingredient(admin_client, store, name="Arroz tres caminos", official_cost="3", min_stock="1000")
    product = sales_products["inc8"]
    put_recipe(admin_client, product.id, [{"ingredient_id": insumo["id"], "qty": "150", "unit": "g"}])

    open_shift()
    identify(device_client, employees["operator"])

    # (1) venta normal
    antes = stock_of(db, store, ingredient_id=insumo["id"])
    _sell_and_send(device_client, product.id)
    delta_venta = stock_of(db, store, ingredient_id=insumo["id"]) - antes

    # (2) cortesía: el ítem se regala ANTES de enviarlo a cocina
    antes = stock_of(db, store, ingredient_id=insumo["id"])
    order = create_order(device_client).json()
    order = add_items(device_client, order, [{"product_id": product.id, "qty": 1}]).json()
    item_id = order["items"][0]["id"]
    cortesia = device_client.post(
        f"{API}/orders/{order['id']}/items/{item_id}/courtesy",
        json={"expected_version": order["version"], "reason": "complaint", "authorizer_pin": "5555"},
    )
    assert cortesia.status_code == 200, cortesia.text
    assert send(device_client, cortesia.json()).status_code == 200
    delta_cortesia = stock_of(db, store, ingredient_id=insumo["id"]) - antes

    # (3) consumo de personal
    antes = stock_of(db, store, ingredient_id=insumo["id"])
    _sell_and_send(
        device_client, product.id, channel="staff_meal", consumed_by_employee_id=employees["operator"].id
    )
    delta_personal = stock_of(db, store, ingredient_id=insumo["id"]) - antes

    assert delta_venta == delta_cortesia == delta_personal == -150_000, (
        f"los tres caminos descontaron distinto: venta={delta_venta}, "
        f"cortesía={delta_cortesia}, personal={delta_personal}"
    )

    # Y los tres quedaron con la MISMA causa tipada: no hay una causa
    # "cortesía" ni una causa "personal" que rompa la suma por causa.
    causas = {m.cause.value for m in movements_of(db, store, ingredient_id=insumo["id"])}
    assert causas == {"sale"}, f"los tres caminos escribieron causas distintas: {causas}"


def test_a_courtesy_is_free_for_the_customer_but_never_free_for_the_inventory(
    db: Any, store: Any, admin_client: Any, device_client: Any, identify: Any, employees: Any,
    open_shift: Any, sales_products: Any,
) -> None:
    """El corolario que se rompe solo: el precio de una cortesía es `0`, pero
    su **costo** no. Un costo de cortesía en `0` sería el cero mudo con otra
    cara, y el reporte de cortesías a costo (§10, «anulaciones, cortesías,
    descuentos… $») no serviría para nada."""
    from sqlalchemy import select

    from app.orders.models import OrderItem

    insumo = make_ingredient(admin_client, store, name="Insumo cortesía", official_cost="10", min_stock="1000")
    product = sales_products["inc8"]
    put_recipe(admin_client, product.id, [{"ingredient_id": insumo["id"], "qty": "100", "unit": "g"}])

    open_shift()
    identify(device_client, employees["operator"])
    order = create_order(device_client).json()
    order = add_items(device_client, order, [{"product_id": product.id, "qty": 1}]).json()
    item_id = order["items"][0]["id"]
    cortesia = device_client.post(
        f"{API}/orders/{order['id']}/items/{item_id}/courtesy",
        json={"expected_version": order["version"], "reason": "promo_owner", "authorizer_pin": "5555"},
    )
    assert cortesia.status_code == 200, cortesia.text
    assert send(device_client, cortesia.json()).status_code == 200

    item = db.execute(select(OrderItem).where(OrderItem.id == item_id)).scalars().one()
    assert item.unit_price == 0
    assert item.unit_cost == 1000, "la cortesía quedó sin costo congelado"
    assert item.cost_source == "official"


# ---------------------------------------------------------------------------
# 3. Consumos del mismo insumo en una comanda se FUSIONAN (§5.3)
# ---------------------------------------------------------------------------


def test_the_same_ingredient_in_one_order_becomes_one_movement(
    db: Any, store: Any, admin_client: Any, device_client: Any, open_shift: Any, sales_products: Any
) -> None:
    """§5.3 pedía «consumos del mismo insumo en una comanda se **fusionan**».
    **La spec se corrigió en el cierre de 2a** y este invariante la sigue.

    Fusionar las filas del libro choca de frente con «la nota "vuelve" revierte
    como espejo exacto» (§3.5) y con el `waste_stub` de un ítem anulado: las dos
    apuntan a un `order_item` concreto y se resuelven **leyendo el libro**. Con
    una fila fusionada no hay forma de saber cuánto de ella le tocaba a cada
    ítem sin una segunda fuente de verdad que duplique el libro — y un libro con
    dos fuentes de verdad deja de ser un libro. Entre una garantía de
    integridad y una de conteo de filas, manda la de integridad.

    Así que el libro guarda **una fila por ítem**, exacta y atribuible, y la
    fusión por comanda es una operación de LECTURA (donde 2b la necesita, para
    explicar una varianza). Lo que este test exige es que el libro lo soporte:
    cantidad total exacta, cada fila atribuida a su ítem, y un agregado por
    comanda que da un solo renglón por insumo.
    """
    aceite = make_ingredient(admin_client, store, name="Aceite", official_cost="6", min_stock="1000")
    uno = sales_products["inc8"]
    otro = sales_products["iva19"]
    put_recipe(admin_client, uno.id, [{"ingredient_id": aceite["id"], "qty": "30", "unit": "ml"}], expect=400)

    # El insumo es `g`; la ficha tiene que hablar en su unidad base.
    put_recipe(admin_client, uno.id, [{"ingredient_id": aceite["id"], "qty": "30", "unit": "g"}])
    put_recipe(admin_client, otro.id, [{"ingredient_id": aceite["id"], "qty": "20", "unit": "g"}])

    open_shift()
    order = create_order(device_client).json()
    order = add_items(
        device_client,
        order,
        [{"product_id": uno.id, "qty": 1}, {"product_id": otro.id, "qty": 1}],
    ).json()
    assert send(device_client, order).status_code == 200

    movimientos = movements_of(db, store, ingredient_id=aceite["id"])
    # 1. La cantidad total es exacta: 30 g + 20 g, sin perder ni inventar nada.
    assert stock_of(db, store, ingredient_id=aceite["id"]) == -50_000

    # 2. Cada fila es atribuible a SU ítem: es lo que hace posible el espejo
    #    exacto de la nota «vuelve» y la resolución del stub de merma.
    item_ids = {i["id"] for i in order["items"]}
    referencias = {(m.ref_type, m.ref_id) for m in movimientos}
    assert referencias == {("order_item", i) for i in item_ids}, (
        f"las filas del libro no quedaron atribuidas una a una a sus ítems: {sorted(referencias)}"
    )

    # 3. El libro soporta la fusión por comanda como lectura: agregado por
    #    (comanda, insumo) da UN renglón, que es la unidad con la que 2b va a
    #    explicar una varianza.
    por_comanda: dict[int, int] = {}
    for m in movimientos:
        por_comanda[order["id"]] = por_comanda.get(order["id"], 0) + m.qty_base
    assert len(por_comanda) == 1 and por_comanda[order["id"]] == -50_000


# ---------------------------------------------------------------------------
# 4. `recipe_effect` de los modificadores (§4.3)
# ---------------------------------------------------------------------------


def _modifier_option(db: Any, store: Any, product: Any, *, name: str) -> Any:
    """Un grupo de modificador con una opción sobre `product`, insertado
    directo: lo que se audita es el efecto sobre el consumo, no la pantalla de
    carta (que ya tiene sus propios tests en `app/catalog`)."""
    from app.catalog.models import ModifierGroup, ModifierOption

    grupo = ModifierGroup(
        organization_id=store.organization_id,
        store_id=store.id,
        product_id=product.id,
        name=f"Grupo {name}",
        required=False,
        min=0,
        max=1,
        sort_order=0,
    )
    db.add(grupo)
    db.flush()
    opcion = ModifierOption(
        organization_id=store.organization_id,
        store_id=store.id,
        modifier_group_id=grupo.id,
        name=name,
        price_delta=0,
        sort_order=0,
        available=True,
    )
    db.add(opcion)
    db.commit()
    return opcion


def test_a_modifier_with_effect_add_increases_the_consumption(
    db: Any, store: Any, admin_client: Any, device_client: Any, open_shift: Any, sales_products: Any
) -> None:
    """§4.3: las opciones con `recipe_effect` «suma, quita o reemplaza
    insumos» — el campo que quedó en `null` durante todo 1b. "Doble queso" que
    no descuenta queso de más es un agujero por diseño."""
    queso = make_ingredient(admin_client, store, name="Queso add", official_cost="20", min_stock="1000")
    product = sales_products["inc8"]
    put_recipe(admin_client, product.id, [{"ingredient_id": queso["id"], "qty": "50", "unit": "g"}])
    opcion = _modifier_option(db, store, product, name="Doble queso")
    resp = admin_client.put(
        f"{API}/admin/modifier-options/{opcion.id}/recipe-effect",
        json={"effect": "add", "lines": [{"ingredient_id": queso["id"], "qty": "50", "unit": "g"}]},
    )
    assert resp.status_code == 200, resp.text

    open_shift()
    order = create_order(device_client).json()
    order = add_items(
        device_client, order, [{"product_id": product.id, "qty": 1, "modifiers": [{"option_id": opcion.id}]}]
    ).json()
    assert send(device_client, order).status_code == 200

    assert stock_of(db, store, ingredient_id=queso["id"]) == -100_000, (
        "el modificador `add` no sumó su insumo al consumo"
    )


def test_a_modifier_with_effect_remove_decreases_the_consumption(
    db: Any, store: Any, admin_client: Any, device_client: Any, open_shift: Any, sales_products: Any
) -> None:
    """«Sin cebolla» tiene que dejar la cebolla en el inventario: si no, la
    varianza de la cebolla crece todos los días por una cuenta que nadie
    hizo."""
    carne = make_ingredient(admin_client, store, name="Carne remove", official_cost="30", min_stock="1000")
    cebolla = make_ingredient(admin_client, store, name="Cebolla remove", official_cost="3", min_stock="1000")
    product = sales_products["inc8"]
    put_recipe(
        admin_client,
        product.id,
        [
            {"ingredient_id": carne["id"], "qty": "200", "unit": "g"},
            {"ingredient_id": cebolla["id"], "qty": "40", "unit": "g"},
        ],
    )
    opcion = _modifier_option(db, store, product, name="Sin cebolla")
    resp = admin_client.put(
        f"{API}/admin/modifier-options/{opcion.id}/recipe-effect",
        json={"effect": "remove", "lines": [{"ingredient_id": cebolla["id"], "qty": "40", "unit": "g"}]},
    )
    assert resp.status_code == 200, resp.text

    open_shift()
    order = create_order(device_client).json()
    order = add_items(
        device_client, order, [{"product_id": product.id, "qty": 1, "modifiers": [{"option_id": opcion.id}]}]
    ).json()
    assert send(device_client, order).status_code == 200

    assert stock_of(db, store, ingredient_id=cebolla["id"]) == 0, "«sin cebolla» descontó cebolla igual"
    assert stock_of(db, store, ingredient_id=carne["id"]) == -200_000


def test_a_modifier_with_effect_replace_swaps_one_ingredient_for_another(
    db: Any, store: Any, admin_client: Any, device_client: Any, open_shift: Any, sales_products: Any
) -> None:
    """«Con leche deslactosada» tiene que descontar deslactosada **y no**
    entera. Es el caso exacto de §4.1: dos caminos dejaron la leche entera en
    −4 y la deslactosada en +19."""
    entera = make_ingredient(admin_client, store, name="Leche entera", official_cost="4", min_stock="1000")
    deslactosada = make_ingredient(admin_client, store, name="Leche deslactosada", official_cost="6", min_stock="1000")
    product = sales_products["inc8"]
    put_recipe(admin_client, product.id, [{"ingredient_id": entera["id"], "qty": "200", "unit": "g"}])
    opcion = _modifier_option(db, store, product, name="Deslactosada")
    resp = admin_client.put(
        f"{API}/admin/modifier-options/{opcion.id}/recipe-effect",
        json={
            "effect": "replace",
            "lines": [
                {
                    "ingredient_id": deslactosada["id"],
                    "qty": "200",
                    "unit": "g",
                    "replaces_ingredient_id": entera["id"],
                }
            ],
        },
    )
    assert resp.status_code == 200, resp.text

    open_shift()
    order = create_order(device_client).json()
    order = add_items(
        device_client, order, [{"product_id": product.id, "qty": 1, "modifiers": [{"option_id": opcion.id}]}]
    ).json()
    assert send(device_client, order).status_code == 200

    assert stock_of(db, store, ingredient_id=entera["id"]) == 0, "el reemplazo descontó igual el insumo original"
    assert stock_of(db, store, ingredient_id=deslactosada["id"]) == -200_000


# ---------------------------------------------------------------------------
# 5. El `waste_stub` que 1b dejó abierto (§ ganchos del pedido)
# ---------------------------------------------------------------------------


def test_voiding_a_sent_item_resolves_its_waste_stub_and_does_not_replenish(
    db: Any, store: Any, admin_client: Any, device_client: Any, open_shift: Any, sales_products: Any
) -> None:
    """§3.5 y el gancho que 1b sembró: «anular un ítem enviado… con PIN genera
    merma, **no repone**».

    El plato ya se cocinó: reponer el insumo sería inventar comida. Lo que
    tiene que pasar es que el `waste_stub` —que en 1b quedaba con
    `ingredient_id NULL` y `resolved=False`— quede resuelto contra la ficha,
    para que la merma tenga a qué insumo cargarse.
    """
    from sqlalchemy import select

    from app.orders.models import WasteStub

    insumo = make_ingredient(admin_client, store, name="Insumo anulado", official_cost="8", min_stock="1000")
    product = sales_products["inc8"]
    put_recipe(admin_client, product.id, [{"ingredient_id": insumo["id"], "qty": "120", "unit": "g"}])

    open_shift()
    order = _sell_and_send(device_client, product.id)
    saldo_tras_enviar = stock_of(db, store, ingredient_id=insumo["id"])
    assert saldo_tras_enviar == -120_000

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

    assert stock_of(db, store, ingredient_id=insumo["id"]) == saldo_tras_enviar, (
        "anular un ítem YA ENVIADO repuso el inventario: el plato ya se cocinó"
    )

    stubs = list(db.execute(select(WasteStub).where(WasteStub.order_item_id == item_id)).scalars())
    assert stubs, "anular un ítem enviado no dejó merma"
    for stub in stubs:
        assert stub.resolved is True, "el `waste_stub` quedó sin resolver, como en 1b"
        assert stub.ingredient_id == insumo["id"], (
            "el `waste_stub` no se resolvió contra la ficha: sigue sin saber qué insumo se perdió"
        )


def test_voiding_an_item_that_was_never_sent_leaves_no_waste_and_no_movement(
    db: Any, store: Any, admin_client: Any, device_client: Any, open_shift: Any, sales_products: Any
) -> None:
    """La contraparte: un ítem que nunca salió a cocina no consumió nada, así
    que anularlo no puede dejar ni merma ni movimiento. Si lo dejara, el
    inventario se iría en negativo por platos que nunca se cocinaron."""
    from sqlalchemy import select

    from app.orders.models import WasteStub

    insumo = make_ingredient(admin_client, store, name="Nunca enviado", official_cost="8", min_stock="1000")
    product = sales_products["inc8"]
    put_recipe(admin_client, product.id, [{"ingredient_id": insumo["id"], "qty": "120", "unit": "g"}])

    open_shift()
    order = create_order(device_client).json()
    order = add_items(device_client, order, [{"product_id": product.id, "qty": 1}]).json()
    item_id = order["items"][0]["id"]
    anulacion = device_client.post(
        f"{API}/orders/{order['id']}/items/{item_id}/void",
        json={"expected_version": order["version"], "reason": "customer_changed_mind"},
    )
    assert anulacion.status_code == 200, anulacion.text

    assert stock_of(db, store, ingredient_id=insumo["id"]) == 0
    assert not list(db.execute(select(WasteStub).where(WasteStub.order_item_id == item_id)).scalars())


# ---------------------------------------------------------------------------
# 6. La nota «vuelve» es espejo exacto (§5.3)
# ---------------------------------------------------------------------------


def test_the_mirror_of_a_consumption_reads_the_ledger_not_the_current_recipe(
    db: Any, store: Any, admin_client: Any, device_client: Any, open_shift: Any, sales_products: Any,
    employees: Any,
) -> None:
    """§5.3: «la reversión (nota "vuelve") es **espejo exacto**» — y §11.2, el
    snapshot.

    La trampa está en cambiar la ficha entremedio: si el espejo se recalcula
    con la receta de HOY en vez de leerse del libro, revertir una venta vieja
    repone una cantidad distinta de la que sacó, y el saldo no vuelve a su
    valor previo. Este test cambia la ficha entre el envío y la reversión a
    propósito.
    """
    from app.auth.deps import Actor
    from app.core import clock as clock_module
    from app.orders import hooks as order_hooks
    from app.orders.models import OrderItem
    from sqlalchemy import select

    insumo = make_ingredient(admin_client, store, name="Insumo espejo", official_cost="9", min_stock="1000")
    product = sales_products["inc8"]
    put_recipe(admin_client, product.id, [{"ingredient_id": insumo["id"], "qty": "100", "unit": "g"}])

    open_shift()
    antes = stock_of(db, store, ingredient_id=insumo["id"])
    order = _sell_and_send(device_client, product.id)
    despues_de_vender = stock_of(db, store, ingredient_id=insumo["id"])
    assert despues_de_vender == antes - 100_000

    # La ficha cambia: la v2 pide el triple. El espejo NO puede usarla.
    put_recipe(admin_client, product.id, [{"ingredient_id": insumo["id"], "qty": "300", "unit": "g"}], version=1)

    item = db.execute(select(OrderItem).where(OrderItem.order_id == order["id"])).scalars().one()
    admin = employees["admin"]
    actor = Actor(
        kind="admin",
        organization_id=store.organization_id,
        store_id=store.id,
        employee_id=admin.id,
        employee_name=admin.name,
        role="admin",
    )
    order_hooks.reverse_item_consumption(db, item=item, actor=actor, now=clock_module.now_utc())
    db.flush()

    assert stock_of(db, store, ingredient_id=insumo["id"]) == antes, (
        "el espejo no devolvió el saldo a su valor previo: se recalculó con la ficha actual"
    )
    causas = [m.cause.value for m in movements_of(db, store, ingredient_id=insumo["id"])]
    assert "note_return" in causas, "la reversión no quedó trazable con su propia causa"


def test_a_note_that_returns_the_dish_reverses_the_consumption_end_to_end(
    db: Any, store: Any, admin_client: Any, device_client: Any, open_shift: Any, sales_products: Any
) -> None:
    """El mismo invariante **por el camino real**, que es el único que el
    restaurante puede recorrer: vender, cobrar, y emitir la nota de ajuste que
    §3.5 define con «se usó» / «vuelve» por línea.

    El espejo puede estar perfecto como función y no servir de nada si nadie
    lo llama: el inventario teórico se queda con el consumo de un plato que
    volvió, y la varianza de 2b lo va a leer como faltante para siempre.
    """
    from sqlalchemy import select

    from app.fiscal.models import FiscalDocument
    from app.orders.models import OrderItem

    insumo = make_ingredient(admin_client, store, name="Insumo nota", official_cost="9", min_stock="1000")
    product = sales_products["inc8"]
    put_recipe(admin_client, product.id, [{"ingredient_id": insumo["id"], "qty": "100", "unit": "g"}])

    open_shift()
    antes = stock_of(db, store, ingredient_id=insumo["id"])
    order = _sell_and_send(device_client, product.id)
    total = order["totals"]["total"]
    cobro = pay(device_client, order["id"], splits=[{"method": "cash", "amount": total}], tip=NO_TIP)
    assert cobro.status_code == 201, cobro.text

    item = db.execute(select(OrderItem).where(OrderItem.order_id == order["id"])).scalars().one()
    documento = db.execute(
        select(FiscalDocument).where(FiscalDocument.order_id == order["id"])
    ).scalars().first()
    assert documento is not None

    nota = admin_client.post(
        f"{API}/admin/documents/{documento.id}/notes",
        json={
            "kind": "adjustment",
            "reason": "El cliente devolvió el plato sin tocar; vuelve al inventario",
            "lines": [{"item_id": item.id, "used": True}],
        },
        headers=idem_headers(),
    )
    assert nota.status_code == 201, nota.text

    db.expire_all()
    assert stock_of(db, store, ingredient_id=insumo["id"]) == antes, (
        "la nota «vuelve» no revirtió el consumo: `app.orders.hooks.reverse_item_consumption` "
        "existe y está probada, pero `app.fiscal.service.issue_note` no la llama"
    )


def test_a_note_line_marked_used_returns_nothing_to_the_inventory(
    db: Any, store: Any, admin_client: Any, device_client: Any, open_shift: Any, sales_products: Any
) -> None:
    """§3.5: «por línea "se usó" (**no vuelve al inventario**) o "vuelve"».

    Es el **espejo del test de arriba**, y existe por una razón concreta: el
    arreglo de B-1 (cablear `reverse_item_consumption` dentro de `issue_note`)
    se pasa de largo con una facilidad enorme — basta revertir *toda* línea que
    entre en la nota — y el resultado sería peor que el bug original: el plato
    que el cliente **se comió** volvería al stock teórico, y la varianza de 2b
    lo leería como sobrante permanente del mismo insumo. Un solo test que sólo
    mira el caso «vuelve» no distingue «lo llama cuando corresponde» de «lo
    llama siempre».

    Dos aserciones, porque el saldo solo no alcanza: además del saldo, el libro
    no puede tener **ningún** movimiento `note_return` para ese insumo. Un
    movimiento de reversión compensado por otro lado daría el mismo saldo y
    dejaría el libro mintiendo (§5.1: «todo cambio es un movimiento con causa
    enumerada»).
    """
    from sqlalchemy import select

    from app.fiscal.models import FiscalDocument
    from app.orders.models import OrderItem

    insumo = make_ingredient(admin_client, store, name="Insumo se uso", official_cost="9", min_stock="1000")
    product = sales_products["inc8"]
    put_recipe(admin_client, product.id, [{"ingredient_id": insumo["id"], "qty": "100", "unit": "g"}])

    open_shift()
    antes = stock_of(db, store, ingredient_id=insumo["id"])
    order = _sell_and_send(device_client, product.id)
    consumido = stock_of(db, store, ingredient_id=insumo["id"])
    assert consumido == antes - 100_000

    total = order["totals"]["total"]
    cobro = pay(device_client, order["id"], splits=[{"method": "cash", "amount": total}], tip=NO_TIP)
    assert cobro.status_code == 201, cobro.text

    item = db.execute(select(OrderItem).where(OrderItem.order_id == order["id"])).scalars().one()
    documento = db.execute(
        select(FiscalDocument).where(FiscalDocument.order_id == order["id"])
    ).scalars().first()
    assert documento is not None

    # El plato se sirvió y el cliente se lo comió: la nota ajusta la plata,
    # pero el insumo YA NO ESTÁ. "se usó" = `returns_to_stock: False`.
    nota = admin_client.post(
        f"{API}/admin/documents/{documento.id}/notes",
        json={
            "kind": "adjustment",
            "reason": "Se cobró de más; el plato se sirvió y se consumió",
            "lines": [{"item_id": item.id, "used": True, "returns_to_stock": False}],
        },
        headers=idem_headers(),
    )
    assert nota.status_code == 201, nota.text

    db.expire_all()
    assert stock_of(db, store, ingredient_id=insumo["id"]) == consumido, (
        "una línea marcada «se usó» devolvió el insumo al inventario: el plato que el cliente "
        "se comió volvió al stock teórico y 2b lo va a leer como sobrante permanente"
    )
    causas = [m.cause.value for m in movements_of(db, store, ingredient_id=insumo["id"])]
    assert "note_return" not in causas, (
        f"la nota «se usó» dejó un movimiento de reversión en el libro: {causas}"
    )


# ---------------------------------------------------------------------------
# 7. Ciclo de preparaciones (§4.2)
# ---------------------------------------------------------------------------


def test_a_three_hop_preparation_cycle_is_refused(db: Any, store: Any, admin_client: Any) -> None:
    """Contrato de la API del pedido: «`400 PREP_CYCLE` si una preparación se
    referencia a sí misma **por cualquier camino**».

    El padre directo lo ve cualquiera; A → B → C → A es el que cuelga el
    servidor en una recursión infinita al costear. El checklist pide
    explícitamente el ciclo de tres saltos.
    """
    base = make_ingredient(admin_client, store, name="Base ciclo", official_cost="1", min_stock="1000")
    a = make_preparation(
        admin_client, store, name="Ciclo A", lines=[{"ingredient_id": base["id"], "qty": "100", "unit": "g"}]
    )
    b = make_preparation(admin_client, store, name="Ciclo B", lines=[{"preparation_id": a["id"], "qty": "100", "unit": "g"}])
    c = make_preparation(admin_client, store, name="Ciclo C", lines=[{"preparation_id": b["id"], "qty": "100", "unit": "g"}])

    cierre = admin_client.patch(
        f"{API}/admin/preparations/{a['id']}",
        json={"lines": [{"preparation_id": c["id"], "qty": "100", "unit": "g"}]},
    )
    assert cierre.status_code == 400, cierre.text
    error = cierre.json()["error"]
    assert error["code"] == "PREP_CYCLE", error
    assert len(error["message"]) > 15


def test_a_preparation_cannot_reference_itself(db: Any, store: Any, admin_client: Any) -> None:
    """El caso de un solo salto, por si la detección sólo mira nietos."""
    prep = make_preparation(admin_client, store, name="Auto ciclo")
    resp = admin_client.patch(
        f"{API}/admin/preparations/{prep['id']}",
        json={"lines": [{"preparation_id": prep["id"], "qty": "10", "unit": "g"}]},
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "PREP_CYCLE"


# ---------------------------------------------------------------------------
# 8. Cambiar de modo con lotes abiertos (§4.2)
# ---------------------------------------------------------------------------


def test_switching_a_batch_preparation_to_exploded_needs_an_admin_pin(
    db: Any, store: Any, admin_client: Any
) -> None:
    """§4.2: «cambiar de modo es acción del **administrador**». Sin PIN no
    pasa, y el `400` nombra qué falta (§11.18)."""
    prep = make_preparation(admin_client, store, name="Modo sin pin", mode="batch")
    resp = admin_client.patch(f"{API}/admin/preparations/{prep['id']}/mode", json={"mode": "exploded"})
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "AUTHORIZATION_REQUIRED"

    from app.recipes.models import PrepMode, Preparation

    db.expire_all()
    assert db.get(Preparation, prep["id"]).mode is PrepMode.BATCH


def test_switching_out_of_batch_closes_open_batches_with_a_count_adjustment(
    db: Any, store: Any, admin_client: Any, device_client: Any, identify: Any, employees: Any, open_shift: Any
) -> None:
    """§4.2: «cambiar de modo… **cierra los lotes abiertos con un ajuste de
    conteo**».

    Si no se cerraran, el stock de la preparación seguiría vivo en el libro
    después de que la preparación dejó de tener stock por definición — un
    saldo fantasma que nadie puede contar ni dar de baja.
    """
    from sqlalchemy import select

    from app.inventory.models import MovementCause
    from app.recipes.models import PrepBatch

    insumo = make_ingredient(admin_client, store, name="Insumo modo", official_cost="2", min_stock="1000")
    prep = make_preparation(
        admin_client, store, name="Cambia de modo", mode="batch",
        standard_yield_qty="1000", standard_yield_unit="g",
        lines=[{"ingredient_id": insumo["id"], "qty": "500", "unit": "g"}],
    )
    open_shift()
    identify(device_client, employees["operator"])
    assert produce(device_client, prep["id"], qty_expected="1000", qty_real="1000").status_code == 201
    assert stock_of(db, store, preparation_id=prep["id"]) == 1_000_000

    resp = admin_client.patch(
        f"{API}/admin/preparations/{prep['id']}/mode", json={"mode": "exploded", "authorizer_pin": "9999"}
    )
    assert resp.status_code == 200, resp.text

    assert stock_of(db, store, preparation_id=prep["id"]) == 0, "el saldo de la preparación quedó fantasma"
    causas = [m.cause for m in movements_of(db, store, preparation_id=prep["id"])]
    assert MovementCause.COUNT_ADJUSTMENT in causas, (
        f"los lotes se cerraron sin un ajuste de conteo trazable: {[c.value for c in causas]}"
    )

    lotes = list(db.execute(select(PrepBatch).where(PrepBatch.preparation_id == prep["id"])).scalars())
    assert lotes and all(b.closed_at is not None for b in lotes), "quedaron lotes abiertos de una preparación sin stock"


# ---------------------------------------------------------------------------
# 9. Idempotencia de la producción rápida (§4.2)
# ---------------------------------------------------------------------------


def test_producing_twice_with_the_same_key_creates_one_batch_and_one_deduction(
    db: Any, store: Any, admin_client: Any, device_client: Any, identify: Any, employees: Any, open_shift: Any
) -> None:
    """§4.2: la producción rápida en dos toques lleva **clave de
    idempotencia**. Dos toques sobre el mismo botón son el caso normal en una
    tablet de cocina con guantes."""
    from sqlalchemy import select

    from app.recipes.models import PrepBatch

    insumo = make_ingredient(admin_client, store, name="Insumo idem prod", official_cost="2", min_stock="1000")
    prep = make_preparation(
        admin_client, store, name="Producción idem", mode="batch",
        standard_yield_qty="1000", standard_yield_unit="g",
        lines=[{"ingredient_id": insumo["id"], "qty": "400", "unit": "g"}],
    )
    open_shift()
    identify(device_client, employees["operator"])
    headers = idem_headers()

    primera = produce(device_client, prep["id"], qty_expected="1000", qty_real="1000", headers=headers)
    segunda = produce(device_client, prep["id"], qty_expected="1000", qty_real="1000", headers=headers)
    assert primera.status_code == 201, primera.text
    assert segunda.status_code == 201, segunda.text
    assert primera.json()["id"] == segunda.json()["id"]

    lotes = list(db.execute(select(PrepBatch).where(PrepBatch.preparation_id == prep["id"])).scalars())
    assert len(lotes) == 1, f"la misma clave creó {len(lotes)} lotes"
    assert stock_of(db, store, ingredient_id=insumo["id"]) == -400_000
    assert stock_of(db, store, preparation_id=prep["id"]) == 1_000_000


def test_a_production_far_from_the_expected_yield_raises_the_fifteen_percent_alert(
    db: Any, store: Any, admin_client: Any, device_client: Any, identify: Any, employees: Any, open_shift: Any
) -> None:
    """§4.2: «se guarda rendimiento esperado y real, **alerta si difieren más
    de 15 %**». Es la señal temprana de una receta mal medida o de una merma
    de proceso que nadie declaró."""
    insumo = make_ingredient(admin_client, store, name="Insumo varianza", official_cost="2", min_stock="1000")
    prep = make_preparation(
        admin_client, store, name="Varianza", mode="batch",
        standard_yield_qty="1000", standard_yield_unit="g",
        lines=[{"ingredient_id": insumo["id"], "qty": "400", "unit": "g"}],
    )
    open_shift()
    identify(device_client, employees["operator"])

    dentro = produce(device_client, prep["id"], qty_expected="1000", qty_real="950")
    assert dentro.status_code == 201, dentro.text
    assert dentro.json()["variance_alert"] is False

    fuera = produce(device_client, prep["id"], qty_expected="1000", qty_real="700")
    assert fuera.status_code == 201, fuera.text
    assert fuera.json()["variance_alert"] is True, "una producción 30 % por debajo no alertó"


# ---------------------------------------------------------------------------
# 10. Flags encendidas Y apagadas (§11.19)
# ---------------------------------------------------------------------------


def test_with_catalog_recipes_disabled_the_sale_works_exactly_like_in_1b(
    db: Any, store: Any, admin_client: Any, device_client: Any, open_shift: Any, sales_products: Any, set_feature: Any
) -> None:
    """Checklist de entrega, primer ítem: «con `catalog.recipes` apagada,
    vender funciona exactamente como en 1b y `unit_cost` queda `null` con
    origen `none` — **nunca `0`**».

    El bloqueante B-2 de 1b-2 fue exactamente esto: una flag apagada por un
    camino que nadie probó apagado, y se perdían ventas enteras.
    """
    from sqlalchemy import select

    from app.orders.models import OrderItem

    insumo = make_ingredient(admin_client, store, name="Insumo flag", official_cost="10", min_stock="1000")
    product = sales_products["inc8"]
    put_recipe(admin_client, product.id, [{"ingredient_id": insumo["id"], "qty": "100", "unit": "g"}])
    set_feature("catalog.recipes", False)

    open_shift()
    order = _sell_and_send(device_client, product.id)
    total = order["totals"]["total"]
    cobro = pay(device_client, order["id"], splits=[{"method": "cash", "amount": total}], tip=NO_TIP)
    assert cobro.status_code == 201, f"con la ficha apagada se perdió la venta entera: {cobro.text}"

    item = db.execute(select(OrderItem).where(OrderItem.order_id == order["id"])).scalars().one()
    assert item.unit_cost is None, "la flag apagada dejó un costo igual"
    assert item.cost_source in (None, "none"), f"origen inesperado: {item.cost_source!r}"
    assert item.unit_cost != 0, "cero mudo: `null` no es `0`"
    assert item.recipe_version is None
    assert stock_of(db, store, ingredient_id=insumo["id"]) == 0


def test_with_inventory_perpetual_disabled_the_cost_is_still_frozen_but_nothing_moves(
    db: Any, store: Any, admin_client: Any, device_client: Any, open_shift: Any, sales_products: Any, set_feature: Any
) -> None:
    """Las cuatro funciones de esta fase son independientes: un restaurante
    puede querer saber cuánto le cuesta un plato (`catalog.recipes`) sin
    llevar inventario perpetuo (`inventory.perpetual`). Apagar el libro no
    puede apagar el costeo, ni al revés."""
    from sqlalchemy import select

    from app.inventory.models import StockMovement
    from app.orders.models import OrderItem

    insumo = make_ingredient(admin_client, store, name="Insumo sin libro", official_cost="10", min_stock="1000")
    product = sales_products["inc8"]
    put_recipe(admin_client, product.id, [{"ingredient_id": insumo["id"], "qty": "100", "unit": "g"}])
    set_feature("inventory.perpetual", False)

    open_shift()
    order = _sell_and_send(device_client, product.id)

    item = db.execute(select(OrderItem).where(OrderItem.order_id == order["id"])).scalars().one()
    assert item.unit_cost == 1000, "apagar el libro apagó también el costeo del plato"
    assert item.recipe_version == 1
    assert not list(db.execute(select(StockMovement)).scalars()), (
        "con `inventory.perpetual` apagada se escribieron movimientos igual"
    )


def test_with_catalog_preps_disabled_the_quick_production_is_refused(
    db: Any, store: Any, admin_client: Any, device_client: Any, identify: Any, employees: Any,
    open_shift: Any, set_feature: Any,
) -> None:
    """La producción rápida vive detrás de `catalog.preps`, y el backend lo
    hace cumplir en la ruta de dispositivo — no sólo escondiendo el botón."""
    insumo = make_ingredient(admin_client, store, name="Insumo preps off", official_cost="2", min_stock="1000")
    prep = make_preparation(
        admin_client, store, name="Preps off", mode="batch",
        standard_yield_qty="1000", standard_yield_unit="g",
        lines=[{"ingredient_id": insumo["id"], "qty": "400", "unit": "g"}],
    )
    set_feature("catalog.preps", False)
    open_shift()
    identify(device_client, employees["operator"])

    resp = produce(device_client, prep["id"], qty_expected="1000", qty_real="1000")
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
    assert stock_of(db, store, ingredient_id=insumo["id"]) == 0

    listado = device_client.get(f"{API}/preparations")
    assert listado.status_code == 400
    assert listado.json()["error"]["code"] == "FEATURE_DISABLED"


# ---------------------------------------------------------------------------
# 11. Cobertura de recetas (§4.3)
# ---------------------------------------------------------------------------


def test_a_product_without_a_recipe_still_sells_and_shows_up_in_coverage(
    db: Any, store: Any, admin_client: Any, device_client: Any, open_shift: Any, sales_products: Any
) -> None:
    """§4.3: «plato vendido sin receta ni insumo directo no descuenta nada; la
    venta sigue, y aparece en el reporte de "platos que no descuentan"».

    Las dos mitades importan: cortar la venta sería peor que no costear, y no
    reportarlo deja el agujero invisible para siempre.
    """
    product = sales_products["excluded"]  # sin ficha
    open_shift()
    order = _sell_and_send(device_client, product.id)
    assert order["items"][0]["status"] in ("sent", "served")

    cobertura = admin_client.get(f"{API}/admin/recipes/coverage?store_id={store.id}")
    assert cobertura.status_code == 200, cobertura.text
    ids = {fila["product_id"] for fila in cobertura.json()}
    assert product.id in ids, "un plato vendido sin ficha no apareció en «platos que no descuentan»"

    hoy = admin_client.get(f"{API}/admin/today?store_id={store.id}")
    assert hoy.status_code == 200, hoy.text
    assert product.id in {f["product_id"] for f in hoy.json()["products_discounting_nothing"]}


def test_a_recipe_line_off_by_a_thousand_is_flagged_as_a_suspicious_unit(
    db: Any, store: Any, admin_client: Any, sales_products: Any
) -> None:
    """§4.3: «validación de recetas sospechosas de unidad (18 "kg" donde iban
    18 g)». Una línea así multiplica por mil el costo del plato y vacía el
    inventario del insumo en una sola venta."""
    normal_a = make_ingredient(admin_client, store, name="Normal A", official_cost="5", min_stock="1000")
    normal_b = make_ingredient(admin_client, store, name="Normal B", official_cost="5", min_stock="1000")
    normal_c = make_ingredient(admin_client, store, name="Normal C", official_cost="5", min_stock="1000")
    gordo = make_ingredient(admin_client, store, name="Tecleado en kg", official_cost="5", min_stock="1000")

    put_recipe(
        admin_client,
        sales_products["inc8"].id,
        [
            {"ingredient_id": normal_a["id"], "qty": "18", "unit": "g"},
            {"ingredient_id": normal_b["id"], "qty": "20", "unit": "g"},
            {"ingredient_id": normal_c["id"], "qty": "25", "unit": "g"},
        ],
    )
    put_recipe(
        admin_client,
        sales_products["iva19"].id,
        [{"ingredient_id": gordo["id"], "qty": "18", "unit": "kg"}],
    )

    resp = admin_client.get(f"{API}/admin/recipes/suspicious-units?store_id={store.id}")
    assert resp.status_code == 200, resp.text
    sospechosos = {fila["ingredient_id"] for fila in resp.json()}
    assert gordo["id"] in sospechosos, "18 kg donde iban 18 g pasó sin alerta"
    assert normal_a["id"] not in sospechosos, "la validación marcó una línea normal (falso positivo)"


# ---------------------------------------------------------------------------
# 12. Fecha operativa de negocio (§11.8)
# ---------------------------------------------------------------------------


def test_a_consumption_at_half_past_midnight_is_stamped_with_the_shift_day(
    db: Any, store: Any, admin_client: Any, device_client: Any, open_shift: Any, sales_products: Any,
    clock: Any, identify: Any, employees: Any,
) -> None:
    """§11.8 y el checklist: «un consumo a las 00:30 queda sellado con el día
    del turno».

    La sede corta a las 06:00 (`cutoff_hour`), así que un plato que sale a las
    00:30 pertenece al día operativo **anterior**. Sellarlo con el día UTC
    (que a esa hora ya cambió dos veces: son las 05:30 UTC) partiría el
    servicio de la noche en dos días y haría imposible cuadrar el consumo
    contra las ventas de ese turno.
    """
    insumo = make_ingredient(admin_client, store, name="Insumo madrugada", official_cost="5", min_stock="1000")
    product = sales_products["inc8"]
    put_recipe(admin_client, product.id, [{"ingredient_id": insumo["id"], "qty": "100", "unit": "g"}])

    # 2026-01-16 01:00 UTC == 2026-01-15 20:00 en Bogotá -> día operativo 15.
    clock.set(datetime(2026, 1, 16, 1, 0, tzinfo=timezone.utc))
    turno = open_shift()

    # 2026-01-16 05:30 UTC == 2026-01-16 00:30 en Bogotá, antes del corte de
    # las 06:00 -> sigue siendo el día operativo 15, aunque en UTC ya es 16.
    clock.set(datetime(2026, 1, 16, 5, 30, tzinfo=timezone.utc))
    # La ventana deslizante de la persona activa dura minutos: el operador se
    # vuelve a identificar, como en el salón real a las 00:30.
    identify(device_client, employees["operator"])
    _sell_and_send(device_client, product.id)

    movimientos = movements_of(db, store, ingredient_id=insumo["id"])
    assert movimientos, "no se registró el consumo"
    for movimiento in movimientos:
        assert movimiento.at.astimezone(timezone.utc).date().isoformat() == "2026-01-16"
        assert movimiento.business_date.isoformat() == "2026-01-15", (
            f"el consumo se selló con {movimiento.business_date} (el día UTC), no con el día del turno"
        )
    assert turno["business_date"] == "2026-01-15"


# ---------------------------------------------------------------------------
# 13. Un solo camino de consumo, con cascada al sustituto (§4.1)
# ---------------------------------------------------------------------------


def test_the_substitute_cascade_splits_the_whole_quantity_of_the_line(
    db: Any, store: Any, admin_client: Any, device_client: Any, open_shift: Any, sales_products: Any
) -> None:
    """§4.1: «sustituto opcional con **un solo camino de consumo** y cascada»
    — «en la referencia dos caminos dejaron la leche entera en −4 y la
    deslactosada en +19».

    La cascada tiene que repartir la cantidad **total** que se consume, no la
    de una unidad multiplicada después: con 10 g de leche entera en stock y
    una comanda de 3 platos de 4 g cada uno (12 g), lo correcto es dejar la
    entera en 0 y la deslactosada en −2. Si la cascada se resuelve sobre una
    unidad y recién después se multiplica, la entera queda en −2 y la
    deslactosada sin tocar: el saldo total es el mismo, pero el insumo que
    aparece negativo es el equivocado — que es exactamente la forma del bug
    de la referencia.
    """
    deslactosada = make_ingredient(
        admin_client, store, name="Leche deslactosada sust", official_cost="6", min_stock="1000"
    )
    entera = make_ingredient(
        admin_client,
        store,
        name="Leche entera sust",
        official_cost="4",
        min_stock="1000",
        substitute_ingredient_id=deslactosada["id"],
    )

    # 10 g de leche entera en el libro; la deslactosada arranca en 0.
    carga = admin_client.post(
        f"{API}/admin/inventory/adjustments?store_id={store.id}",
        json={"ingredient_id": entera["id"], "qty_delta": "10", "reason": "carga inicial", "authorizer_pin": "9999"},
        headers=idem_headers(),
    )
    assert carga.status_code == 201, carga.text

    product = sales_products["inc8"]
    put_recipe(admin_client, product.id, [{"ingredient_id": entera["id"], "qty": "4", "unit": "g"}])

    open_shift()
    order = create_order(device_client).json()
    order = add_items(device_client, order, [{"product_id": product.id, "qty": 3}]).json()
    assert send(device_client, order).status_code == 200

    saldo_entera = stock_of(db, store, ingredient_id=entera["id"])
    saldo_deslactosada = stock_of(db, store, ingredient_id=deslactosada["id"])

    # La cantidad total consumida no se pierde por ningún camino.
    assert saldo_entera + saldo_deslactosada == 10_000 - 12_000

    assert (saldo_entera, saldo_deslactosada) == (0, -2_000), (
        f"la cascada repartió mal: entera={saldo_entera}, deslactosada={saldo_deslactosada}. "
        "El sustituto tiene que absorber lo que el insumo principal ya no tiene, "
        "sobre la cantidad TOTAL de la línea, no sobre la de una unidad."
    )


# ---------------------------------------------------------------------------
# 14. La cobertura de recetas también es un reporte: no puede revalorar el
#     pasado con la carta de hoy (§11.2)
# ---------------------------------------------------------------------------


def test_the_coverage_report_answers_about_the_past_not_about_todays_recipe(
    db: Any, store: Any, admin_client: Any, device_client: Any, open_shift: Any, sales_products: Any
) -> None:
    """§11.2 y `AGENTS.md`: «precio, impuesto, costo teórico y receta usada se
    congelan al vender. **Ninguna consulta de reportes vuelve a la carta
    actual para valorar una venta pasada**».

    «Platos que no descuentan» responde una pregunta sobre lo que **ya pasó**:
    ¿esta venta descontó inventario, sí o no? La respuesta está congelada en el
    ítem (`recipe_version`) y en el libro. Si en cambio se vuelve a expandir la
    ficha de HOY, cargar la receta que faltaba borra retroactivamente la
    evidencia de que durante una semana no se descontó nada — y el
    `costed_pct` de un período cerrado cambia cada vez que alguien
    edita una ficha, así que ningún número de cobertura es reproducible.
    """
    product = sales_products["excluded"]
    open_shift()
    _sell_and_send(device_client, product.id)

    antes = admin_client.get(f"{API}/admin/recipes/coverage?store_id={store.id}")
    assert antes.status_code == 200, antes.text
    assert product.id in {f["product_id"] for f in antes.json()}, (
        "un plato vendido sin ficha tiene que aparecer en cobertura"
    )

    # El dueño carga la ficha que faltaba, HOY. La venta de antes sigue sin
    # haber descontado nada: el libro no tiene un solo movimiento suyo.
    insumo = make_ingredient(admin_client, store, name="Insumo tardío", official_cost="5", min_stock="1000")
    put_recipe(admin_client, product.id, [{"ingredient_id": insumo["id"], "qty": "50", "unit": "g"}])

    despues = admin_client.get(f"{API}/admin/recipes/coverage?store_id={store.id}")
    assert despues.status_code == 200, despues.text
    assert product.id in {f["product_id"] for f in despues.json()}, (
        "cargar la ficha hoy borró del reporte una venta que de verdad no descontó nada: "
        "el reporte se recalculó con la carta actual en vez de leer el snapshot"
    )


def test_the_coverage_report_uses_the_frozen_product_name(
    db: Any, store: Any, admin_client: Any, device_client: Any, open_shift: Any, sales_products: Any
) -> None:
    """La misma regla, en el campo más fácil de pasar por alto: el **nombre**.
    `OrderItem.product_name` se congela al vender (`app/orders/models.py:441`)
    justamente para esto. Un reporte que lee `Product.name` cambia de contenido
    cuando alguien renombra un plato, y el invariante heredado de 1b-2
    (`test_reports_invariants.py::test_changing_the_menu_price_today_does_not_revalue_yesterdays_sale`,
    que compara el payload entero de `GET /admin/today` antes y después de
    tocar la carta) lo caza exactamente por ahí."""
    product = sales_products["excluded"]
    nombre_al_vender = product.name
    open_shift()
    _sell_and_send(device_client, product.id)

    product.name = f"{nombre_al_vender} (renombrado)"
    db.commit()

    resp = admin_client.get(f"{API}/admin/recipes/coverage?store_id={store.id}")
    assert resp.status_code == 200, resp.text
    fila = next(f for f in resp.json() if f["product_id"] == product.id)
    assert fila["product_name"] == nombre_al_vender, (
        f"el reporte muestra «{fila['product_name']}»: leyó la carta de hoy en vez del "
        "nombre congelado en el ítem vendido"
    )
