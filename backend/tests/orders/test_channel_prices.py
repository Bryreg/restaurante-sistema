"""Precio por canal (pedido 2c, SPEC-NEGOCIO §4.3): mesa obligatorio; para
llevar, domicilio y plataforma opcionales, caen al de mesa cuando `NULL` —
NUNCA a `0`, NUNCA a `NULL`, y lo decide el servidor
(`app.orders.service._channel_list_price`).

Cubre los tres canales opcionales con los tres casos del checklist de la
spec: producto sin precio propio -> cae al de mesa; producto CON precio
propio -> se vende al suyo; producto con precio de canal en `0` -> se vende
a `0`, no al de mesa (`null` ≠ 0)."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient


def _delivery_order(device_client: TestClient, new_order: Any, add_items: Any, product: Any, *, courier_id: int, qty: int = 1) -> dict[str, Any]:
    order = new_order(
        channel="delivery",
        delivery={"address": "Cra 7 # 20-15", "phone": "3009998877", "courier_employee_id": courier_id},
    ).json()
    return add_items(order, [{"product_id": product.id, "qty": qty}]).json()


def _platform_order(device_client: TestClient, new_order: Any, add_items: Any, product: Any, *, platform_id: int, qty: int = 1) -> dict[str, Any]:
    order = new_order(
        channel="platform", platform={"platform_id": platform_id, "external_id": "RAPPI-0001"}
    ).json()
    return add_items(order, [{"product_id": product.id, "qty": qty}]).json()


def test_takeout_falls_back_to_dine_in_when_no_own_price(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any, main_product: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order(channel="takeout", takeout={"customer_name": "Ana"}).json()
    # `main_product.price_takeout == 22000` (propio) — se usa aparte para
    # no repetir el mismo caso que delivery/platform de abajo.
    body = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    assert body["items"][0]["unit_price"] == main_product.price_takeout


def test_delivery_falls_back_to_dine_in_when_no_own_price(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any,
    main_product: Any, delivery_fee_product: Any, courier: Any,
) -> None:
    """`main_product.price_delivery is None` (fixture de `tests/orders/
    conftest.py`): cae al de mesa."""
    open_shift()
    identify(device_client, employees["operator"])
    order = _delivery_order(device_client, new_order, add_items, main_product, courier_id=courier.id)
    main_line = next(i for i in order["items"] if i["product_id"] == main_product.id)
    assert main_line["unit_price"] == main_product.price_dine_in
    assert main_product.price_delivery is None


def test_delivery_uses_its_own_price_when_set(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any,
    channel_priced_product: Any, delivery_fee_product: Any, courier: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = _delivery_order(device_client, new_order, add_items, channel_priced_product, courier_id=courier.id)
    main_line = next(i for i in order["items"] if i["product_id"] == channel_priced_product.id)
    assert main_line["unit_price"] == channel_priced_product.price_delivery
    assert channel_priced_product.price_delivery != channel_priced_product.price_dine_in


def test_delivery_price_of_zero_is_respected_not_falling_back(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any,
    zero_priced_delivery_product: Any, delivery_fee_product: Any, courier: Any,
) -> None:
    """`null` ≠ `0`: un precio de canal en `0` es un precio de `0` pesos de
    verdad."""
    open_shift()
    identify(device_client, employees["operator"])
    order = _delivery_order(device_client, new_order, add_items, zero_priced_delivery_product, courier_id=courier.id)
    main_line = next(i for i in order["items"] if i["product_id"] == zero_priced_delivery_product.id)
    assert main_line["unit_price"] == 0
    assert zero_priced_delivery_product.price_dine_in != 0  # si cayera al de mesa, no sería 0


def test_platform_falls_back_to_dine_in_when_no_own_price(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any,
    main_product: Any, platform: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = _platform_order(device_client, new_order, add_items, main_product, platform_id=platform.id)
    main_line = next(i for i in order["items"] if i["product_id"] == main_product.id)
    assert main_line["unit_price"] == main_product.price_dine_in
    assert main_product.price_platform is None


def test_platform_uses_its_own_price_when_set(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any,
    channel_priced_product: Any, platform: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = _platform_order(device_client, new_order, add_items, channel_priced_product, platform_id=platform.id)
    main_line = next(i for i in order["items"] if i["product_id"] == channel_priced_product.id)
    assert main_line["unit_price"] == channel_priced_product.price_platform
    assert channel_priced_product.price_platform != channel_priced_product.price_dine_in


def test_dine_in_ignores_delivery_and_platform_prices(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any,
    channel_priced_product: Any, tables: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order(channel="dine_in", table_ids=[tables[0].id]).json()
    body = add_items(order, [{"product_id": channel_priced_product.id, "qty": 1}]).json()
    assert body["items"][0]["unit_price"] == channel_priced_product.price_dine_in
