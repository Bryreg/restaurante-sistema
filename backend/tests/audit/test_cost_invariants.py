"""Lo que le cuesta un plato tiene que ser un número defendible.

Pedido 2a (`features/fase-2-costo-inventario/spec.md`) y `docs/SPEC-NEGOCIO.md`
§4.1 (insumos, rendimiento, costo con origen), §4.2 (preparaciones y
propagación del costo) y §4.3 (ficha técnica, food cost, versionado).

Los invariantes de este archivo defienden la **aritmética** del costo: que el
rendimiento se aplique (y hacia arriba), que el costo propague por la cadena
insumo → preparación → plato, que la ficha versione y el snapshot aguante, que
una cantidad nunca sea un `float`, y que "sin costo" sea `null` con origen
`none` y nunca un `0` mudo.

Los que tocan el libro de movimientos viven en `test_inventory_invariants.py`;
los que tocan el consumo al enviar, en `test_consumption_invariants.py`.
"""

from __future__ import annotations

import random
from decimal import Decimal
from typing import Any

import pytest

from tests.audit.conftest import (
    API_V1,
    NO_TIP,
    add_items,
    create_order,
    make_ingredient,
    make_preparation,
    pay,
    put_recipe,
    send,
    stock_of,
)

API = API_V1


# ---------------------------------------------------------------------------
# Rendimiento: la ficha pide LIMPIO, el inventario descuenta BRUTO
# ---------------------------------------------------------------------------


def test_apply_yield_always_rounds_up_and_never_under_deducts() -> None:
    """§4.1: «la receta expresa cantidad limpia y el consumo teórico descuenta
    cantidad ÷ rendimiento. Sin esto todos los costos se subestiman y la
    varianza parece robo crónico».

    El redondeo hacia arriba no es un detalle de gusto: redondear hacia abajo
    descuenta **menos** de lo que de verdad se usó, y el faltante aparece
    después como varianza que nadie puede explicar. Este test fija el número
    exacto de un caso conocido (100 g limpios al 85 %) y además exige la
    propiedad general sobre todos los rendimientos posibles.
    """
    from app.core.quantity import QTY_SCALE, apply_yield

    # Caso numérico explícito: 100 g limpios de una pechuga que rinde 85 %.
    # 100 g ÷ 0,85 = 117,647058… g -> 117,648 g (ceil a la milésima).
    assert apply_yield(100 * QTY_SCALE, 85) == 117_648

    # Propiedad: para todo rendimiento < 100 el consumo es ESTRICTAMENTE mayor
    # que la cantidad limpia, y para 100 es exactamente igual.
    for yield_pct in range(1, 101):
        deducted = apply_yield(100 * QTY_SCALE, yield_pct)
        if yield_pct == 100:
            assert deducted == 100 * QTY_SCALE
        else:
            assert deducted > 100 * QTY_SCALE, f"rendimiento {yield_pct}% descontó de menos"
        # Y nunca redondea hacia abajo: multiplicar de vuelta no puede dar
        # menos que la cantidad limpia pedida.
        assert deducted * yield_pct >= 100 * QTY_SCALE * 100


def test_a_yield_outside_one_to_one_hundred_is_a_business_error_not_a_crash() -> None:
    """§11.18: «todo 4xx operativo nombra la acción correctiva» — y nunca un
    `500`. Un rendimiento de 0 dividiría por cero; un rendimiento de 0 % no es
    un insumo, es un insumo que no rinde nada."""
    from app.core.errors import AppError
    from app.core.quantity import apply_yield

    for invalid in (0, -5, 101, 1000):
        with pytest.raises(AppError) as exc:
            apply_yield(1000, invalid)
        assert exc.value.code == "VALIDATION_ERROR"
        assert "rendimiento" in exc.value.message.lower()


def test_sending_an_item_deducts_the_gross_quantity_not_the_clean_one(
    db: Any, store: Any, admin_client: Any, device_client: Any, open_shift: Any, sales_products: Any
) -> None:
    """El mismo invariante, de punta a punta y con el número exacto: una ficha
    de 100 g limpios sobre un insumo al 85 % tiene que dejar el saldo en
    **−117,648 g**, no en −100 g (checklist de entrega, ítem del rendimiento).

    Es el error que subestima todos los costos: si esto falla, *todo* el módulo
    de costo miente hacia abajo y la varianza de 2b va a leerse como robo.
    """
    ingredient = make_ingredient(
        admin_client, store, name="Pechuga con hueso", yield_pct=85, official_cost="14.5", min_stock="5000"
    )
    product = sales_products["inc8"]
    put_recipe(admin_client, product.id, [{"ingredient_id": ingredient["id"], "qty": "100", "unit": "g"}])

    open_shift()
    order = create_order(device_client).json()
    order = add_items(device_client, order, [{"product_id": product.id, "qty": 1}]).json()
    resp = send(device_client, order)
    assert resp.status_code == 200, resp.text

    assert stock_of(db, store, ingredient_id=ingredient["id"]) == -117_648

    # Y el costo congelado en el ítem es el del BRUTO, no el del limpio:
    # 117.648 milésimas × $14,5/g = $1.705,896 -> $1.706 (half-up en el borde).
    from sqlalchemy import select

    from app.orders.models import OrderItem

    item = db.execute(select(OrderItem).where(OrderItem.order_id == order["id"])).scalars().one()
    assert item.unit_cost == 1706, "el costo congelado se calculó sobre la cantidad limpia, no sobre la bruta"
    assert item.cost_source == "official"


# ---------------------------------------------------------------------------
# Costo con origen, nunca un cero mudo
# ---------------------------------------------------------------------------


