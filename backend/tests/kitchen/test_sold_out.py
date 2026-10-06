"""Lista 86 (auditoría p5): «Agotado» de un toque desde el KDS y el POS.

El KDS publica el `product_id` de cada plato para poder marcarlo agotado con
la misma ruta que usa Carta (`POST /products/{id}/availability`); la tablet
manda `Idempotency-Key` y un reintento no repite la auditoría. Lo agotado
sale en Hoy (`unavailable_products`)."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit.models import AuditLog


def test_kds_item_carries_product_id_and_marks_it_sold_out_once(
    device_client: TestClient,
    identify: Any,
    employees: Any,
    open_shift: Any,
    new_order: Any,
    add_items: Any,
    main_product: Any,
    send_order: Any,
    db: Session,
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()
    send_order(order)

    item = device_client.get("/api/v1/kitchen/rounds").json()[0]["items"][0]
    assert item["product_id"] == main_product.id

    headers = {"Idempotency-Key": "kds-86-1"}
    first = device_client.post(
        f"/api/v1/products/{item['product_id']}/availability", json={"available": False}, headers=headers
    )
    assert first.status_code == 200, first.text
    assert first.json()["available"] is False
    replay = device_client.post(
        f"/api/v1/products/{item['product_id']}/availability", json={"available": False}, headers=headers
    )
    assert replay.status_code == 200
    assert replay.json() == first.json()
    audits = (
        db.execute(
            select(AuditLog).where(
                AuditLog.entity == "product",
                AuditLog.entity_id == main_product.id,
                AuditLog.action == "set_availability",
            )
        )
        .scalars()
        .all()
    )
    assert len(audits) == 1

    catalog = device_client.get("/api/v1/catalog").json()
    by_id = {p["id"]: p for p in catalog["products"]}
    assert by_id[main_product.id]["available"] is False


def test_availability_from_the_device_does_not_leak_costs(
    device_client: TestClient, identify: Any, employees: Any, main_product: Any
) -> None:
    identify(device_client, employees["operator"])
    resp = device_client.post(
        f"/api/v1/products/{main_product.id}/availability",
        json={"available": False},
        headers={"Idempotency-Key": "kds-86-2"},
    )
    assert resp.status_code == 200, resp.text
    assert not [k for k in resp.json() if "cost" in k or "margin" in k]


def test_sold_out_product_shows_on_today(
    device_client: TestClient, admin_client: TestClient, identify: Any, employees: Any, main_product: Any, store: Any
) -> None:
    identify(device_client, employees["operator"])
    resp = device_client.post(
        f"/api/v1/products/{main_product.id}/availability",
        json={"available": False},
        headers={"Idempotency-Key": "kds-86-3"},
    )
    assert resp.status_code == 200, resp.text
    today = admin_client.get("/api/v1/admin/today", params={"store_id": store.id})
    assert today.status_code == 200, today.text
    names = [p["name"] for p in today.json()["unavailable_products"]]
    assert main_product.name in names
