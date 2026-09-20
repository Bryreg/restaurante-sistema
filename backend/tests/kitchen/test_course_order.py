"""Checklist: «Marchar sella `fired_at` por curso y el KDS lo respeta en el
orden (test)». `pos.courses`/`fire_course` son de `app.orders` (territorio
ajeno, ya construidos); acá sólo se prueba que `kitchen.kds` LEE
`fired_at_by_course` (CONTRATO C1) y reordena la cola con eso — sin duplicar
el modelo de cursos marchados."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.orders.conftest import idem_headers


def test_the_kds_respects_fired_at_order_between_two_courses(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    new_order: Any, add_items: Any, main_product: Any, starter_product: Any, send_order: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    # `starter_product` primero, `main_product` segundo: sin marchar nada,
    # el orden de la cola sigue el de envío (ambos "sin marchar" empatan).
    order = add_items(
        order, [{"product_id": starter_product.id, "qty": 1}, {"product_id": main_product.id, "qty": 1}]
    ).json()
    order = send_order(order).json()
    order_id = order["id"]

    by_name = {i["name"]: i["id"] for i in order["items"]}
    starter_item_id = by_name["Ceviche"]
    main_item_id = by_name["Bandeja Paisa"]

    rounds_before = device_client.get("/api/v1/kitchen/rounds").json()
    assert len(rounds_before) == 1
    order_before = [i["item_id"] for i in rounds_before[0]["items"]]
    assert order_before == [starter_item_id, main_item_id]
    assert all(i["course_fired_at"] is None for i in rounds_before[0]["items"])

    # Se marcha el curso "main" — el que en el envío venía SEGUNDO.
    fire = device_client.post(
        f"/api/v1/orders/{order_id}/courses/main/fire",
        json={"expected_version": order["version"]},
        headers=idem_headers(),
    )
    assert fire.status_code == 200, fire.text

    rounds_after = device_client.get("/api/v1/kitchen/rounds").json()
    items_after = rounds_after[0]["items"]
    order_after = [i["item_id"] for i in items_after]
    # "main" (marchado) salta ADELANTE de "starter" (sin marchar): un curso
    # no marchado nunca se adelanta a uno marchado.
    assert order_after == [main_item_id, starter_item_id]

    by_item = {i["item_id"]: i for i in items_after}
    assert by_item[main_item_id]["course_fired_at"] is not None
    assert by_item[starter_item_id]["course_fired_at"] is None


def test_without_kitchen_kds_the_order_is_send_order_regardless_of_firing(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, set_feature: Any,
    new_order: Any, add_items: Any, main_product: Any, starter_product: Any, send_order: Any,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(
        order, [{"product_id": starter_product.id, "qty": 1}, {"product_id": main_product.id, "qty": 1}]
    ).json()
    order = send_order(order).json()
    order_id = order["id"]
    by_name = {i["name"]: i["id"] for i in order["items"]}

    device_client.post(
        f"/api/v1/orders/{order_id}/courses/main/fire",
        json={"expected_version": order["version"]},
        headers=idem_headers(),
    )

    set_feature("kitchen.kds", False)
    rounds = device_client.get("/api/v1/kitchen/rounds").json()
    order_ids = [i["item_id"] for i in rounds[0]["items"]]
    # Sin `kitchen.kds`, "marchar" no reordena nada: sigue el orden de envío
    # de siempre (1b).
    assert order_ids == [by_name["Ceviche"], by_name["Bandeja Paisa"]]
    assert "course_fired_at" not in rounds[0]["items"][0]
