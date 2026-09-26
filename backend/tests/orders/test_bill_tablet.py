"""Precuenta y partes iguales para el cobro en tablet.

- Las líneas idénticas de la precuenta se agrupan en el servidor («2×
  Limonada» y no dos «1× Limonada»), con cantidades y montos sumados acá.
- Partes iguales reparte venta + propina juntas (`per_part_due`): la pantalla
  ya no queda en «faltan $X» después de preguntar la propina.
- La propina se pregunta en mesa y, en mostrador, sólo con `pos.tips_counter`.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.orders.conftest import idem_headers


def _present(device_client: TestClient, order: dict[str, Any]) -> Any:
    current = device_client.get(f"/api/v1/orders/{order['id']}").json()
    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/bill/present",
        json={"expected_version": current["version"]},
        headers=idem_headers(),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_pre_bill_groups_identical_lines_and_keeps_different_ones_apart(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any,
    new_order: Any, add_items: Any, drink_product: Any, main_product: Any,
) -> None:
    set_feature("pos.pre_bill", True)
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": drink_product.id, "qty": 1}]).json()
    order = add_items(order, [{"product_id": drink_product.id, "qty": 1}]).json()
    # Misma bebida con nota: NO es la misma línea.
    order = add_items(order, [{"product_id": drink_product.id, "qty": 1, "note": "sin hielo"}]).json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()

    body = _present(device_client, order)
    lines = body["lines"]
    assert len(lines) == 3, lines
    agrupada = lines[0]
    assert agrupada["qty"] == 2
    assert agrupada["unit_price"] == drink_product.price_dine_in
    assert agrupada["gross"] == 2 * drink_product.price_dine_in
    assert agrupada["net"] == 2 * drink_product.price_dine_in
    assert lines[1]["qty"] == 1  # la de «sin hielo», aparte
    # Agrupar no inventa ni pierde plata: Σ líneas == total.
    assert sum(line["net"] for line in lines) == body["total"]


def test_equal_split_spreads_sale_and_tip_together(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any,
    new_order: Any, add_items: Any, main_product: Any, tables: Any,
) -> None:
    set_feature("pos.split_bill", True)
    set_feature("pos.tips", True)
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order(channel="dine_in", table_ids=[tables[0].id]).json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()

    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/bill/split",
        json={"expected_version": order["version"], "mode": "equal", "parts": 3, "tip_amount": 2_222},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["tip_amount"] == 2_222
    assert body["amount_due"] == body["total"] + 2_222
    assert sum(body["per_part_due"]) == body["amount_due"]
    assert len(body["per_part_due"]) == 3
    # La venta sola se sigue repartiendo igual que antes.
    assert sum(body["per_part"]) == body["total"]


def test_equal_split_without_tip_keeps_the_old_shape(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any,
    new_order: Any, add_items: Any, main_product: Any,
) -> None:
    set_feature("pos.split_bill", True)
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/bill/split",
        json={"expected_version": order["version"], "mode": "equal", "parts": 2},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["tip_amount"] == 0
    assert body["per_part_due"] == body["per_part"]
    assert body["amount_due"] == body["total"]


def test_equal_split_rejects_a_tip_the_order_does_not_take(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any,
    new_order: Any, add_items: Any, main_product: Any,
) -> None:
    set_feature("pos.split_bill", True)
    set_feature("pos.tips", False)
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    resp = device_client.post(
        f"/api/v1/orders/{order['id']}/bill/split",
        json={"expected_version": order["version"], "mode": "equal", "parts": 2, "tip_amount": 1_000},
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "TIP_NOT_APPLICABLE"


def test_counter_asks_tip_only_with_tips_counter(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any,
    new_order: Any, add_items: Any, main_product: Any, tables: Any,
) -> None:
    set_feature("pos.pre_bill", True)
    set_feature("pos.tips", True)
    set_feature("pos.tips_counter", False)
    open_shift()
    identify(device_client, employees["operator"])

    mostrador = new_order().json()
    mostrador = add_items(mostrador, [{"product_id": main_product.id, "qty": 1}]).json()
    assert _present(device_client, mostrador)["tip"] is None

    mesa = new_order(channel="dine_in", table_ids=[tables[0].id]).json()
    mesa = add_items(mesa, [{"product_id": main_product.id, "qty": 1}]).json()
    assert _present(device_client, mesa)["tip"] is not None

    set_feature("pos.tips_counter", True)
    otra = new_order().json()
    otra = add_items(otra, [{"product_id": main_product.id, "qty": 1}]).json()
    assert _present(device_client, otra)["tip"] is not None
