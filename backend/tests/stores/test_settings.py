"""Configuración de caja, de ventas y tabla UVT (SPEC-NEGOCIO §3.2, §8.1)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.stores.models import Store


def test_cash_settings_defaults_and_update(admin_client: TestClient, store: Store) -> None:
    resp = admin_client.get(f"/api/v1/admin/stores/{store.id}/cash-settings")
    assert resp.status_code == 200
    assert resp.json()["opening_cash_fixed"] == 200_000

    put_resp = admin_client.put(
        f"/api/v1/admin/stores/{store.id}/cash-settings",
        json={
            "opening_cash_fixed": 300_000,
            "cash_reserve_default": 0,
            "tolerance_unknown_cause": 20000,
            "tolerance_identified_cause": 100000,
            "critical_difference": 100000,
            "cash_pickup_threshold": 500000,
            "petty_cash_limit": 50000,
            "photo_required_on_close": True,
            "photo_required_on_pickup": True,
            "streak_alert_shifts": 3,
        },
    )
    assert put_resp.status_code == 200
    assert put_resp.json()["opening_cash_fixed"] == 300_000


def test_tip_suggested_pct_over_10_is_rejected(admin_client: TestClient, store: Store) -> None:
    sales = admin_client.get(f"/api/v1/admin/stores/{store.id}/sales-settings").json()
    sales["tip_suggested_pct"] = 15
    resp = admin_client.put(f"/api/v1/admin/stores/{store.id}/sales-settings", json=sales)
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "TIP_PCT_OVER_LIMIT"


def test_tip_suggested_pct_at_10_is_accepted(admin_client: TestClient, store: Store) -> None:
    sales = admin_client.get(f"/api/v1/admin/stores/{store.id}/sales-settings").json()
    sales["tip_suggested_pct"] = 10
    resp = admin_client.put(f"/api/v1/admin/stores/{store.id}/sales-settings", json=sales)
    assert resp.status_code == 200
    assert resp.json()["tip_suggested_pct"] == 10


def test_invoice_threshold_uvt_default_and_update(admin_client: TestClient, store: Store) -> None:
    """Pedido 1b-2 (mandato acotado de `backend-fiscal` en `app/stores`):
    `invoice_threshold_uvt` entero, default 5, expuesto en `GET`/`PUT
    /admin/stores/{store_id}/sales-settings`."""
    sales = admin_client.get(f"/api/v1/admin/stores/{store.id}/sales-settings").json()
    assert sales["invoice_threshold_uvt"] == 5

    sales["invoice_threshold_uvt"] = 3
    resp = admin_client.put(f"/api/v1/admin/stores/{store.id}/sales-settings", json=sales)
    assert resp.status_code == 200, resp.text
    assert resp.json()["invoice_threshold_uvt"] == 3

    again = admin_client.get(f"/api/v1/admin/stores/{store.id}/sales-settings").json()
    assert again["invoice_threshold_uvt"] == 3


def test_uvt_upsert(admin_client: TestClient) -> None:
    resp = admin_client.put("/api/v1/admin/uvt", json=[{"year": 2026, "value": 52374}])
    assert resp.status_code == 200
    values = {row["year"]: row["value"] for row in resp.json()}
    assert values[2026] == 52374

    resp2 = admin_client.put("/api/v1/admin/uvt", json=[{"year": 2026, "value": 53000}])
    assert resp2.status_code == 200
    values2 = {row["year"]: row["value"] for row in resp2.json()}
    assert values2[2026] == 53000