def test_an_ingredient_without_cost_reports_null_with_source_none_never_zero(
    db: Any, store: Any, admin_client: Any
) -> None:
    """§4.1 y la convención de ingeniería del pedido: «sin costo es `null` con
    origen `none`, no `0`». Un `0` mudo es peor que no saber: entra en una suma
    como si el insumo fuera gratis y nadie vuelve a mirarlo."""
    sin_costo = make_ingredient(admin_client, store, name="Sin costo", official_cost=None)
    assert sin_costo["cost"] is None, "un insumo sin costo devolvió un número"
    assert sin_costo["cost_source"] == "none"
    assert sin_costo["official_cost"] is None

    con_costo = make_ingredient(admin_client, store, name="Con costo", official_cost="12.25")
    assert con_costo["cost"] == "12.25"
    assert con_costo["cost_source"] == "official"


def test_a_recipe_with_one_uncosted_ingredient_reports_no_cost_at_all(
    db: Any, store: Any, admin_client: Any, sales_products: Any
) -> None:
    """Una ficha con un insumo sin costo **no** puede reportar la suma de los
    que sí lo tienen como si fuera el costo del plato: sería un costo
    sistemáticamente bajo con cara de exacto. §4.1, «todo costo viaja con su
    origen; nunca un cero mudo».

    **Ronda 2 — decisión del orquestador (no un defecto)**: todo costo
    publicado por `recipes` pasa a **texto decimal en pesos**, igual que el de
    `inventory`, que es la forma en que se cerró B-2 (un costo real por unidad
    base menor a un peso se publicaba como `0` con origen `official`). La
    aserción compara el **valor** con `Decimal`, no el tipo: el número
    esperado no cambió. Que ningún campo de costo quede tipado como entero lo
    defiende, aparte, el barrido del OpenAPI en
    `test_no_cost_field_of_inventory_or_recipes_is_typed_as_an_integer`.
    """
    caro = make_ingredient(admin_client, store, name="Carne", official_cost="30", min_stock="1000")
    mudo = make_ingredient(admin_client, store, name="Especia sin precio", official_cost=None, min_stock="10")
    product = sales_products["inc8"]

    solo_caro = put_recipe(admin_client, product.id, [{"ingredient_id": caro["id"], "qty": "100", "unit": "g"}])
    assert Decimal(str(solo_caro["theoretical_cost"])) == Decimal("3000"), solo_caro
    assert solo_caro["cost_source"] == "official"

    con_mudo = put_recipe(
        admin_client,
        product.id,
        [
            {"ingredient_id": caro["id"], "qty": "100", "unit": "g"},
            {"ingredient_id": mudo["id"], "qty": "2", "unit": "g"},
        ],
        version=solo_caro["version"],
    )
    assert con_mudo["theoretical_cost"] is None, (
        "la ficha reportó un costo parcial como si fuera el costo del plato"
    )
    assert con_mudo["cost_source"] == "none"
    assert con_mudo["food_cost_pct"] is None


# ---------------------------------------------------------------------------
# Propagación del costo en cadena insumo -> preparación -> plato
# ---------------------------------------------------------------------------


def test_changing_an_ingredient_cost_propagates_to_the_prep_and_to_the_dish(
    db: Any, store: Any, admin_client: Any, sales_products: Any
) -> None:
    """§4.2: «el costo propaga al plato (en la referencia no propagaba)».

    Cadena de tres eslabones: insumo → preparación (modo explotado) → plato.
    Cambiar el costo oficial del insumo tiene que mover los dos de arriba en el
    mismo acto, sin recalcular nada a mano y sin tocar la ficha.

    **Ronda 2 — decisión del orquestador (no un defecto)**: `theoretical_cost`
    y `unit_cost` de `recipes` pasan a **texto decimal en pesos**, la misma
    forma que ya usaba `inventory`, para cerrar B-2 sin inventar una escala
    nueva. Las cuatro aserciones comparan el **valor** con `Decimal`, no el
    tipo; los números esperados ($5/g, $8/g, $1.000 y $1.600) no cambiaron.
    """
    tomate = make_ingredient(admin_client, store, name="Tomate", official_cost="5", min_stock="1000")
    hogao = make_preparation(
        admin_client,
        store,
        name="Hogao",
        mode="exploded",
        standard_yield_qty="1000",
        standard_yield_unit="g",
        lines=[{"ingredient_id": tomate["id"], "qty": "1000", "unit": "g"}],
    )
    product = sales_products["inc8"]
    antes = put_recipe(admin_client, product.id, [{"preparation_id": hogao["id"], "qty": "200", "unit": "g"}])

    # 1000 g de tomate a $5/g rinden 1000 g de hogao -> $5/g de hogao.
    # 200 g de hogao en el plato -> $1.000.
    assert Decimal(str(antes["theoretical_cost"])) == Decimal("1000"), antes

    prep_antes = admin_client.get(f"{API}/admin/preparations?store_id={store.id}").json()
    hogao_antes = next(p for p in prep_antes if p["id"] == hogao["id"])
    assert Decimal(str(hogao_antes["unit_cost"])) == Decimal("5"), hogao_antes
    assert hogao_antes["cost_source"] == "official"

    # El dueño corrige el costo oficial del tomate: $5 -> $8.
    patched = admin_client.patch(f"{API}/admin/ingredients/{tomate['id']}", json={"official_cost": "8"})
    assert patched.status_code == 200, patched.text

    prep_despues = admin_client.get(f"{API}/admin/preparations?store_id={store.id}").json()
    hogao_despues = next(p for p in prep_despues if p["id"] == hogao["id"])
    assert Decimal(str(hogao_despues["unit_cost"])) == Decimal("8"), (
        f"el costo del insumo no propagó a la preparación: {hogao_despues}"
    )

    despues = admin_client.get(f"{API}/admin/products/{product.id}/recipe").json()
    assert Decimal(str(despues["theoretical_cost"])) == Decimal("1600"), (
        f"el costo de la preparación no propagó al plato: {despues}"
    )
    assert despues["version"] == antes["version"], "propagar un costo no puede crear una versión de ficha"


