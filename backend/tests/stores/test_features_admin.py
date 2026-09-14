"""`GET/PUT /admin/features` y `POST /admin/organization/profile`."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.core.features import FEATURE_CATALOG
from app.stores.models import Store


def test_list_features_shape(admin_client: TestClient) -> None:
    resp = admin_client.get("/api/v1/admin/features")
    assert resp.status_code == 200
    rows = resp.json()
    keys = {r["key"] for r in rows}
    assert keys == {f.key for f in FEATURE_CATALOG}
    for r in rows:
        assert r["source"] in ("org", "store_override", "profile_default")


def test_put_feature_dependency_missing(admin_client: TestClient) -> None:
    # Apaga primero lo que depende de pos.combos.
    off = admin_client.put("/api/v1/admin/features/pos.daily_menu", json={"enabled": False})
    assert off.status_code == 200

    off_combos = admin_client.put("/api/v1/admin/features/pos.combos", json={"enabled": False})
    assert off_combos.status_code == 200

    resp = admin_client.put("/api/v1/admin/features/pos.daily_menu", json={"enabled": True})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "FEATURE_DEPENDENCY"
    assert resp.json()["error"]["requires"] == "pos.combos"


def test_put_feature_unknown_key_is_404(admin_client: TestClient) -> None:
    resp = admin_client.put("/api/v1/admin/features/not.a.feature", json={"enabled": True})
    assert resp.status_code == 404


def test_put_feature_core_capability_is_feature_is_core(admin_client: TestClient) -> None:
    resp = admin_client.put("/api/v1/admin/features/audit", json={"enabled": False})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "FEATURE_IS_CORE"


def test_feature_override_is_audited(admin_client: TestClient) -> None:
    # pos.tips no tiene dependientes: sirve para probar la auditoría sin
    # chocar con el chequeo de dependencias (eso lo prueba otro test).
    put_resp = admin_client.put("/api/v1/admin/features/pos.tips", json={"enabled": False})
    assert put_resp.status_code == 200
    resp = admin_client.get("/api/v1/admin/audit?entity=feature")
    rows = resp.json()
    assert any(r["entity_id"] == "pos.tips" for r in rows)
    matching = next(r for r in rows if r["entity_id"] == "pos.tips")
    assert matching["after"] == {"enabled": False}


def test_profile_reset_leaves_exact_spec_defaults(admin_client: TestClient) -> None:
    admin_client.put("/api/v1/admin/features/pos.tips", json={"enabled": False})
    resp = admin_client.post("/api/v1/admin/organization/profile", json={"profile": "basic"})
    assert resp.status_code == 200
    assert resp.json()["profile"] == "basic"

    features_resp = admin_client.get("/api/v1/admin/features")
    flags = {f["key"]: f["enabled"] for f in features_resp.json()}
    for f in FEATURE_CATALOG:
        assert flags[f.key] == f.defaults["basic"], f.key


def test_feature_override_reflected_in_device_me(
    device_client: TestClient, admin_client: TestClient, store: Store
) -> None:
    before = device_client.get("/api/v1/auth/me").json()
    assert before["features"]["pos.tips"] is True  # perfil full de la fixture

    off = admin_client.put(
        "/api/v1/admin/features/pos.tips", json={"enabled": False, "store_id": store.id}
    )
    assert off.status_code == 200

    after = device_client.get("/api/v1/auth/me").json()
    assert after["features"]["pos.tips"] is False
