"""La forma del error es siempre `{"error": {"code", "message"}}`."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.stores.models import Store


def test_not_found_shape(admin_client: TestClient, store: Store) -> None:
    resp = admin_client.get(f"/api/v1/admin/stores/{store.id + 999}/fiscal")
    assert resp.status_code == 404
    body = resp.json()
    assert set(body.keys()) == {"error"}
    assert "code" in body["error"] and "message" in body["error"]
    assert body["error"]["code"] == "NOT_FOUND"


def test_unauthenticated_shape(client: TestClient) -> None:
    resp = client.get("/api/v1/admin/organization")
    assert resp.status_code == 401
    body = resp.json()
    assert body["error"]["code"] == "NOT_AUTHENTICATED"
    assert "Iniciá sesión" in body["error"]["message"]


def test_device_not_activated_shape(client: TestClient) -> None:
    resp = client.get("/api/v1/auth/me")
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "DEVICE_NOT_ACTIVATED"


def test_validation_error_shape(admin_client: TestClient) -> None:
    resp = admin_client.post("/api/v1/admin/employees", json={"name": "Sin rol"})
    assert resp.status_code == 400
    body = resp.json()
    assert body["error"]["code"] == "VALIDATION_ERROR"
    assert ":" in body["error"]["message"]


def test_business_error_never_500(admin_client: TestClient, store: Store) -> None:
    resp = admin_client.put(
        f"/api/v1/admin/stores/{store.id}/sales-settings",
        json={
            "tip_suggested_pct": 25,
            "discount_limit_pct": 10,
            "discount_daily_limit_pct": 5,
            "courtesy_shift_limit": 5,
            "payment_methods": [],
            "void_reasons": [],
            "discount_reasons": [],
            "courtesy_reasons": [],
            "courses": [],
            "stations": [],
            "course_target_minutes": {},
        },
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "TIP_PCT_OVER_LIMIT"
