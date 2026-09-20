"""«Los canales nuevos en la cola» (§ misión, punto 6): domicilio y
plataforma llegan a cocina igual que mesa/mostrador — el KDS ya lee
`Order.channel` genéricamente (1b), y con `kitchen.kds` encendida agrega lo
que hace falta para no confundir un pedido de plataforma con uno de mesa.
No se agrega ningún campo a `app.orders.models`: todo lo que se muestra acá
ya existe en el modelo."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.orders.conftest import idem_headers


def test_a_delivery_order_reaches_the_kds_queue(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, courier: Any, delivery_fee_product: Any,
    new_order: Any, add_items: Any, main_product: Any, send_order: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order(
        channel="delivery",
        delivery={"address": "Cra 7 # 10-20", "phone": "3001234567", "courier_employee_id": courier.id},
    ).json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    order = send_order(order).json()

    rounds = device_client.get("/api/v1/kitchen/rounds").json()
    assert len(rounds) == 1
    assert rounds[0]["channel"] == "delivery"
    assert rounds[0]["platform"] is None
    # El cargo de domicilio (sin estación) no ensucia la cola de cocina.
    names = {i["name"] for i in rounds[0]["items"]}
    assert names == {"Bandeja Paisa"}


def test_a_platform_order_reaches_the_kds_queue_with_its_platform_info(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, platform: Any,
    new_order: Any, add_items: Any, main_product: Any, send_order: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order(
        channel="platform", platform={"platform_id": platform.id, "external_id": "RAPPI-9001"}
    ).json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    order = send_order(order).json()

    rounds = device_client.get("/api/v1/kitchen/rounds").json()
    assert len(rounds) == 1
    assert rounds[0]["channel"] == "platform"
    assert rounds[0]["platform"] == {"source": "Rappi", "external_id": "RAPPI-9001"}


def test_platform_info_is_not_shown_without_kitchen_kds(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, platform: Any,
    new_order: Any, add_items: Any, main_product: Any, send_order: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order(
        channel="platform", platform={"platform_id": platform.id, "external_id": "RAPPI-9001"}
    ).json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    order = send_order(order).json()

    set_feature("kitchen.kds", False)
    rounds = device_client.get("/api/v1/kitchen/rounds").json()
    assert rounds[0]["channel"] == "platform"  # el canal SIEMPRE se ve (1b)
    assert "platform" not in rounds[0]  # el detalle de la plataforma es de kitchen.kds
