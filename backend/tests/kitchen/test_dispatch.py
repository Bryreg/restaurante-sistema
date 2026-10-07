"""`POST /kitchen/orders/{id}/dispatch` — «Despachar Mesa N» del KDS.

El tiquete sale de la pantalla de cocina y el plato NO cambia: sigue
`ready` para que el salón lo lleve y lo marque servido (decisión del dueño,
2026-10-07: el aviso de «listos» de Mesas no puede perderse porque cocina
despachó)."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.orders.conftest import idem_headers


def _ready_order(device_client: TestClient, new_order: Any, add_items: Any, send_order: Any, products: list[Any]) -> dict[str, Any]:
    order = new_order().json()
    order = add_items(order, [{"product_id": p.id, "qty": 1} for p in products]).json()
    order = send_order(order).json()
    resp = device_client.post(f"/api/v1/kitchen/orders/{order['id']}/expedite", headers=idem_headers())
    assert resp.status_code == 200, resp.text
    return order


def _items_on_screen(device_client: TestClient) -> set[int]:
    rounds = device_client.get("/api/v1/kitchen/rounds").json()
    return {i["item_id"] for r in rounds for i in r["items"]}


def test_dispatch_takes_the_ticket_off_the_kitchen_screen_and_keeps_the_dish_ready(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    new_order: Any, add_items: Any, main_product: Any, starter_product: Any, send_order: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = _ready_order(device_client, new_order, add_items, send_order, [main_product, starter_product])
    item_ids = sorted(i["id"] for i in order["items"])
    assert set(item_ids) <= _items_on_screen(device_client)

    resp = device_client.post(
        f"/api/v1/kitchen/orders/{order['id']}/dispatch", json={"item_ids": item_ids}, headers=idem_headers()
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert sorted(body["dispatched_item_ids"]) == item_ids
    assert body["dispatched_by"]["name"] == "Operator"

    # Fuera de la pantalla de cocina…
    assert not (set(item_ids) & _items_on_screen(device_client))
    # …pero el plato sigue listo para el salón: nadie lo marcó servido.
    fresh = device_client.get(f"/api/v1/orders/{order['id']}").json()
    assert {i["status"] for i in fresh["items"]} == {"ready"}

    # Despachar otra vez no repite filas.
    again = device_client.post(
        f"/api/v1/kitchen/orders/{order['id']}/dispatch", json={"item_ids": item_ids}, headers=idem_headers()
    )
    assert again.status_code == 200, again.text
    assert again.json()["dispatched_item_ids"] == []


def test_a_dish_marked_ready_again_after_undo_comes_back_to_the_screen(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    new_order: Any, add_items: Any, main_product: Any, send_order: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = _ready_order(device_client, new_order, add_items, send_order, [main_product])
    item_id = order["items"][0]["id"]
    device_client.post(
        f"/api/v1/kitchen/orders/{order['id']}/dispatch", json={"item_ids": [item_id]}, headers=idem_headers()
    )
    assert item_id not in _items_on_screen(device_client)

    # Se deshace el listo: vuelve a ser trabajo de cocina.
    assert device_client.post(f"/api/v1/kitchen/items/{item_id}/unbump", headers=idem_headers()).status_code == 200
    assert item_id in _items_on_screen(device_client)
    # Y al marcarlo listo de nuevo sigue a la vista: el despacho viejo es de antes.
    assert device_client.post(f"/api/v1/kitchen/items/{item_id}/bump", headers=idem_headers()).status_code == 200
    assert item_id in _items_on_screen(device_client)


def test_dispatch_refuses_dishes_that_are_not_ready(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    new_order: Any, add_items: Any, main_product: Any, send_order: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    order = send_order(order).json()
    item_id = order["items"][0]["id"]

    resp = device_client.post(
        f"/api/v1/kitchen/orders/{order['id']}/dispatch", json={"item_ids": [item_id]}, headers=idem_headers()
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "KITCHEN_DISPATCH_NOT_READY"
    assert item_id in _items_on_screen(device_client)


def test_dispatch_of_an_item_from_another_order_is_404(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    new_order: Any, add_items: Any, main_product: Any, send_order: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    first = _ready_order(device_client, new_order, add_items, send_order, [main_product])
    resp = device_client.post(
        "/api/v1/kitchen/orders/999999/dispatch", json={"item_ids": [first["items"][0]["id"]]}, headers=idem_headers()
    )
    assert resp.status_code == 404, resp.text


def test_dispatch_requires_kitchen_view(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any,
    new_order: Any, add_items: Any, main_product: Any, send_order: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = _ready_order(device_client, new_order, add_items, send_order, [main_product])
    set_feature("kitchen.view", False)
    resp = device_client.post(
        f"/api/v1/kitchen/orders/{order['id']}/dispatch",
        json={"item_ids": [order["items"][0]["id"]]},
        headers=idem_headers(),
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
