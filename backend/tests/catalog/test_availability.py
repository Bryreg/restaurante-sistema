"""Agotados y contador de porciones: `POST /products/{id}/availability`,
`reset_daily_availability`, notificación `product_unavailable` con dedupe
diario, y el flag `pos.daily_count`."""

from __future__ import annotations

from typing import Any, Callable

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.catalog import service as catalog_service
from app.catalog.models import ComboOption, Product
from app.stores.models import Store


def test_availability_with_daily_count_sets_remaining(
    admin_client: TestClient, create_product: Callable[..., dict[str, Any]]
) -> None:
    product = create_product(name="Sancocho (20 porciones)", dine_in=22_000)
    resp = admin_client.post(
        f"/api/v1/products/{product['id']}/availability", json={"available": True, "daily_count": 20}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["daily_count"] == 20
    assert body["daily_remaining"] == 20


def test_availability_daily_count_requires_feature(
    admin_client: TestClient, create_product: Callable[..., dict[str, Any]], set_feature: Callable[..., None]
) -> None:
    product = create_product(name="Sancocho", dine_in=22_000)
    set_feature("pos.daily_count", False)
    resp = admin_client.post(
        f"/api/v1/products/{product['id']}/availability", json={"available": True, "daily_count": 10}
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
    assert resp.json()["error"]["feature"] == "pos.daily_count"


def test_marking_product_unavailable_notifies_with_daily_dedupe(
    admin_client: TestClient, store: Store, create_product: Callable[..., dict[str, Any]]
) -> None:
    product = create_product(name="Pescado frito", dine_in=34_000)

    resp = admin_client.post(f"/api/v1/products/{product['id']}/availability", json={"available": False})
    assert resp.status_code == 200
    assert resp.json()["available"] is False

    resp = admin_client.get(f"/api/v1/admin/notifications?store_id={store.id}")
    matches = [n for n in resp.json() if n["type"] == "product_unavailable" and n["payload"]["product_id"] == product["id"]]
    assert len(matches) == 1

    # Repetir el mismo día no duplica la notificación (dedupe diario).
    resp = admin_client.post(f"/api/v1/products/{product['id']}/availability", json={"available": False})
    assert resp.status_code == 200
    resp = admin_client.get(f"/api/v1/admin/notifications?store_id={store.id}")
    matches = [n for n in resp.json() if n["type"] == "product_unavailable" and n["payload"]["product_id"] == product["id"]]
    assert len(matches) == 1


def test_marking_product_available_again_clears_unavailable_marker(
    admin_client: TestClient, create_product: Callable[..., dict[str, Any]]
) -> None:
    product = create_product(name="Pescado frito", dine_in=34_000)
    admin_client.post(f"/api/v1/products/{product['id']}/availability", json={"available": False})
    resp = admin_client.post(f"/api/v1/products/{product['id']}/availability", json={"available": True})
    assert resp.status_code == 200
    assert resp.json()["available"] is True


def test_reset_daily_availability_clears_products_modifiers_and_combo_options(
    db: Session,
    store: Store,
    create_product: Callable[..., dict[str, Any]],
    create_combo: Callable[..., dict[str, Any]],
) -> None:
    product = create_product(name="Sancocho (10 porciones)", dine_in=22_000, daily_count=10)
    other_product = create_product(name="Jugo", dine_in=8_000)
    combo = create_combo(groups=[{"name": "Bebida", "options": [{"product_id": other_product["id"]}]}])
    combo_option_id = combo["groups"][0]["options"][0]["id"]

    product_row = db.get(Product, product["id"])
    product_row.available = False
    product_row.daily_remaining = 3

    combo_option_row = db.get(ComboOption, combo_option_id)
    combo_option_row.available_today = False
    combo_option_row.active_today = False
    db.flush()

    catalog_service.reset_daily_availability(db, store_id=store.id)

    db.refresh(product_row)
    db.refresh(combo_option_row)
    assert product_row.available is True
    assert product_row.daily_remaining == 10
    assert combo_option_row.available_today is True
    assert combo_option_row.active_today is True


def test_set_combo_option_availability_actor_scope(
    admin_client: TestClient,
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Any],
    create_combo: Callable[..., dict[str, Any]],
    create_product: Callable[..., dict[str, Any]],
) -> None:
    product = create_product(name="Sancocho", dine_in=22_000)
    combo = create_combo(groups=[{"name": "Sopa", "options": [{"product_id": product["id"]}]}])
    option_id = combo["groups"][0]["options"][0]["id"]

    # Sin identificarse en el dispositivo, marcar agotado requiere persona.
    resp = device_client.post(f"/api/v1/combo-options/{option_id}/availability", json={"available": False})
    assert resp.status_code == 401

    identify(device_client, employees["operator"])
    resp = device_client.post(f"/api/v1/combo-options/{option_id}/availability", json={"available": False})
    assert resp.status_code == 200, resp.text
    assert resp.json()["available_today"] is False