def test_food_cost_pct_is_cost_over_net_price_never_over_the_price_with_tax(
    db: Any, store: Any, admin_client: Any, sales_products: Any
) -> None:
    """§4.3: «food cost % = costo ÷ precio **neto de impuesto**». La sede de los
    tests vende con impuesto incluido (INC 8 %): usar el precio de vitrina como
    denominador da un food cost sistemáticamente optimista.

    **Ronda 2 — decisión del orquestador (no un defecto)**: `theoretical_cost`
    pasa a texto decimal en pesos (cierre de B-2). La aserción compara el
    **valor** con `Decimal`; el $7.000 esperado no cambió. `net_price` sigue
    siendo un entero de pesos: es plata de venta, no un costo por unidad base,
    y `app/core/money.py` manda sobre él.
    """
    insumo = make_ingredient(admin_client, store, name="Insumo fc", official_cost="1", min_stock="1000")
    product = sales_products["inc8"]  # $25.000 con impuesto incluido, INC 8 %
    ficha = put_recipe(admin_client, product.id, [{"ingredient_id": insumo["id"], "qty": "7000", "unit": "g"}])

    assert Decimal(str(ficha["theoretical_cost"])) == Decimal("7000"), ficha
    # Neto = 25.000 / 1,08 = 23.148 (redondeo del backend); nunca 25.000.
    assert ficha["net_price"] < 25_000, "el food cost se calculó sobre el precio con impuesto"
    esperado = round(100 * 7000 / ficha["net_price"], 2)
    assert abs(float(ficha["food_cost_pct"]) - esperado) < 0.05, ficha


# ---------------------------------------------------------------------------
# La ficha versiona y el snapshot aguanta (regla dura)
# ---------------------------------------------------------------------------


def test_an_item_sold_against_v1_keeps_reporting_v1_cost_after_v2_is_saved(
    db: Any, store: Any, admin_client: Any, device_client: Any, open_shift: Any, sales_products: Any
) -> None:
    """§11.2 y §4.3: «precio, impuesto, costo teórico y receta usada se congelan
    al vender; los reportes nunca revaloran ventas pasadas con la carta
    actual».

    Es el invariante que hace auditable el margen histórico. Si el reporte
    vuelve a la ficha de hoy, cualquier corrección de receta reescribe el
    pasado — y el dueño no tiene manera de darse cuenta.

    **Ronda 2 — decisión del orquestador (no un defecto)**: el costo que
    publica la **ficha** (`theoretical_cost`) pasa a texto decimal en pesos
    para cerrar B-2; las dos aserciones sobre la ficha comparan el valor con
    `Decimal` y los $200/$400 esperados no cambiaron. El **snapshot**
    `order_items.unit_cost` NO cambia: es plata de venta ya cerrada y sigue
    siendo un entero de pesos, así que las aserciones sobre el ítem vendido
    quedan tal cual — y esa diferencia es justamente lo que este test fija.
    """
    insumo = make_ingredient(admin_client, store, name="Arroz", official_cost="2", min_stock="1000")
    product = sales_products["inc8"]
    v1 = put_recipe(admin_client, product.id, [{"ingredient_id": insumo["id"], "qty": "100", "unit": "g"}])
    assert v1["version"] == 1 and Decimal(str(v1["theoretical_cost"])) == Decimal("200"), v1

    open_shift()
    order = create_order(device_client).json()
    order = add_items(device_client, order, [{"product_id": product.id, "qty": 1}]).json()
    assert send(device_client, order).status_code == 200

    from sqlalchemy import select

    from app.orders.models import OrderItem

    item = db.execute(select(OrderItem).where(OrderItem.order_id == order["id"])).scalars().one()
    assert (item.recipe_version, item.unit_cost) == (1, 200)

    # La v2 duplica la cantidad de arroz (y por lo tanto el costo del plato).
    v2 = put_recipe(
        admin_client, product.id, [{"ingredient_id": insumo["id"], "qty": "200", "unit": "g"}], version=1
    )
    assert v2["version"] == 2 and Decimal(str(v2["theoretical_cost"])) == Decimal("400"), v2

    db.expire_all()
    item = db.execute(select(OrderItem).where(OrderItem.order_id == order["id"])).scalars().one()
    assert item.recipe_version == 1, "el ítem vendido cambió de versión de receta al guardar la v2"
    assert item.unit_cost == 200, "guardar la v2 revaloró una venta pasada"


def test_old_recipe_versions_are_kept_because_sold_items_point_at_them(
    db: Any, store: Any, admin_client: Any, sales_products: Any
) -> None:
    """§4.3: «la ficha versiona y las versiones viejas se conservan, porque los
    ítems vendidos apuntan a ellas». Un `UPDATE` sobre la versión vigente
    borraría la única prueba de con qué se costeó una venta."""
    from sqlalchemy import select

    from app.recipes.models import Recipe, RecipeVersion

    insumo = make_ingredient(admin_client, store, name="Papa", official_cost="1", min_stock="1000")
    product = sales_products["inc8"]
    put_recipe(admin_client, product.id, [{"ingredient_id": insumo["id"], "qty": "100", "unit": "g"}])
    put_recipe(admin_client, product.id, [{"ingredient_id": insumo["id"], "qty": "150", "unit": "g"}], version=1)
    put_recipe(admin_client, product.id, [{"ingredient_id": insumo["id"], "qty": "200", "unit": "g"}], version=2)

    recipe = db.execute(select(Recipe).where(Recipe.product_id == product.id)).scalars().one()
    versions = sorted(
        v.version for v in db.execute(select(RecipeVersion).where(RecipeVersion.recipe_id == recipe.id)).scalars()
    )
    assert versions == [1, 2, 3], f"se perdieron versiones de la ficha: {versions}"
    assert recipe.current_version == 3


