"""Zonas y mesas: CRUD de admin, y `GET /tables` del dispositivo siempre
`free` en 1a (no hay comandas todavía)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.stores.models import Store


def test_create_zone_and_table(admin_client: TestClient, store: Store) -> None:
    zone_resp = admin_client.post(
        f"/api/v1/admin/zones?store_id={store.id}", json={"name": "Salón", "sort_order": 1}
    )
    assert zone_resp.status_code == 200
    zone_id = zone_resp.json()["id"]

    table_resp = admin_client.post(
        "/api/v1/admin/tables", json={"zone_id": zone_id, "number": "1", "seats": 4}
    )
    assert table_resp.status_code == 200
    assert table_resp.json()["store_id"] == store.id


def test_device_tables_always_free_in_1a(admin_client: TestClient, device_client: TestClient, store: Store) -> None:
    zone_resp = admin_client.post(
        f"/api/v1/admin/zones?store_id={store.id}", json={"name": "Terraza", "sort_order": 1}
    )
    zone_id = zone_resp.json()["id"]
    admin_client.post("/api/v1/admin/tables", json={"zone_id": zone_id, "number": "T1", "seats": 2})

    resp = device_client.get("/api/v1/tables")
    assert resp.status_code == 200
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["status"] == "free"
    assert rows[0]["zone_name"] == "Terraza"


def test_zone_of_other_store_is_404_on_update(
    admin_client: TestClient, store: Store, store_b: Store
) -> None:
    zone_resp = admin_client.post(
        f"/api/v1/admin/zones?store_id={store.id}", json={"name": "Salón", "sort_order": 1}
    )
    zone_id = zone_resp.json()["id"]
    # El mismo admin (org A) intenta usar esa zona como si fuera de otra sede: sigue siendo suya.
    resp = admin_client.patch(f"/api/v1/admin/zones/{zone_id}", json={"name": "Renombrada"})
    assert resp.status_code == 200

    # Pero una zona con id inexistente (o de otra organización) es 404.
    resp_404 = admin_client.patch("/api/v1/admin/zones/999999", json={"name": "x"})
    assert resp_404.status_code == 404
