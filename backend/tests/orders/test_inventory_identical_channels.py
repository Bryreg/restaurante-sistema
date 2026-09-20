"""Vender por mesa, por domicilio y por plataforma deja el inventario
IDÉNTICO (pedido 2c, checklist de la spec): hermano de
`tests/orders/test_consumption.py::
test_sale_courtesy_and_staff_meal_leave_inventory_identical` (2a), que
compara venta/cortesía/`staff_meal`. `_freeze_item_consumption` no mira
`order.channel` en ningún momento — este test lo prueba desde el lado de
los canales nuevos."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.orders.conftest import idem_headers


def _stock(db: Any, store: Any, ingredient: Any) -> int:
    from app.inventory import hooks as inventory_hooks

    return inventory_hooks.current_stock(db, store_id=store.id, ingredient_id=ingredient.id)


def test_dine_in_delivery_and_platform_leave_inventory_identical(
    db: Any,
    store: Any,
    identify: Any,
    employees: Any,
    open_shift: Any,
    device_client: TestClient,
    new_order: Any,
    add_items: Any,
    main_product: Any,
    ingredient_seeded: Any,
    set_recipe: Any,
    tables: Any,
    delivery_fee_product: Any,
    courier: Any,
    platform: Any,
) -> None:
    set_recipe(main_product.id, lines=[{"ingredient_id": ingredient_seeded.id, "qty": "100", "unit": "g"}])
    open_shift()
    identify(device_client, employees["operator"])

    def _send(order: dict[str, Any]) -> None:
        resp = device_client.post(f"/api/v1/orders/{order['id']}/send", json={"expected_version": order["version"]}, headers=idem_headers())
        assert resp.status_code == 200, resp.text

    # Mesa.
    stock_0 = _stock(db, store, ingredient_seeded)
    order = new_order(channel="dine_in", table_ids=[tables[0].id]).json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    _send(order)
    delta_dine_in = _stock(db, store, ingredient_seeded) - stock_0

    # Domicilio (el cargo NO tiene receta: no aporta al delta del insumo).
    stock_1 = _stock(db, store, ingredient_seeded)
    order = new_order(
        channel="delivery", delivery={"address": "Cll 1", "phone": "3000000000", "courier_employee_id": courier.id}
    ).json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    _send(order)
    delta_delivery = _stock(db, store, ingredient_seeded) - stock_1

    # Plataforma.
    stock_2 = _stock(db, store, ingredient_seeded)
    order = new_order(channel="platform", platform={"platform_id": platform.id, "external_id": "RAPPI-99"}).json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    _send(order)
    delta_platform = _stock(db, store, ingredient_seeded) - stock_2

    assert delta_dine_in == delta_delivery == delta_platform
    assert delta_dine_in < 0  # de verdad descontó algo en los tres canales