def test_saving_a_recipe_against_a_stale_version_is_refused(
    db: Any, store: Any, admin_client: Any, sales_products: Any
) -> None:
    """Dos administradores editando la misma ficha: el que llega con la versión
    vieja no puede pisar la del otro en silencio (§11.9, concurrencia con
    `409`; la ficha es el insumo del costo de toda venta futura)."""
    insumo = make_ingredient(admin_client, store, name="Cebolla", official_cost="1", min_stock="1000")
    product = sales_products["inc8"]
    put_recipe(admin_client, product.id, [{"ingredient_id": insumo["id"], "qty": "100", "unit": "g"}])

    resp = admin_client.put(
        f"{API}/admin/products/{product.id}/recipe",
        json={"version": 0, "lines": [{"ingredient_id": insumo["id"], "qty": "999", "unit": "g"}]},
    )
    assert resp.status_code == 409, resp.text
    assert resp.json()["error"]["code"] == "RECIPE_VERSION_STALE"


# ---------------------------------------------------------------------------
# Cantidades sin `float` (test de propiedad, 1.000 casos)
# ---------------------------------------------------------------------------


def test_quantities_are_exact_integers_over_a_thousand_random_cases() -> None:
    """Convención de ingeniería del pedido: «un `0.1 + 0.2` en una varianza es
    un bug que nadie encuentra».

    Tres propiedades sobre 1.000 casos con semilla fija (`random.Random(
    20260915)`, la misma que usa el auditor de la venta, sin dependencias
    nuevas):

    1. `0,1 + 0,2` de la unidad base da **exactamente** `0,3`.
    2. Sumar N cantidades es asociativo y conmutativo exacto (el orden no
       cambia el total).
    3. Ida y vuelta por el borde (`parse_qty_base` -> `format_qty_base`) no
       pierde ni inventa nada.
    """
    from app.core.quantity import format_qty_base, parse_qty_base

    # 1. El caso canónico, escrito tal cual lo dice el checklist.
    assert parse_qty_base("0.1") + parse_qty_base("0.2") == parse_qty_base("0.3")
    assert parse_qty_base("0,1") + parse_qty_base("0,2") == parse_qty_base("0.3")

    rng = random.Random(20260915)
    for _ in range(1000):
        n = rng.randint(2, 12)
        textos = [f"{rng.randint(0, 5000)}.{rng.randint(0, 999):03d}" for _ in range(n)]
        cantidades = [parse_qty_base(t) for t in textos]

        assert all(isinstance(q, int) for q in cantidades)

        total = sum(cantidades)
        barajado = cantidades[:]
        rng.shuffle(barajado)
        assert sum(barajado) == total, "la suma de cantidades dependió del orden"

        # Asociatividad explícita: partir en dos mitades y sumar las mitades.
        corte = rng.randint(1, n - 1)
        assert sum(cantidades[:corte]) + sum(cantidades[corte:]) == total

        # Restar todo lo sumado vuelve exactamente a cero (nunca 1e-17).
        restado = total
        for q in barajado:
            restado -= q
        assert restado == 0

        # Ida y vuelta por el borde.
        for texto, qty in zip(textos, cantidades):
            assert parse_qty_base(format_qty_base(qty)) == qty


def test_a_quantity_sent_as_a_json_number_is_refused_at_the_edge(
    db: Any, store: Any, admin_client: Any
) -> None:
    """La defensa del contrato numérico tiene que estar en el **borde**, no en
    la convención: si la API acepta `18.5` como número JSON, el `float` entra
    al sistema y ya nadie lo saca. El esquema exige texto decimal."""
    resp = admin_client.post(
        f"{API}/admin/ingredients?store_id={store.id}",
        json={
            "name": "Float",
            "base_unit": "g",
            "purchase_unit": "kg",
            "purchase_factor": 1000,
            "min_stock": 18.5,  # número JSON, no string
        },
    )
    assert resp.status_code == 400, resp.text
    assert set(resp.json()["error"]) >= {"code", "message"}


def test_no_quantity_ever_leaves_the_api_as_a_json_float(
    db: Any, store: Any, admin_client: Any, device_client: Any, open_shift: Any, sales_products: Any
) -> None:
    """La otra mitad del mismo contrato: una cantidad que **sale** como número
    JSON se convierte en `float` en el navegador y vuelve como `float` en el
    próximo `PUT`. Las cantidades salen como texto decimal."""
    ingrediente = make_ingredient(admin_client, store, name="Salida", official_cost="3.5", min_stock="250")
    product = sales_products["inc8"]
    put_recipe(admin_client, product.id, [{"ingredient_id": ingrediente["id"], "qty": "12.5", "unit": "g"}])
    open_shift()

    superficies = [
        admin_client.get(f"{API}/admin/ingredients?store_id={store.id}"),
        admin_client.get(f"{API}/admin/inventory/stock?store_id={store.id}"),
        admin_client.get(f"{API}/admin/products/{product.id}/recipe"),
        admin_client.get(f"{API}/admin/preparations?store_id={store.id}"),
        device_client.get(f"{API}/device/ingredients"),
    ]
    for resp in superficies:
        assert resp.status_code == 200, resp.text
        _assert_no_float_in(resp.json(), path=resp.request.url.path, allow={"food_cost_pct", "ratio"})


def _assert_no_float_in(value: Any, *, path: str, allow: set[str], key: str | None = None) -> None:
    if isinstance(value, dict):
        for k, v in value.items():
            _assert_no_float_in(v, path=path, allow=allow, key=str(k))
    elif isinstance(value, list):
        for v in value:
            _assert_no_float_in(v, path=path, allow=allow, key=key)
    elif isinstance(value, float):
        assert key in allow, f"{path} devolvió la cantidad `{key}` como float JSON ({value!r})"


