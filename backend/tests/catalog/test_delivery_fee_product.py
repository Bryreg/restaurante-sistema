"""`Product.is_delivery_fee` (pedido 2c, §4.3): el cargo de domicilio como
producto real de la carta. `app.orders.service.create_order` lo consume vía
`app.catalog.service.get_delivery_fee_product`; acá se prueba sólo el lado
de catálogo — a lo sumo uno activo por sede, y que `GET /catalog` (el menú
del dispositivo) lo excluye."""

from __future__ import annotations

from typing import Any, Callable

from fastapi.testclient import TestClient

from app.catalog import service as catalog_service
from app.stores.models import Store
from sqlalchemy.orm import Session


def test_product_admin_out_exposes_is_delivery_fee(create_product: Callable[..., dict[str, Any]]) -> None:
    normal = create_product(name="Gaseosa")
    assert normal["is_delivery_fee"] is False

    fee = create_product(name="Cargo de domicilio", is_delivery_fee=True)
    assert fee["is_delivery_fee"] is True


def test_at_most_one_active_delivery_fee_product_per_store(
    create_product: Callable[..., dict[str, Any]],
) -> None:
    create_product(name="Cargo de domicilio", is_delivery_fee=True)
    second = create_product(name="Otro cargo", is_delivery_fee=True, expect_status=409)
    assert second["error"]["code"] == "DELIVERY_FEE_ALREADY_CONFIGURED"


def test_deactivating_the_fee_product_frees_the_slot_for_a_new_one(
    admin_client: TestClient, store: Store, create_product: Callable[..., dict[str, Any]]
) -> None:
    first = create_product(name="Cargo de domicilio", is_delivery_fee=True)
    patch_resp = admin_client.patch(f"/api/v1/admin/products/{first['id']}", json={"active": False})
    assert patch_resp.status_code == 200, patch_resp.text

    second = create_product(name="Cargo de domicilio v2", is_delivery_fee=True)
    assert second["is_delivery_fee"] is True


def test_get_delivery_fee_product_returns_none_when_not_configured(db: Session, store: Store) -> None:
    assert catalog_service.get_delivery_fee_product(db, store.id) is None


def test_get_delivery_fee_product_returns_the_active_one(
    db: Session, store: Store, create_product: Callable[..., dict[str, Any]]
) -> None:
    created = create_product(name="Cargo de domicilio", is_delivery_fee=True, dine_in=6_000)
    found = catalog_service.get_delivery_fee_product(db, store.id)
    assert found is not None
    assert found.id == created["id"]
    assert found.price_dine_in == 6_000


def test_catalog_endpoint_excludes_the_delivery_fee_product(
    device_client: TestClient, create_product: Callable[..., dict[str, Any]]
) -> None:
    create_product(name="Gaseosa")
    create_product(name="Cargo de domicilio", is_delivery_fee=True)

    resp = device_client.get("/api/v1/catalog")
    assert resp.status_code == 200, resp.text
    names = {p["name"] for p in resp.json()["products"]}
    assert "Gaseosa" in names
    assert "Cargo de domicilio" not in names
