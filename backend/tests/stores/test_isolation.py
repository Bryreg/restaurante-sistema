"""Toda consulta se acota por organización: un id ajeno es 404, siempre
(SPEC-NEGOCIO §2.2, checklist del pedido 1a)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.stores.models import Store


def test_admin_cannot_read_fiscal_of_other_org_store(admin_client: TestClient, store_b: Store) -> None:
    resp = admin_client.get(f"/api/v1/admin/stores/{store_b.id}/fiscal")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "NOT_FOUND"


def test_admin_cannot_patch_store_of_other_org(admin_client: TestClient, store_b: Store) -> None:
    resp = admin_client.patch(f"/api/v1/admin/stores/{store_b.id}", json={"name": "hackeada"})
    assert resp.status_code == 404


def test_admin_cannot_rotate_pin_of_other_org_store(admin_client: TestClient, store_b: Store) -> None:
    resp = admin_client.post(
        f"/api/v1/admin/stores/{store_b.id}/rotate-pin", json={"new_pin": "0000"}
    )
    assert resp.status_code == 404


def test_stores_list_never_includes_other_org(
    admin_client: TestClient, store: Store, store_b: Store
) -> None:
    resp = admin_client.get("/api/v1/admin/stores")
    ids = {row["id"] for row in resp.json()}
    assert store.id in ids
    assert store_b.id not in ids


def test_features_of_other_org_store_is_404(admin_client: TestClient, store_b: Store) -> None:
    resp = admin_client.get(f"/api/v1/admin/features?store_id={store_b.id}")
    assert resp.status_code == 404