# ---------------------------------------------------------------------------
# Umbral de stock mínimo obligatorio
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("min_stock", ["0", "0.000", "-1", "-0.5"])
def test_an_ingredient_cannot_be_created_with_a_min_stock_of_zero_or_less(
    db: Any, store: Any, admin_client: Any, min_stock: str
) -> None:
    """§4.1 y §11.7: «umbral de stock mínimo obligatorio, nunca cero» — en la
    referencia 55 de 56 productos quedaron con el motor de alertas apagado
    porque el umbral por defecto era 0 y nadie lo tocó.

    El `400` además tiene que **nombrar la acción correctiva** (§11.18): decir
    "valor inválido" no le dice al dueño qué hacer.
    """
    resp = admin_client.post(
        f"{API}/admin/ingredients?store_id={store.id}",
        json={
            "name": f"Umbral {min_stock}",
            "base_unit": "g",
            "purchase_unit": "kg",
            "purchase_factor": 1000,
            "min_stock": min_stock,
        },
    )
    assert resp.status_code == 400, resp.text
    error = resp.json()["error"]
    assert error["code"] == "MIN_STOCK_REQUIRED", error
    assert "mayor" in error["message"].lower() or "umbral" in error["message"].lower()


def test_an_existing_ingredient_cannot_be_patched_down_to_a_zero_threshold(
    db: Any, store: Any, admin_client: Any
) -> None:
    """La misma regla por la puerta de atrás: si `PATCH` la deja pasar, el
    umbral se apaga igual y el motor de alertas se calla igual."""
    ingrediente = make_ingredient(admin_client, store, name="Umbral patch", min_stock="500")
    resp = admin_client.patch(f"{API}/admin/ingredients/{ingrediente['id']}", json={"min_stock": "0"})
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "MIN_STOCK_REQUIRED"


# ---------------------------------------------------------------------------
# El cero mudo por redondeo: los costos de esta fase son POR UNIDAD BASE
# ---------------------------------------------------------------------------


def test_a_real_cost_below_one_peso_is_never_reported_as_zero(
    db: Any, store: Any, admin_client: Any, device_client: Any, open_shift: Any, sales_products: Any
) -> None:
    """§4.1: «todo costo viaja con su origen; **nunca un cero mudo**» — y
    `AGENTS.md`: «`null` no es 0».

    Los costos de 2a no son precios de venta: son **por unidad base** (por
    gramo, por mililitro). La sal de mesa que carga el propio seed de
    desarrollo vale `0.003` por gramo ($3.000 el bulto de 25 kg). Redondear
    eso a pesos enteros en el borde de la API produce un `0` con origen
    `official`/`estimated`: la respuesta afirma que **sabe** el costo y a la
    vez dice que es cero, que es exactamente la combinación que la regla
    prohíbe — y es peor que `null`, porque `null` al menos se puede detectar.

    Se revisan las tres superficies donde el costo por unidad base sale hacia
    afuera: el insumo, la preparación y la ficha del plato.

    **Ronda 2 — decisión del orquestador, y por qué el guard se ENDURECE**:
    todo costo publicado por `recipes` pasa a texto decimal en pesos (la forma
    que `inventory` ya usaba), que es como se cierra B-2 sin inventar una
    escala nueva. Con strings, `fila["unit_cost"] == 0` es **falso siempre**,
    incluso cuando el campo vale `"0"`: el guard escrito contra enteros dejaría
    de cazar un cero real y se volvería un test que no puede fallar, que es
    peor que no tenerlo. Por eso ahora se exige `Decimal(...) != 0` cuando el
    campo no es `None` y el origen no es `none`, que es la regla de §4.1 dicha
    en positivo: si la respuesta afirma que **sabe** el costo, el costo no
    puede ser cero.
    """
    sal = make_ingredient(admin_client, store, name="Sal de mesa", official_cost="0.003", min_stock="1000")

    # (1) El insumo: `format_cost_micros` conserva la precisión. Este es el
    # comportamiento correcto, y sirve de referencia para los otros dos.
    assert sal["cost"] == "0.003", sal
    assert sal["cost_source"] == "official"

    # (2) La preparación: costo por gramo de una preparación hecha sólo de sal.
    prep = make_preparation(
        admin_client, store, name="Salmuera", mode="exploded",
        standard_yield_qty="1000", standard_yield_unit="g",
        lines=[{"ingredient_id": sal["id"], "qty": "1000", "unit": "g"}],
    )
    listado = admin_client.get(f"{API}/admin/preparations?store_id={store.id}").json()
    fila = next(p for p in listado if p["id"] == prep["id"])
    if fila["cost_source"] != "none":
        assert fila["unit_cost"] is not None, (
            f"la preparación afirma origen «{fila['cost_source']}» y no trae costo: {fila}"
        )
        assert Decimal(str(fila["unit_cost"])) != 0, (
            f"la preparación reporta costo 0 con origen «{fila['cost_source']}»: "
            "un costo real por gramo menor a un peso se redondeó a cero"
        )
    assert Decimal(str(fila["unit_cost"])) == Decimal("0.003"), (
        f"el costo por gramo de una preparación hecha sólo de sal no es el de la sal: {fila}"
    )

    # (3) La ficha del plato: 100 g de sal = $0,30.
    product = sales_products["inc8"]
    ficha = put_recipe(admin_client, product.id, [{"ingredient_id": sal["id"], "qty": "100", "unit": "g"}])
    if ficha["cost_source"] != "none":
        assert ficha["theoretical_cost"] is not None, (
            f"la ficha afirma origen «{ficha['cost_source']}» y no trae costo teórico: {ficha}"
        )
        assert Decimal(str(ficha["theoretical_cost"])) != 0, (
            f"la ficha reporta costo teórico 0 con origen «{ficha['cost_source']}»: {ficha}"
        )
    assert Decimal(str(ficha["theoretical_cost"])) == Decimal("0.3"), (
        f"100 g de sal a $0,003/g son $0,30 y la ficha dice otra cosa: {ficha}"
    )


