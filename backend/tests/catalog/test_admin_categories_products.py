"""CRUD de categorías y productos: valores por defecto (tasa, estación,
curso heredados de la categoría), aislamiento por organización y auditoría
con antes y después al editar un precio."""

from __future__ import annotations

from typing import Any, Callable

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.catalog.models import Category, Product
from app.core import clock
from app.stores.models import Store


def test_create_category_and_product_defaults_tax_from_store_fiscal(
    admin_client: TestClient, store: Store
) -> None:
    resp = admin_client.post(
        f"/api/v1/admin/categories?store_id={store.id}",
        json={"name": "Bebidas", "sort_order": 2, "default_course": "beverage", "default_station": "bar"},
    )
    assert resp.status_code == 200, resp.text
    category = resp.json()
    assert category["active"] is True

    resp = admin_client.post(
        f"/api/v1/admin/products?store_id={store.id}",
        json={
            "category_id": category["id"],
            "name": "Limonada",
            "prices": {"dine_in": 9000},
        },
    )
    assert resp.status_code == 200, resp.text
    product = resp.json()
    # La sede de prueba tiene fiscal vigente con default_tax="inc_8" (tests/conftest.py).
    assert product["tax_code"] == "inc_8"
    # Estación y curso caen de la categoría cuando el producto no los pisa.
    assert product["station"] == "bar"
    assert product["default_course"] == "beverage"
    assert product["available"] is True
    assert product["daily_count"] is None


def test_product_can_override_tax_code(
    admin_client: TestClient, store: Store, category_id: int
) -> None:
    resp = admin_client.post(
        f"/api/v1/admin/products?store_id={store.id}",
        json={
            "category_id": category_id,
            "name": "Aguardiente",
            "prices": {"dine_in": 15000},
            "tax_code": "iva_19",
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["tax_code"] == "iva_19"


def test_update_product_price_is_audited_with_before_and_after(
    admin_client: TestClient, store: Store, create_product: Callable[..., dict[str, Any]]
) -> None:
    product = create_product(name="Bandeja paisa", dine_in=38_000)

    resp = admin_client.patch(
        f"/api/v1/admin/products/{product['id']}",
        json={"prices": {"dine_in": 40_000}},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["prices"]["dine_in"] == 40_000

    resp = admin_client.get(f"/api/v1/admin/audit?entity=product")
    rows = resp.json()
    row = next(r for r in rows if r["entity_id"] == str(product["id"]) and r["action"] == "update")
    assert row["before"]["prices"]["dine_in"] == 38_000
    assert row["after"]["prices"]["dine_in"] == 40_000


def test_admin_cannot_read_or_edit_product_of_other_organization(
    admin_client: TestClient, store_b: Store, create_product: Callable[..., dict[str, Any]]
) -> None:
    # `store_b` es de otra organización: ni siquiera se puede pedir la lista
    # de sus productos (404 antes de tocar la tabla, vía `admin_store`).
    resp = admin_client.get(f"/api/v1/admin/products?store_id={store_b.id}")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "NOT_FOUND"


def test_admin_cannot_edit_product_by_forging_the_id_of_another_organization(
    admin_client: TestClient, create_product: Callable[..., dict[str, Any]]
) -> None:
    product = create_product(name="Producto de la org A", dine_in=10_000)
    # Un id que no existe en absoluto también es 404 (misma forma de error
    # que un id de otra organización: no delata cuál caso es).
    resp = admin_client.patch(f"/api/v1/admin/products/{product['id'] + 999_999}", json={"name": "x"})
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "NOT_FOUND"


def test_admin_gets_404_on_a_real_product_id_belonging_to_another_organization(
    db: Session, admin_client: TestClient, store_b: Store
) -> None:
    """El caso central del checklist: un id que sí existe, pero es de la
    organización B, tiene que responder `404` para un admin de la A — nunca
    `403` (no delata que existe) ni, mucho peor, los datos."""
    now = clock.now_utc()
    category_b = Category(
        organization_id=store_b.organization_id, store_id=store_b.id, name="Categoría B", sort_order=0, active=True
    )
    db.add(category_b)
    db.flush()
    product_b = Product(
        organization_id=store_b.organization_id,
        store_id=store_b.id,
        category_id=category_b.id,
        name="Producto de la org B",
        description=None,
        station=None,
        default_course=None,
        price_dine_in=10_000,
        price_takeout=None,
        price_delivery=None,
        price_platform=None,
        tax_code="inc_8",
        active=True,
        available=True,
        daily_count=None,
        daily_remaining=None,
        unavailable_by_employee_id=None,
        unavailable_by_employee_name=None,
        unavailable_at=None,
        created_at=now,
        updated_at=now,
    )
    db.add(product_b)
    db.flush()

    resp = admin_client.patch(f"/api/v1/admin/products/{product_b.id}", json={"name": "hackeado"})
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "NOT_FOUND"


def test_category_isolation_across_organizations(admin_client: TestClient, store_b: Store) -> None:
    resp = admin_client.get(f"/api/v1/admin/categories?store_id={store_b.id}")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "NOT_FOUND"


def test_update_category_toggles_active_logical_delete(admin_client: TestClient, store: Store) -> None:
    resp = admin_client.post(
        f"/api/v1/admin/categories?store_id={store.id}",
        json={"name": "Temporal", "sort_order": 9},
    )
    category_id = resp.json()["id"]

    resp = admin_client.patch(f"/api/v1/admin/categories/{category_id}", json={"active": False})
    assert resp.status_code == 200
    assert resp.json()["active"] is False
