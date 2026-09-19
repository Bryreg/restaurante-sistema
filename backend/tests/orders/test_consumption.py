"""Consumo teórico al enviar (SPEC-NEGOCIO §5.3, pedido 2a, `backend-consumo`).

Dueño del test de punta a punta para los tres hooks cruzados de este
territorio: `send` -> consumo (`app.orders.service._freeze_item_consumption`,
que llama `app.recipes.hooks.expand_consumption` y
`app.inventory.hooks.record_movement`), `void` -> `WasteStub`
(`app.orders.service._resolve_waste_stub`), nota "vuelve" -> espejo
(`app.orders.hooks.reverse_item_consumption`).
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.core.quantity import QTY_SCALE, apply_yield, format_qty_base, line_cost_micros, micros_to_pesos


def _stock(db: Any, store: Any, ingredient: Any) -> int:
    from app.inventory import hooks as inventory_hooks

    return inventory_hooks.current_stock(db, store_id=store.id, ingredient_id=ingredient.id)


# ---------------------------------------------------------------------------
# Rendimiento aplicado (`qty ÷ yield_pct`) — el error que subestima todos los
# costos si se olvida.
# ---------------------------------------------------------------------------


def test_send_applies_yield_to_consumption(
    db: Any,
    store: Any,
    identify: Any,
    employees: Any,
    open_shift: Any,
    device_client: TestClient,
    new_order: Any,
    add_items: Any,
    send_order: Any,
    main_product: Any,
    ingredient_seeded: Any,
    set_recipe: Any,
) -> None:
    # La ficha pide 100 g LIMPIOS; `ingredient_seeded.yield_pct == 85`.
    set_recipe(main_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "100", "unit": "g"}])
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()

    resp = send_order(order)
    assert resp.status_code == 200, resp.text

    expected_qty_base = apply_yield(100 * QTY_SCALE, ingredient_seeded.yield_pct)
    assert expected_qty_base > 100 * QTY_SCALE, "el rendimiento < 100% tiene que descontar MÁS que la cantidad limpia"
    assert _stock(db, store, ingredient_seeded) == -expected_qty_base

    # El costo también quedó congelado en el ítem, en pesos, con origen.
    from sqlalchemy import select

    from app.orders.models import OrderItem

    row = db.execute(select(OrderItem).where(OrderItem.order_id == order["id"])).scalars().first()
    assert row.unit_cost is not None
    assert row.cost_source == "official"
    assert row.recipe_version == 1


# ---------------------------------------------------------------------------
# `catalog.recipes` apagada: vender funciona exactamente como en 1b.
# ---------------------------------------------------------------------------


def test_flag_off_keeps_unit_cost_null_and_send_unchanged(
    db: Any,
    store: Any,
    identify: Any,
    employees: Any,
    open_shift: Any,
    set_feature: Any,
    device_client: TestClient,
    new_order: Any,
    add_items: Any,
    send_order: Any,
    main_product: Any,
    ingredient_seeded: Any,
    set_recipe: Any,
) -> None:
    set_recipe(main_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "100", "unit": "g"}])
    set_feature("catalog.recipes", False)
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()

    resp = send_order(order)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["items"][0]["status"] == "sent"  # el envío no se ve afectado

    from sqlalchemy import select

    from app.orders.models import OrderItem

    row = db.execute(select(OrderItem).where(OrderItem.order_id == order["id"])).scalars().first()
    assert row.unit_cost is None
    assert row.cost_source is None  # nunca "0" mudo
    assert row.recipe_version is None
    assert _stock(db, store, ingredient_seeded) == 0  # ningún movimiento: la flag apagada no escribe nada


# ---------------------------------------------------------------------------
# El insumo se descuenta UNA SOLA VEZ: modo lote (al producir) vs modo
# explotado (al enviar) — comparando el saldo final por los dos caminos.
# ---------------------------------------------------------------------------


def test_ingredient_deducted_exactly_once_batch_vs_exploded(
    db: Any,
    store: Any,
    identify: Any,
    employees: Any,
    open_shift: Any,
    device_client: TestClient,
    new_order: Any,
    add_items: Any,
    send_order: Any,
    main_product: Any,
    drink_product: Any,
    ingredient_seeded: Any,
    set_recipe: Any,
    make_preparation: Any,
    produce_preparation: Any,
) -> None:
    prep_batch = make_preparation(
        "Caldo (lote)", mode="batch", standard_yield_qty="1000", standard_yield_unit="g",
        lines=[{"ingredient_id": ingredient_seeded.id, "qty": "850", "unit": "g"}],
    )
    prep_exploded = make_preparation(
        "Caldo (explotada)", mode="exploded", standard_yield_qty="1000", standard_yield_unit="g",
        lines=[{"ingredient_id": ingredient_seeded.id, "qty": "850", "unit": "g"}],
    )
    set_recipe(main_product.id, lines=[{"preparation_id": prep_batch.id, "qty": "1000", "unit": "g"}])
    set_recipe(drink_product.id, lines=[{"preparation_id": prep_exploded.id, "qty": "1000", "unit": "g"}])

    expected_single_deduction = apply_yield(850 * QTY_SCALE, ingredient_seeded.yield_pct)

    # --- Camino "lote": el insumo se descuenta AL PRODUCIR, no al enviar. ---
    stock_0 = _stock(db, store, ingredient_seeded)
    produce_preparation(prep_batch, qty_expected="1000", qty_real="1000")
    stock_after_produce = _stock(db, store, ingredient_seeded)
    assert stock_after_produce - stock_0 == -expected_single_deduction

    open_shift()
    identify(device_client, employees["operator"])
    order_a = new_order().json()
    order_a = add_items(order_a, [{"product_id": main_product.id, "qty": 1}]).json()
    resp_a = send_order(order_a)
    assert resp_a.status_code == 200, resp_a.text
    stock_after_batch_sale = _stock(db, store, ingredient_seeded)
    assert stock_after_batch_sale == stock_after_produce, (
        "enviar el plato en modo lote NO tiene que volver a descontar el insumo: ya lo descontó producir"
    )

    # --- Camino "explotada": el insumo se descuenta AL ENVIAR (nunca se produjo nada). ---
    order_b = new_order().json()
    order_b = add_items(order_b, [{"product_id": drink_product.id, "qty": 1}]).json()
    resp_b = send_order(order_b)
    assert resp_b.status_code == 200, resp_b.text
    stock_after_exploded_sale = _stock(db, store, ingredient_seeded)
    assert stock_after_exploded_sale - stock_after_batch_sale == -expected_single_deduction, (
        "enviar el plato explotado tiene que descontar exactamente una vez, ni cero ni dos"
    )


# ---------------------------------------------------------------------------
# Vender, regalar (cortesía) y comer (staff_meal) dejan el inventario
# IDÉNTICO: un solo camino de consumo para los tres.
# ---------------------------------------------------------------------------


def test_sale_courtesy_and_staff_meal_leave_inventory_identical(
    db: Any,
    store: Any,
    identify: Any,
    employees: Any,
    open_shift: Any,
    set_feature: Any,
    device_client: TestClient,
    new_order: Any,
    add_items: Any,
    send_order: Any,
    main_product: Any,
    ingredient_seeded: Any,
    set_recipe: Any,
) -> None:
    set_feature("pos.staff_meal", True)
    set_recipe(main_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "100", "unit": "g"}])
    open_shift()
    identify(device_client, employees["operator"])

    # Venta normal.
    stock_0 = _stock(db, store, ingredient_seeded)
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    assert send_order(order).status_code == 200
    delta_sale = _stock(db, store, ingredient_seeded) - stock_0

    # Cortesía: se regala DESPUÉS de agregado, ANTES de enviar.
    stock_1 = _stock(db, store, ingredient_seeded)
    order2 = new_order().json()
    order2 = add_items(order2, [{"product_id": main_product.id, "qty": 1}]).json()
    item_id = order2["items"][0]["id"]
    courtesy_resp = device_client.post(
        f"/api/v1/orders/{order2['id']}/items/{item_id}/courtesy",
        json={"expected_version": order2["version"], "reason": "complaint", "authorizer_pin": "9999"},
    )
    assert courtesy_resp.status_code == 200, courtesy_resp.text
    order2 = courtesy_resp.json()
    assert send_order(order2).status_code == 200
    delta_courtesy = _stock(db, store, ingredient_seeded) - stock_1

    # Consumo de personal (`staff_meal`): unit_price siempre 0, canal distinto.
    stock_2 = _stock(db, store, ingredient_seeded)
    order3 = new_order(channel="staff_meal", consumed_by_employee_id=employees["operator2"].id).json()
    order3 = add_items(order3, [{"product_id": main_product.id, "qty": 1}]).json()
    assert send_order(order3).status_code == 200
    delta_staff_meal = _stock(db, store, ingredient_seeded) - stock_2

    assert delta_sale == delta_courtesy == delta_staff_meal
    assert delta_sale < 0  # de verdad descontó algo en los tres casos


# ---------------------------------------------------------------------------
# Anular un ítem ya enviado resuelve su `WasteStub` contra la ficha y NO
# repone inventario.
# ---------------------------------------------------------------------------


def test_void_after_send_resolves_waste_stub_and_does_not_restock(
    db: Any,
    store: Any,
    identify: Any,
    employees: Any,
    open_shift: Any,
    device_client: TestClient,
    new_order: Any,
    add_items: Any,
    send_order: Any,
    main_product: Any,
    ingredient_seeded: Any,
    set_recipe: Any,
) -> None:
    set_recipe(main_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "100", "unit": "g"}])
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    order = send_order(order).json()
    item_id = order["items"][0]["id"]
    stock_after_send = _stock(db, store, ingredient_seeded)
    assert stock_after_send < 0

    void_resp = device_client.post(
        f"/api/v1/orders/{order['id']}/items/{item_id}/void",
        json={"expected_version": order["version"], "reason": "kitchen_error", "authorizer_pin": "9999"},
    )
    assert void_resp.status_code == 200, void_resp.text

    from sqlalchemy import select

    from app.orders.models import WasteStub

    stub = db.execute(select(WasteStub).where(WasteStub.order_item_id == item_id)).scalars().first()
    assert stub is not None
    assert stub.resolved is True
    assert stub.ingredient_id == ingredient_seeded.id

    assert _stock(db, store, ingredient_seeded) == stock_after_send, "no repone inventario: el plato ya se cocinó"


# ---------------------------------------------------------------------------
# La nota "vuelve" es espejo exacto: se lee del LIBRO, nunca de la ficha
# actual (así el saldo vuelve exactamente aunque la ficha haya cambiado).
# ---------------------------------------------------------------------------


def test_reverse_item_consumption_is_exact_mirror_even_after_recipe_changed(
    db: Any,
    store: Any,
    identify: Any,
    employees: Any,
    open_shift: Any,
    device_client: TestClient,
    new_order: Any,
    add_items: Any,
    send_order: Any,
    main_product: Any,
    ingredient_seeded: Any,
    set_recipe: Any,
    admin_actor: Any,
) -> None:
    from app.core import clock
    from app.orders import hooks as orders_hooks
    from app.orders.models import OrderItem

    recipe_out = set_recipe(main_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "100", "unit": "g"}])
    assert recipe_out.version == 1

    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    order = send_order(order).json()
    item_id = order["items"][0]["id"]
    stock_before_reversal = _stock(db, store, ingredient_seeded)
    assert stock_before_reversal < 0

    item_row = db.get(OrderItem, item_id)
    assert item_row.recipe_version == 1

    # La ficha cambia DESPUÉS del envío (v2, otra cantidad): el espejo tiene
    # que ignorar esto por completo.
    set_recipe(main_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "9999", "unit": "g"}], version=1)

    orders_hooks.reverse_item_consumption(db, item=item_row, actor=admin_actor, now=clock.now_utc())
    db.commit()

    assert _stock(db, store, ingredient_seeded) == 0, "el espejo tiene que cancelar EXACTAMENTE lo que se había descontado"


# ---------------------------------------------------------------------------
# Consumos del mismo insumo se fusionan en un movimiento: un combo cuyos DOS
# componentes comparten un insumo termina en una sola fila del libro (la
# fusión de `record_movement`, no una pre-suma en Python).
# ---------------------------------------------------------------------------


def test_combo_components_sharing_ingredient_fuse_into_one_movement(
    db: Any,
    store: Any,
    identify: Any,
    employees: Any,
    open_shift: Any,
    device_client: TestClient,
    new_order: Any,
    add_items: Any,
    send_order: Any,
    main_product: Any,
    drink_product: Any,
    ingredient_seeded: Any,
    set_recipe: Any,
) -> None:
    from app.catalog.models import Combo, ComboGroup, ComboOption
    from app.core import clock as clock_module

    set_recipe(main_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "60", "unit": "g"}])
    set_recipe(drink_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "40", "unit": "g"}])

    now = clock_module.now_utc()
    combo = Combo(
        organization_id=store.organization_id, store_id=store.id, name="Combo prueba", price=15000, active=True,
        schedule={"days": [0, 1, 2, 3, 4, 5, 6], "from": "00:00", "to": "23:59"}, created_at=now, updated_at=now,
    )
    db.add(combo)
    db.flush()
    group_a = ComboGroup(organization_id=store.organization_id, store_id=store.id, combo_id=combo.id, name="Plato", sort_order=0)
    group_b = ComboGroup(organization_id=store.organization_id, store_id=store.id, combo_id=combo.id, name="Bebida", sort_order=1)
    db.add_all([group_a, group_b])
    db.flush()
    option_a = ComboOption(organization_id=store.organization_id, store_id=store.id, combo_group_id=group_a.id, product_id=main_product.id, active_today=True, available_today=True)
    option_b = ComboOption(organization_id=store.organization_id, store_id=store.id, combo_group_id=group_b.id, product_id=drink_product.id, active_today=True, available_today=True)
    db.add_all([option_a, option_b])
    db.commit()

    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(
        order,
        [{"combo_id": combo.id, "qty": 1, "combo_selections": [{"group_id": group_a.id, "option_id": option_a.id}, {"group_id": group_b.id, "option_id": option_b.id}]}],
    ).json()
    resp = send_order(order)
    assert resp.status_code == 200, resp.text

    from sqlalchemy import select

    from app.inventory.models import MovementCause, StockMovement

    item_id = resp.json()["items"][0]["id"]
    rows = list(
        db.execute(
            select(StockMovement).where(
                StockMovement.ref_type == "order_item",
                StockMovement.ref_id == item_id,
                StockMovement.cause == MovementCause.SALE,
                StockMovement.ingredient_id == ingredient_seeded.id,
            )
        ).scalars()
    )
    assert len(rows) == 1, "los dos componentes comparten insumo: tiene que fusionarse en UNA fila, no dos"
    expected = apply_yield(60 * QTY_SCALE, ingredient_seeded.yield_pct) + apply_yield(40 * QTY_SCALE, ingredient_seeded.yield_pct)
    assert -rows[0].qty_base == expected


# ---------------------------------------------------------------------------
# La ficha versiona: un ítem vendido contra la v1 sigue reportando el costo
# de la v1 después de guardar la v2 (snapshot).
# ---------------------------------------------------------------------------


def test_recipe_versioning_freezes_cost_of_sold_item(
    db: Any,
    store: Any,
    identify: Any,
    employees: Any,
    open_shift: Any,
    device_client: TestClient,
    new_order: Any,
    add_items: Any,
    send_order: Any,
    main_product: Any,
    ingredient_seeded: Any,
    set_recipe: Any,
) -> None:
    from sqlalchemy import select

    from app.orders.models import OrderItem

    set_recipe(main_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "100", "unit": "g"}])
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    order = send_order(order).json()
    item_id = order["items"][0]["id"]

    row_v1 = db.execute(select(OrderItem).where(OrderItem.id == item_id)).scalars().first()
    unit_cost_v1 = row_v1.unit_cost
    recipe_version_v1 = row_v1.recipe_version
    assert recipe_version_v1 == 1
    assert unit_cost_v1 is not None

    # Se guarda la v2 con OTRA cantidad (y por lo tanto otro costo).
    set_recipe(main_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "500", "unit": "g"}], version=1)

    db.expire_all()
    row_after = db.execute(select(OrderItem).where(OrderItem.id == item_id)).scalars().first()
    assert row_after.recipe_version == recipe_version_v1 == 1
    assert row_after.unit_cost == unit_cost_v1, "ningún reporte revalora una venta pasada con la ficha actual"


# ---------------------------------------------------------------------------
# `void_order` comparte el mismo helper (`_resolve_waste_stub`) que
# `void_item`: mismo comportamiento, call site distinto.
# ---------------------------------------------------------------------------


def test_void_order_also_resolves_waste_stub_and_does_not_restock(
    db: Any,
    store: Any,
    identify: Any,
    employees: Any,
    open_shift: Any,
    device_client: TestClient,
    new_order: Any,
    add_items: Any,
    send_order: Any,
    main_product: Any,
    ingredient_seeded: Any,
    set_recipe: Any,
) -> None:
    set_recipe(main_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "100", "unit": "g"}])
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    order = send_order(order).json()
    item_id = order["items"][0]["id"]
    stock_after_send = _stock(db, store, ingredient_seeded)
    assert stock_after_send < 0

    void_resp = device_client.post(
        f"/api/v1/orders/{order['id']}/void",
        json={"expected_version": order["version"], "reason": "kitchen_error", "authorizer_pin": "9999"},
    )
    assert void_resp.status_code == 200, void_resp.text

    from sqlalchemy import select

    from app.orders.models import WasteStub

    stub = db.execute(select(WasteStub).where(WasteStub.order_item_id == item_id)).scalars().first()
    assert stub is not None
    assert stub.resolved is True
    assert stub.ingredient_id == ingredient_seeded.id
    assert _stock(db, store, ingredient_seeded) == stock_after_send


# ---------------------------------------------------------------------------
# Pedido 2b (`backend-lectura-contrato`): `GET /admin/orders/{id}/consumption`
# — la corrección a §5.3 hecha realidad. Test obligatorio del spec.md: las
# DOS mitades en la misma prueba — la lectura agrega (un renglón por
# insumo) y la escritura no fusiona (el libro sigue con una fila por
# `order_item`).
# ---------------------------------------------------------------------------


def test_order_consumption_aggregates_by_ingredient_while_the_ledger_keeps_one_row_per_item(
    db: Any,
    store: Any,
    identify: Any,
    employees: Any,
    open_shift: Any,
    device_client: TestClient,
    admin_client: TestClient,
    new_order: Any,
    add_items: Any,
    send_order: Any,
    main_product: Any,
    drink_product: Any,
    ingredient_seeded: Any,
    set_recipe: Any,
) -> None:
    # Dos platos DISTINTOS de la misma comanda, los dos con el mismo insumo
    # en su ficha: el caso exacto que §5.3 pedía fusionar y que 2a decidió
    # NO fusionar en el libro (`spec.md`, «Corrección a la spec de negocio
    # §5.3»).
    set_recipe(main_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "100", "unit": "g"}])
    set_recipe(drink_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "50", "unit": "g"}])
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(
        order, [{"product_id": main_product.id, "qty": 1}, {"product_id": drink_product.id, "qty": 1}]
    ).json()
    order = send_order(order).json()
    item_ids = [item["id"] for item in order["items"]]
    assert len(item_ids) == 2

    # LA ESCRITURA no fusiona entre ítems: el libro sigue con una fila por
    # `order_item`, aunque los dos consuman el mismo insumo.
    from sqlalchemy import select

    from app.inventory.models import StockMovement

    ledger_rows = db.execute(
        select(StockMovement).where(
            StockMovement.ref_type == "order_item",
            StockMovement.ref_id.in_(item_ids),
            StockMovement.ingredient_id == ingredient_seeded.id,
        )
    ).scalars().all()
    assert len(ledger_rows) == 2, "el libro tiene que guardar UNA fila por order_item, nunca fusionar entre ítems"
    assert {row.ref_id for row in ledger_rows} == set(item_ids)

    # LA LECTURA sí agrega: un solo renglón por insumo para toda la comanda.
    resp = admin_client.get(f"/api/v1/admin/orders/{order['id']}/consumption")
    assert resp.status_code == 200, resp.text
    rows = resp.json()["rows"]
    matching = [r for r in rows if r["ingredient_id"] == ingredient_seeded.id]
    assert len(matching) == 1, "la lectura agregada tiene que dar UN renglón por insumo, sumando las filas del libro"

    expected_qty_base = -(
        apply_yield(100 * QTY_SCALE, ingredient_seeded.yield_pct)
        + apply_yield(50 * QTY_SCALE, ingredient_seeded.yield_pct)
    )
    assert matching[0]["qty_base"] == format_qty_base(expected_qty_base)
    assert matching[0]["name"] == ingredient_seeded.name
    assert matching[0]["preparation_id"] is None


def test_order_consumption_uses_the_frozen_cost_not_todays_price(
    db: Any,
    store: Any,
    identify: Any,
    employees: Any,
    open_shift: Any,
    device_client: TestClient,
    admin_client: TestClient,
    new_order: Any,
    add_items: Any,
    send_order: Any,
    main_product: Any,
    ingredient_seeded: Any,
    set_recipe: Any,
) -> None:
    """Snapshot (regla dura, `AGENTS.md`): la lectura agregada nunca vuelve a
    resolver el costo vigente del insumo, lee el que quedó congelado en cada
    fila del libro al enviar. En 2a un hallazgo rojo (A-6) fue exactamente
    esto por el lado de `recipes.hooks.uncosted_products`; acá se prueba que
    esta pieza nueva no repite el error."""
    set_recipe(main_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "100", "unit": "g"}])
    frozen_cost_micros = ingredient_seeded.official_cost_micros
    assert frozen_cost_micros is not None
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    order = send_order(order).json()

    # El precio del insumo cambia DESPUÉS de enviar — la lectura de esta
    # comanda no puede enterarse.
    ingredient_seeded.official_cost_micros = frozen_cost_micros * 10
    db.add(ingredient_seeded)
    db.commit()

    resp = admin_client.get(f"/api/v1/admin/orders/{order['id']}/consumption")
    assert resp.status_code == 200, resp.text
    row = next(r for r in resp.json()["rows"] if r["ingredient_id"] == ingredient_seeded.id)

    expected_qty_base = -apply_yield(100 * QTY_SCALE, ingredient_seeded.yield_pct)
    expected_cost = micros_to_pesos(line_cost_micros(expected_qty_base, frozen_cost_micros))
    assert row["cost"] == expected_cost, "tiene que valer lo que costaba AL ENVIAR, no el precio de hoy"
    assert row["cost_source"] == "official"


def test_order_consumption_requires_inventory_perpetual_flag(
    db: Any,
    store: Any,
    identify: Any,
    employees: Any,
    open_shift: Any,
    device_client: TestClient,
    admin_client: TestClient,
    new_order: Any,
    add_items: Any,
    send_order: Any,
    main_product: Any,
    ingredient_seeded: Any,
    set_recipe: Any,
    set_feature: Any,
) -> None:
    set_recipe(main_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "100", "unit": "g"}])
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    order = send_order(order).json()

    set_feature("inventory.perpetual", False, store_id=store.id)

    resp = admin_client.get(f"/api/v1/admin/orders/{order['id']}/consumption")
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"


def test_order_consumption_other_org_order_is_404(
    admin_client: TestClient,
    device_client: TestClient,
    identify: Any,
    employees: Any,
    open_shift: Any,
    new_order: Any,
    add_items: Any,
    main_product: Any,
    org_b: Any,
    store_b: Any,
    db: Any,
) -> None:
    from app.auth.models import Employee
    from app.core import clock as clock_module
    from app.core import security

    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()

    other_admin_employee = Employee(
        organization_id=org_b.id, store_id=None, name="Otro Admin", role="admin", pin_hash=security.hash_secret("1234"),
        email="otro-admin-consumo@test.local", password_hash=security.hash_secret("clave1234"), can_charge=False,
        discount_limit_pct=None, document=None, active=True, failed_pin_attempts=0, pin_locked_until=None,
        created_at=clock_module.now_utc(), updated_at=clock_module.now_utc(),
    )
    db.add(other_admin_employee)
    db.commit()

    other_admin = TestClient(admin_client.app)
    login = other_admin.post(
        "/api/v1/auth/admin/login", json={"email": "otro-admin-consumo@test.local", "password": "clave1234"}
    )
    assert login.status_code == 200, login.text

    resp = other_admin.get(f"/api/v1/admin/orders/{order['id']}/consumption")
    assert resp.status_code == 404, resp.text
    assert resp.json()["error"]["code"] == "NOT_FOUND"


def test_order_consumption_route_served_by_orders_not_by_the_duplicate_in_inventory(
    db: Any,
    store: Any,
    identify: Any,
    employees: Any,
    open_shift: Any,
    device_client: TestClient,
    admin_client: TestClient,
    new_order: Any,
    add_items: Any,
    send_order: Any,
    main_product: Any,
    ingredient_seeded: Any,
    set_recipe: Any,
) -> None:
    """Guarda de regresión sobre un conflicto REAL encontrado en la ronda 1
    de este pedido (declarado en `outputs-2b/backend-lectura-contrato.md
    § 8`, resuelto en RONDA 2 — ver también §"Ronda 2" del mismo
    entregable): `app/inventory/router.py` publicaba OTRA ruta `GET
    /admin/orders/{order_id}/consumption` (territorio ajeno, no tocado
    acá), con `store_id` como query param OBLIGATORIO — la de este agente
    nunca lo exigió (`order.store_id` ya lo resuelve solo). El Maestro
    decidió que la implementación de este archivo es la que sobrevive
    (snapshot correcto, consumo neto SALE+NOTE_RETURN, y ya era la que
    despachaba en runtime); `backend-inventario-espejo` retiró su
    duplicado en su propia ronda 2. Esta prueba, que ya pasaba en ronda 1
    porque Starlette hacía *match* de la ruta de `orders` primero
    (`app.main.DOMAINS`), queda como regresión permanente: sin `store_id`
    en la query (la otra implementación lo exigía; esta nunca lo pidió) y
    sirviendo `200`. Las dos pruebas de contrato que siguen
    (`test_order_consumption_is_published_exactly_once_with_this_contract`,
    `test_openapi_generation_raises_no_duplicate_operation_id_warning`)
    son las que ahora prueban, sobre el documento publicado, que el
    duplicado no volvió."""
    set_recipe(main_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "100", "unit": "g"}])
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    order = send_order(order).json()

    # Sin `store_id` en la query: la implementación de `app.inventory.router`
    # lo exige (`Query(...)`) y respondería `422`; la de este archivo no lo
    # pide en absoluto.
    resp = admin_client.get(f"/api/v1/admin/orders/{order['id']}/consumption")
    assert resp.status_code == 200, resp.text
    assert resp.json()["order_id"] == order["id"]


# ---------------------------------------------------------------------------
# RONDA 2 (H-2, bloqueante): el Maestro decidió que la implementación de
# ESTE archivo sobrevive y que `app/inventory/router.py:555` se borra (la
# ejecuta `backend-inventario-espejo`, ya retirada — ver la NOTA en
# `app.inventory.service` y el test de regresión de arriba). Estos dos
# tests prueban, sobre el DOCUMENTO PUBLICADO, que el duplicado no vuelve.
# ---------------------------------------------------------------------------


def test_order_consumption_is_published_exactly_once_with_this_contract(client: Any) -> None:
    """RONDA 2 (H-2, tarea (a)): invariante de contrato sobre el OpenAPI.
    Fija las tres partes que decidió el Maestro:

    1. La ruta `GET /admin/orders/{order_id}/consumption` está publicada
       UNA sola vez.
    2. Su respuesta es `OrderConsumptionOut`: `qty_base` como TEXTO decimal
       (puede ser negativo — salida neta, o `"0"` si una nota «vuelve»
       revirtió exactamente lo vendido) y `cost` entero de pesos o `null`
       (nunca `0` mudo) — y SIN `item_count`, el campo que sólo tenía la
       implementación descartada de `app.inventory`.
    3. La ruta NO declara un parámetro `store_id`: la sede se resuelve de
       `order.store_id`, una sola fuente — la implementación descartada
       pedía `store_id` como query ADEMÁS del `order_id` del path, dos
       fuentes que podían no coincidir."""
    spec = client.get("/openapi.json").json()
    ruta = "/api/v1/admin/orders/{order_id}/consumption"

    ocurrencias = [p for p in spec["paths"] if p == ruta]
    assert ocurrencias == [ruta], f"la ruta tiene que estar publicada una sola vez, encontré: {ocurrencias}"

    operacion = spec["paths"][ruta]["get"]
    nombres_de_parametro = {p["name"] for p in operacion.get("parameters", [])}
    assert "store_id" not in nombres_de_parametro, (
        "la ruta no puede declarar `store_id`: la sede se resuelve de `order.store_id` "
        f"(una sola fuente) — parámetros publicados: {sorted(nombres_de_parametro)}"
    )
    assert nombres_de_parametro == {"order_id"}, f"parámetros inesperados: {sorted(nombres_de_parametro)}"

    ref_respuesta = operacion["responses"]["200"]["content"]["application/json"]["schema"]["$ref"]
    assert ref_respuesta.rsplit("/", 1)[-1] == "OrderConsumptionOut", (
        f"la respuesta publicada tiene que ser `OrderConsumptionOut`, no {ref_respuesta}"
    )

    esquemas = spec["components"]["schemas"]
    order_out = esquemas["OrderConsumptionOut"]
    assert "item_count" not in order_out["properties"], (
        "`item_count` era del diseño descartado de `app.inventory.router` — no puede colarse acá"
    )

    ref_renglon = order_out["properties"]["rows"]["items"]["$ref"].rsplit("/", 1)[-1]
    renglon = esquemas[ref_renglon]
    assert "item_count" not in renglon["properties"], (
        "`item_count` era del diseño descartado de `app.inventory.router` — no puede colarse acá"
    )

    qty_def = renglon["properties"]["qty_base"]
    assert qty_def.get("type") == "string", (
        "`qty_base` tiene que ser texto decimal (puede ser negativo como texto, p.ej. «-1,500»), "
        f"no {qty_def}"
    )

    cost_def = renglon["properties"]["cost"]
    tipos_de_costo = {cost_def.get("type")} | {
        variante.get("type") for variante in cost_def.get("anyOf", []) if isinstance(variante, dict)
    }
    tipos_de_costo.discard(None)
    assert tipos_de_costo == {"integer", "null"}, (
        f"`cost` tiene que ser entero de pesos o `null` (nunca `0` mudo, nunca texto), publicado como {cost_def}"
    )


def test_openapi_generation_raises_no_duplicate_operation_id_warning(client: Any) -> None:
    """RONDA 2 (H-2, tarea (b)): genera el OpenAPI con las `UserWarning`
    convertidas en ERROR (`warnings.simplefilter("error", UserWarning)`) y
    confirma que ya no aparece "Duplicate Operation ID" — la advertencia que
    emitía `app.main.app.openapi()` en ronda 1, mientras `app.orders` y
    `app.inventory` publicaban la misma ruta.

    Fuerza la regeneración real (`app.openapi_schema = None`, antes y
    después): `FastAPI.openapi()` cachea el resultado de la primera llamada
    del proceso, así que sin este reset la prueba podría pasar en falso si
    otro test ya generó el documento antes que este, y contaminaría el
    caché para los que corren después si no lo restaura."""
    import warnings

    from app.main import app as fastapi_app

    fastapi_app.openapi_schema = None
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", UserWarning)
            fastapi_app.openapi()
    except UserWarning as exc:
        assert False, f"generar el OpenAPI sigue emitiendo un UserWarning (p. ej. Duplicate Operation ID): {exc}"
    finally:
        fastapi_app.openapi_schema = None


# ---------------------------------------------------------------------------
# Pedido 2b (`backend-lectura-contrato`): decisión sobre
# `MovementCause.VOID_AFTER_SEND`. En ronda 1 quedó declarada y nunca
# emitida, con el motivo escrito acá (FEFO real dentro de `record_movement`
# desde 2b, ver `app.orders.service._resolve_waste_stub` y `outputs-2b/
# backend-lectura-contrato.md § 6`). En RONDA 2 el Maestro resolvió el rojo
# declarado: la causa se SACÓ del enum (`app/inventory/models.py`, dueño de
# ese archivo). Este territorio nunca la nombró en código ni en un import.
# ---------------------------------------------------------------------------


def test_void_after_send_writes_no_new_movement_and_the_cause_is_gone_from_the_enum(
    db: Any,
    store: Any,
    identify: Any,
    employees: Any,
    open_shift: Any,
    device_client: TestClient,
    new_order: Any,
    add_items: Any,
    send_order: Any,
    main_product: Any,
    ingredient_seeded: Any,
    set_recipe: Any,
) -> None:
    """Cierra el ítem del checklist de 2b sobre `MovementCause.
    VOID_AFTER_SEND` — actualizado en RONDA 2. En la ronda 1 este territorio
    (`app/orders/service.py::_resolve_waste_stub`) había documentado por qué
    NO se produce (par alta+baja que dispararía una segunda depleción FEFO
    real, `outputs-2b/backend-lectura-contrato.md § 6`) y había declarado
    rojo el otro camino que el checklist ofrecía (sacarla del enum), porque
    ese archivo es territorio de `backend-inventario-espejo`. El Maestro
    resolvió ese rojo en Ronda 2: la causa se SACÓ del enum. Este territorio
    nunca la nombró en código ni en un import (sólo en prosa de docstring,
    ya actualizada) — no había nada que sacar acá. Este test fija las DOS
    mitades que le tocan a `tests/orders`:

    1. El enum ya no ofrece esa causa — si alguien la reintroduce sin un
       dueño real que la escriba, esto avisa.
    2. Anular un ítem ya enviado no agrega NINGUNA fila nueva al libro para
       ese insumo (ninguna causa) y el saldo queda exactamente donde lo dejó
       la venta original (una sola matemática, el insumo se descuenta una
       sola vez)."""
    set_recipe(main_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "100", "unit": "g"}])
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    order = send_order(order).json()
    stock_after_send = _stock(db, store, ingredient_seeded)
    assert stock_after_send < 0

    from sqlalchemy import select

    from app.inventory.models import MovementCause, StockMovement

    assert not hasattr(MovementCause, "VOID_AFTER_SEND"), (
        "decisión de Ronda 2: la causa se SACÓ del enum (`app/inventory/models.py`, dueño de ese "
        "archivo) — si reaparece, tiene que venir junto con quien la escriba de verdad"
    )

    rows_before = list(
        db.execute(
            select(StockMovement.id).where(
                StockMovement.store_id == store.id,
                StockMovement.ingredient_id == ingredient_seeded.id,
            )
        ).scalars()
    )

    item_id = order["items"][0]["id"]
    void_resp = device_client.post(
        f"/api/v1/orders/{order['id']}/items/{item_id}/void",
        json={"expected_version": order["version"], "reason": "kitchen_error", "authorizer_pin": "9999"},
    )
    assert void_resp.status_code == 200, void_resp.text

    rows_after = list(
        db.execute(
            select(StockMovement.id).where(
                StockMovement.store_id == store.id,
                StockMovement.ingredient_id == ingredient_seeded.id,
            )
        ).scalars()
    )
    assert rows_after == rows_before, (
        "anular un ítem ya enviado no puede agregar ninguna fila nueva al libro para este insumo "
        "(ninguna causa) — ver el docstring de `_resolve_waste_stub`"
    )
    # El saldo no se movió por anular: sigue siendo la deuda de este ítem,
    # exactamente donde la dejó la venta (regla dura: una sola matemática,
    # el insumo se descuenta una sola vez).
    assert _stock(db, store, ingredient_seeded) == stock_after_send