def _declared_types(schema: dict[str, Any]) -> set[str]:
    """Tipos JSON que un esquema de propiedad declara, aplanando el `anyOf`
    con el que Pydantic v2 expresa `X | None`."""
    tipos: set[str] = set()
    if "type" in schema:
        tipos.add(str(schema["type"]))
    for rama in schema.get("anyOf", []) or schema.get("oneOf", []):
        tipos |= _declared_types(rama)
    return tipos


def _cost_properties_of(name: str, schema: dict[str, Any]) -> list[tuple[str, str, dict[str, Any]]]:
    """`(esquema, propiedad, sub-esquema)` de toda propiedad que sea un costo.

    Regla de nombre deliberadamente **amplia** (`cost` o `*_cost`) para que un
    campo de costo agregado mañana quede cubierto sin tocar este test. Se
    excluyen los `clear_*`, que son banderas booleanas de "borrá este costo"
    (`IngredientUpdateIn.clear_official_cost`) y no un costo, y `*_pct`, que es
    un porcentaje (`food_cost_pct`) y no plata.
    """
    encontradas = []
    for prop, sub in (schema.get("properties") or {}).items():
        if prop.startswith("clear_") or prop.endswith("_pct"):
            continue
        if prop == "cost" or prop.endswith("_cost"):
            encontradas.append((name, prop, sub))
    return encontradas


def test_no_cost_field_of_inventory_or_recipes_is_typed_as_an_integer(client: Any) -> None:
    """§4.1 («nunca un cero mudo») sobre el **contrato publicado**, no sobre una
    respuesta concreta.

    **Decisión del orquestador en la ronda 2**, y la razón por la que este
    invariante existe: todo costo de `inventory` y de `recipes` es un costo
    **por unidad base** (por gramo, por mililitro, por unidad) y se publica como
    **texto decimal en pesos** con precisión completa (`format_cost_micros`).
    Un campo de costo declarado `integer` en el OpenAPI sólo puede ser una de
    las dos formas en que se manifestó B-2, y las dos son graves:

    - **pesos enteros redondeados** — la sal del seed vale $0,003/g y se
      publica como `0` con `cost_source="official"`: la respuesta afirma que
      sabe el costo y dice que es cero, exactamente lo que §4.1 prohíbe; o
    - **micros crudos sin escalar** — un número un millón de veces más grande
      que el que lee quien consume la API.

    Se audita el **esquema** y no la respuesta a propósito: una respuesta puede
    tener un valor que casualmente no delata la escala (`5` es un costo válido
    en pesos y un costo absurdo en micros), el tipo declarado no. Y se audita
    también por anotación de Pydantic, porque varias rutas de estos dos
    dominios devuelven `Any` para poder servir `format=csv` y por eso su
    esquema de respuesta **no llega al OpenAPI**: dejar el barrido sólo en el
    OpenAPI sería no mirar justo donde el contrato está menos declarado.

    El snapshot `order_items.unit_cost` queda **fuera** y sigue siendo entero
    de pesos: es plata de venta ya cerrada (`app/core/money.py`), no un costo
    por unidad base — por eso el barrido se acota a los esquemas de estos dos
    dominios y no a todo el OpenAPI.
    """
    import app.inventory.schemas as inventory_schemas
    import app.recipes.schemas as recipes_schemas
    from pydantic import BaseModel

    modelos: dict[str, Any] = {}
    for modulo in (inventory_schemas, recipes_schemas):
        for atributo in vars(modulo).values():
            if isinstance(atributo, type) and issubclass(atributo, BaseModel) and atributo is not BaseModel:
                modelos[atributo.__name__] = atributo
    assert modelos, "no se encontró ningún esquema de `inventory`/`recipes`"

    spec = client.get("/openapi.json").json()
    publicados = spec["components"]["schemas"]

    revisadas: list[str] = []
    ofensoras: list[str] = []
    for nombre, modelo in sorted(modelos.items()):
        # Preferimos el esquema tal como lo publica el OpenAPI; si la ruta
        # devuelve `Any` (CSV) y el esquema no llega, lo generamos del modelo.
        esquema = publicados.get(nombre) or modelo.model_json_schema()
        origen = "OpenAPI" if nombre in publicados else "anotación Pydantic (no llega al OpenAPI)"
        for _, prop, sub in _cost_properties_of(nombre, esquema):
            revisadas.append(f"{nombre}.{prop}")
            tipos = _declared_types(sub)
            if "integer" in tipos or "number" in tipos:
                ofensoras.append(f"{nombre}.{prop} declarado {sorted(tipos)} [{origen}]")
            elif "string" not in tipos:
                ofensoras.append(f"{nombre}.{prop} no declara `string`: {sorted(tipos)} [{origen}]")

    assert not ofensoras, (
        "hay campos de costo de `inventory`/`recipes` tipados como número y no como texto decimal: "
        + "; ".join(sorted(ofensoras))
    )

    # Y que el barrido no pueda pasar por vacío: si alguien renombra los
    # esquemas, este test tiene que romperse en vez de dejar de mirar.
    criticos = {
        "IngredientOut.cost",
        "IngredientOut.official_cost",
        "IngredientOut.estimated_cost",
        "PreparationAdminOut.unit_cost",
        "PrepBatchAdminOut.unit_cost",
        "PrepBatchAdminOut.total_cost",
        "ProductRecipeOut.theoretical_cost",
        "StockRowOut.cost",
        "StockMovementOut.cost",
        "WasteAdminOut.cost",
    }
    faltantes = criticos - set(revisadas)
    assert not faltantes, f"el barrido no llegó a campos de costo que sí existen: {sorted(faltantes)}"


# ---------------------------------------------------------------------------
# Lo que ganan los reportes que YA existen (§10, contrato de la API del pedido)
# ---------------------------------------------------------------------------


