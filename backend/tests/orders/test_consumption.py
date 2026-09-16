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

from app.core.quantity import QTY_SCALE, apply_yield


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
