"""`POST/DELETE /orders/{id}/discounts`: motivo tipado, tope de línea, combos
sin descuento de línea, límite por empleado/sede con autorizador."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient


def test_item_discount_never_exceeds_gross(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any, add_items: Any, main_product: Any) -> None:
    set_feature("pos.discounts", True)
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    item_id = order["items"][0]["id"]

    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/discounts",
        json={"expected_version": order["version"], "scope": "item", "item_id": item_id, "kind": "amount", "value": main_product.price_dine_in + 1000, "reason": "promo"},
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "DISCOUNT_EXCEEDS_LINE"


def test_item_discount_within_limit_no_pin(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any, add_items: Any, main_product: Any) -> None:
    set_feature("pos.discounts", True)
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    item_id = order["items"][0]["id"]

    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/discounts",
        json={"expected_version": order["version"], "scope": "item", "item_id": item_id, "kind": "percent", "value": 5, "reason": "promo"},
    )
    assert resp.status_code == 200, resp.text
    discount = resp.json()["discounts"][0]
    assert discount["amount"] == round(main_product.price_dine_in * 0.05)
    assert resp.json()["items"][0]["discount"] == discount["amount"]


def test_discount_over_limit_needs_authorizer(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any, add_items: Any, main_product: Any) -> None:
    set_feature("pos.discounts", True)
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    item_id = order["items"][0]["id"]

    over = device_client.post(
        f"/api/v1/orders/{order['id']}/discounts",
        json={"expected_version": order["version"], "scope": "item", "item_id": item_id, "kind": "percent", "value": 50, "reason": "promo"},
    )
    assert over.status_code == 400, over.text
    err = over.json()["error"]
    assert err["code"] == "DISCOUNT_LIMIT_EXCEEDED"
    assert err["limit_pct"] == 10.0

    ok = device_client.post(
        f"/api/v1/orders/{order['id']}/discounts",
        json={"expected_version": order["version"], "scope": "item", "item_id": item_id, "kind": "percent", "value": 50, "reason": "promo", "authorizer_pin": "9999"},
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["discounts"][0]["authorized_by"]["name"] == "Admin"


def test_combo_rejects_line_discount(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any, add_items: Any, main_product: Any, db: Any) -> None:
    from app.catalog.models import Combo, ComboGroup, ComboOption
    from app.core import clock as clock_module

    set_feature("pos.discounts", True)
    set_feature("pos.combos", True)
    open_shift()
    identify(device_client, employees["operator"])

    now = clock_module.now_utc()
    combo = Combo(organization_id=main_product.organization_id, store_id=main_product.store_id, name="Menú", price=18000, active=True, schedule={"days": [0, 1, 2, 3, 4, 5, 6], "from": "00:00", "to": "23:59"}, created_at=now, updated_at=now)
    db.add(combo)
    db.flush()
    group = ComboGroup(organization_id=combo.organization_id, store_id=combo.store_id, combo_id=combo.id, name="Plato", sort_order=0)
    db.add(group)
    db.flush()
    option = ComboOption(organization_id=combo.organization_id, store_id=combo.store_id, combo_group_id=group.id, product_id=main_product.id, active_today=True, available_today=True)
    db.add(option)
    db.commit()

    order = new_order().json()
    order = add_items(order, [{"combo_id": combo.id, "qty": 1, "combo_selections": [{"group_id": group.id, "option_id": option.id}]}]).json()
    item_id = order["items"][0]["id"]

    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/discounts",
        json={"expected_version": order["version"], "scope": "item", "item_id": item_id, "kind": "amount", "value": 1000, "reason": "promo"},
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "COMBO_NO_LINE_DISCOUNT"


def test_order_discount_prorates_and_remove_restores(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any, add_items: Any, main_product: Any, drink_product: Any) -> None:
    set_feature("pos.discounts", True)
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}, {"product_id": drink_product.id, "qty": 1}]).json()

    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/discounts",
        json={"expected_version": order["version"], "scope": "order", "kind": "percent", "value": 10, "reason": "owner", "authorizer_pin": "9999"},
    )
    assert resp.status_code == 200, resp.text
    order = resp.json()
    assert order["totals"]["discount_total"] == round((main_product.price_dine_in + drink_product.price_dine_in) * 0.10)
    discount_id = order["discounts"][0]["id"]
    assert sum(i["discount"] for i in order["items"]) == order["totals"]["discount_total"]

    removed = device_client.delete(
        f"/api/v1/orders/{order['id']}/discounts/{discount_id}", params={"expected_version": order["version"]}
    )
    assert removed.status_code == 200, removed.text
    assert removed.json()["totals"]["discount_total"] == 0
    assert removed.json()["discounts"] == []


# ---------------------------------------------------------------------------
# Un rechazo no puede dejar nada escrito
# ---------------------------------------------------------------------------
#
# Encontrado jugando una venta real en el navegador: el total de una comanda
# no cuadraba con el libro de descuentos. `add_discount` sumaba a
# `item.discount_amount` ANTES de comprobar el límite del empleado, y
# `get_db` hace `commit()` cuando se levanta un `AppError` —a propósito, para
# que un intento fallido de PIN sobreviva—. Resultado: el operador pedía un
# descuento por encima de su límite, el sistema le decía 400 «pedí el PIN de
# un supervisor», él no lo pedía, y **el descuento quedaba aplicado igual**,
# sin fila en `order_discounts` y sin nada en la auditoría. Repitiendo el
# rechazo se llegaba a un total de $0.
#
# `test_discount_over_limit_needs_authorizer` no lo veía porque sólo miraba
# el código de error y después el caso autorizado: nunca miró la plata.


def test_rejected_discount_leaves_nothing_applied(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any, add_items: Any, main_product: Any) -> None:
    set_feature("pos.discounts", True)
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    item_id = order["items"][0]["id"]
    total_antes = order["totals"]["total"]

    over = device_client.post(
        f"/api/v1/orders/{order['id']}/discounts",
        json={"expected_version": order["version"], "scope": "item", "item_id": item_id, "kind": "percent", "value": 40, "reason": "promo"},
    )
    assert over.status_code == 400
    assert over.json()["error"]["code"] == "DISCOUNT_LIMIT_EXCEEDED"

    after = device_client.get(f"/api/v1/orders/{order['id']}").json()
    assert after["items"][0]["discount"] == 0, "el descuento rechazado quedó aplicado al ítem"
    assert after["discounts"] == [], "hay un descuento sin fila que lo justifique"
    assert after["totals"]["discount_total"] == 0
    assert after["totals"]["total"] == total_antes, "el cliente paga menos por un descuento que el sistema rechazó"


def test_rejected_discount_does_not_accumulate(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any, add_items: Any, main_product: Any) -> None:
    """Cuatro «no» seguidos dejaban el plato gratis."""
    set_feature("pos.discounts", True)
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    item_id = order["items"][0]["id"]
    total_antes = order["totals"]["total"]

    for _ in range(4):
        resp = device_client.post(
            f"/api/v1/orders/{order['id']}/discounts",
            json={"expected_version": order["version"], "scope": "item", "item_id": item_id, "kind": "percent", "value": 30, "reason": "promo"},
        )
        assert resp.status_code == 400

    after = device_client.get(f"/api/v1/orders/{order['id']}").json()
    assert after["totals"]["total"] == total_antes
    assert after["items"][0]["discount"] == 0


def test_authorized_discount_is_exactly_what_was_authorized(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any, new_order: Any, add_items: Any, main_product: Any) -> None:
    """El rechazo previo no se suma al descuento que sí se autorizó."""
    set_feature("pos.discounts", True)
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    item_id = order["items"][0]["id"]

    device_client.post(
        f"/api/v1/orders/{order['id']}/discounts",
        json={"expected_version": order["version"], "scope": "item", "item_id": item_id, "kind": "percent", "value": 50, "reason": "promo"},
    )
    ok = device_client.post(
        f"/api/v1/orders/{order['id']}/discounts",
        json={"expected_version": order["version"], "scope": "item", "item_id": item_id, "kind": "percent", "value": 50, "reason": "promo", "authorizer_pin": "9999"},
    )
    assert ok.status_code == 200, ok.text
    esperado = round(main_product.price_dine_in * 0.50)
    assert ok.json()["items"][0]["discount"] == esperado
    assert ok.json()["totals"]["discount_total"] == esperado