def _sale_with_recipe(
    admin_client: Any, device_client: Any, store: Any, product: Any, *, cost_per_g: str = "10"
) -> dict[str, Any]:
    ingrediente = make_ingredient(
        admin_client, store, name=f"Insumo reporte {product.id}", official_cost=cost_per_g, min_stock="1000"
    )
    put_recipe(admin_client, product.id, [{"ingredient_id": ingrediente["id"], "qty": "100", "unit": "g"}])
    order = create_order(device_client).json()
    order = add_items(device_client, order, [{"product_id": product.id, "qty": 1}]).json()
    assert send(device_client, order).status_code == 200
    return order


def test_the_sales_report_gains_theoretical_cost_gross_margin_and_costed_share(
    db: Any, store: Any, admin_client: Any, device_client: Any, open_shift: Any, sales_products: Any
) -> None:
    """Contrato del pedido: «`GET /admin/sales` gana `theoretical_cost`,
    `gross_margin` y `costed_pct` (share de ventas que de verdad tuvo
    receta)» — §10, «margen bruto teórico… **con % de venta costeada**».

    El porcentaje de venta costeada es lo que hace honesto al margen: un
    margen calculado sobre el 8 % de las ventas no es un margen, es una
    anécdota. Este test exige que los tres conceptos viajen y que ninguno
    mienta con un `0` cuando lo que corresponde es `null`.

    Este test aceptaba el nombre de la spec **o** el de rodeo que el backend
    publicó para esquivar un barrido mal acotado. El barrido se corrigió y los
    nombres de la spec volvieron, así que acá se exigen tal cual: un invariante
    que tolera dos nombres deja de detectar que el contrato se corrió.
    """
    open_shift()
    order = _sale_with_recipe(admin_client, device_client, store, sales_products["inc8"])
    total = order["totals"]["total"]
    cobro = pay(device_client, order["id"], splits=[{"method": "cash", "amount": total}], tip=NO_TIP)
    assert cobro.status_code == 201, cobro.text

    resp = admin_client.get(
        f"{API}/admin/sales",
        params={"store_id": store.id, "from": "2020-01-01", "to": "2099-12-31", "group_by": "business_date"},
    )
    assert resp.status_code == 200, resp.text
    cuerpo = resp.json()
    bloque = cuerpo.get("total") or cuerpo

    for clave in ("theoretical_cost", "gross_margin", "costed_pct"):
        assert clave in bloque, f"falta `{clave}` (nombre de la spec) en la respuesta: {sorted(bloque)}"
    costo = bloque["theoretical_cost"]
    margen = bloque["gross_margin"]
    costeado = bloque["costed_pct"]

    assert costo == 1000, f"costo teórico del período: {costo}"
    assert margen == bloque["net"] - costo, "el margen bruto no es ventas netas − costo teórico"
    assert costeado == 100, f"la venta estuvo 100 % costeada y el reporte dice {costeado}"


def test_a_period_without_any_recipe_reports_null_not_zero(
    db: Any, store: Any, admin_client: Any, device_client: Any, open_shift: Any, sales_products: Any
) -> None:
    """La otra mitad: un período sin ninguna venta costeada no tiene costo
    teórico **ni** margen. Reportar `0` diría "vendí con margen completo", que
    es la mentira más cara posible (§11.13: «el error tolerable es el que
    muestra menos plata»)."""
    open_shift()
    product = sales_products["excluded"]  # sin ficha
    order = create_order(device_client).json()
    order = add_items(device_client, order, [{"product_id": product.id, "qty": 1}]).json()
    assert send(device_client, order).status_code == 200
    total = order["totals"]["total"] if "totals" in order else None
    order = device_client.get(f"{API}/orders/{order['id']}").json()
    cobro = pay(
        device_client, order["id"], splits=[{"method": "cash", "amount": order["totals"]["total"]}], tip=NO_TIP
    )
    assert cobro.status_code == 201, cobro.text
    assert total is None or True  # el total se relee del servidor, nunca se deriva acá

    resp = admin_client.get(
        f"{API}/admin/sales",
        params={"store_id": store.id, "from": "2020-01-01", "to": "2099-12-31", "group_by": "business_date"},
    )
    assert resp.status_code == 200, resp.text
    bloque = resp.json().get("total") or resp.json()
    for clave in ("theoretical_cost", "gross_margin"):
        assert bloque[clave] is None, f"{clave} devolvió {bloque[clave]!r} sin ninguna venta costeada"


def test_the_employee_activity_report_gains_courtesies_at_cost(
    db: Any, store: Any, admin_client: Any, device_client: Any, identify: Any, employees: Any,
    open_shift: Any, sales_products: Any,
) -> None:
    """Contrato del pedido: «`GET /admin/employees/{id}/activity` gana las
    cortesías **a costo**» (§10: «anulaciones, cortesías, descuentos: n, $, %
    de ventas de la persona…»).

    Una cortesía valorada al precio de venta exagera lo que el restaurante
    regaló y no sirve para decidir nada; valorada al costo es la única cifra
    con la que el dueño puede mirar a alguien a la cara. Hoy el informe por
    persona sólo trae cantidad y monto de venta.
    """
    insumo = make_ingredient(admin_client, store, name="Insumo actividad", official_cost="10", min_stock="1000")
    product = sales_products["inc8"]
    put_recipe(admin_client, product.id, [{"ingredient_id": insumo["id"], "qty": "100", "unit": "g"}])

    open_shift()
    identify(device_client, employees["operator"])
    order = create_order(device_client).json()
    order = add_items(device_client, order, [{"product_id": product.id, "qty": 1}]).json()
    item_id = order["items"][0]["id"]
    cortesia = device_client.post(
        f"{API}/orders/{order['id']}/items/{item_id}/courtesy",
        json={"expected_version": order["version"], "reason": "complaint", "authorizer_pin": "5555"},
    )
    assert cortesia.status_code == 200, cortesia.text
    assert send(device_client, cortesia.json()).status_code == 200

    resp = admin_client.get(
        f"{API}/admin/employees/{employees['operator'].id}/activity",
        params={"store_id": store.id, "from": "2020-01-01", "to": "2099-12-31"},
    )
    assert resp.status_code == 200, resp.text
    cuerpo = resp.json()
    texto = str(cuerpo)
    assert "courtes" in texto, f"el informe por persona no trae cortesías: {sorted(cuerpo)}"

    from tests.audit.conftest import deep_keys

    claves = {k.lower() for k in deep_keys(cuerpo)}
    a_costo = {k for k in claves if "theoretical" in k or ("cost" in k and "courtes" in k)}
    assert a_costo, (
        "las cortesías del informe por persona siguen valoradas sólo a precio de venta: "
        f"no hay ninguna clave de costo teórico en {sorted(claves)}"
    )


def test_the_courtesies_of_admin_orders_do_not_lose_the_sub_peso_cost(
    db: Any, store: Any, admin_client: Any, device_client: Any, identify: Any, employees: Any,
    open_shift: Any, sales_products: Any,
) -> None:
    """§4.1 («nunca un cero mudo») sobre el reporte de cortesías a costo de
    `GET /admin/orders` — el **mismo** defecto que la ronda 2 corrigió en
    `GET /admin/sales`, que sobrevivió en el reporte hermano.

    `app/orders/service.py:2011-2012` suma `OrderItem.unit_cost` (pesos, ya
    redondeado half-up **por ítem** al enviar) × `qty`.
    `app/reports/service.py:154` dejó de hacer exactamente eso en la ronda 2 y
    pasó a acumular `OrderItem.unit_cost_micros`, con el razonamiento escrito
    en su propio docstring: «un plato de $0,30 congela `unit_cost=0`; 100 de
    esos daban $0 en vez de $30». El campo `unit_cost_micros` existe desde esa
    misma ronda y está al lado, en el mismo ítem.

    El caso de este test es literalmente ése: 100 porciones de cortesía de un
    plato cuyo costo real es $0,30 cada una. El restaurante regaló $30 de
    insumo y el reporte dice `0` — y `0` no es `null`: la respuesta afirma que
    valoró las cortesías y que el valor es cero, que es la definición del cero
    mudo. El redondeo del total tiene que pasar **una sola vez, al cerrar el
    total**, no una vez por ítem (`app/core/quantity.py:78-95`).

    **Advertencia, no bloqueante**: el error está acotado a menos de $0,50 por
    ítem, así que con platos de miles de pesos es invisible; muerde sólo con
    costos por porción menores al peso. No se pierde inventario ni plata real —
    se pierde una cifra de un reporte. Pero es el mismo defecto que acaba de
    costar una ronda entera, a dos archivos de distancia y con el campo
    correcto ya disponible.
    """
    from tests.audit.conftest import deep_keys

    # $0,003/g × 100 g = $0,30 por porción. Es el costo de la sal del propio
    # seed de desarrollo, no un número inventado para el test.
    insumo = make_ingredient(admin_client, store, name="Insumo sub peso", official_cost="0.003", min_stock="1000")
    product = sales_products["inc8"]
    put_recipe(admin_client, product.id, [{"ingredient_id": insumo["id"], "qty": "100", "unit": "g"}])

    open_shift()
    identify(device_client, employees["operator"])
    order = create_order(device_client).json()
    order = add_items(device_client, order, [{"product_id": product.id, "qty": 100}]).json()
    item_id = order["items"][0]["id"]
    cortesia = device_client.post(
        f"{API}/orders/{order['id']}/items/{item_id}/courtesy",
        json={"expected_version": order["version"], "reason": "complaint", "authorizer_pin": "5555"},
    )
    assert cortesia.status_code == 200, cortesia.text
    assert send(device_client, cortesia.json()).status_code == 200

    # El snapshot guarda las dos escalas: pesos (0, correcto para UN ítem) y
    # micros (300.000, que es de donde hay que sumar).
    from sqlalchemy import select

    from app.orders.models import OrderItem

    item = db.execute(select(OrderItem).where(OrderItem.id == item_id)).scalars().one()
    assert item.unit_cost == 0 and item.unit_cost_micros == 300_000, (
        f"el snapshot cambió de forma: unit_cost={item.unit_cost}, micros={item.unit_cost_micros}"
    )

    resp = admin_client.get(
        f"{API}/admin/orders",
        params={"store_id": store.id, "from": "2020-01-01", "to": "2099-12-31"},
    )
    assert resp.status_code == 200, resp.text
    cuerpo = resp.json()
    claves = {k for k in deep_keys(cuerpo) if "courtes" in k.lower() and ("theoretical" in k.lower() or "cost" in k.lower())}
    assert claves, f"`GET /admin/orders` dejó de valorar las cortesías a costo: {sorted(deep_keys(cuerpo))}"

    filas = cuerpo["rows"] if isinstance(cuerpo, dict) and "rows" in cuerpo else cuerpo
    fila = next(f for f in filas if f.get("courtesies"))
    valores = {k: fila[k] for k in claves if k in fila}
    assert valores, f"la comanda de la cortesía no trae el valor a costo: {sorted(fila)}"
    for clave, valor in valores.items():
        assert valor != 0, (
            f"`{clave}` reportó 0 sobre 100 cortesías de $0,30 = $30 reales: se sumó "
            "`unit_cost` (pesos, redondeado por ítem) en vez de `unit_cost_micros`. "
            "Es el mismo defecto que la ronda 2 arregló en `app/reports/service.py:154`, "
            "vivo todavía en `app/orders/service.py:2011-2012`"
        )
        assert valor == 30, f"`{clave}` = {valor!r}; 100 × $0,30 = $30"
