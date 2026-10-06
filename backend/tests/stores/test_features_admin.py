"""`GET/PUT /admin/features` y `POST /admin/organization/profile`."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.core.features import FEATURE_BY_KEY, FEATURE_CATALOG, POS_PROFILE_BY_KEY, POS_PROFILES
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


# ---------------------------------------------------------------------------
# Perfiles de salón (mostrador / mesa / mixto): sólo escriben los `pos.*`.
# ---------------------------------------------------------------------------


def test_pos_profiles_cover_only_pos_flags_and_the_same_keys(admin_client: TestClient) -> None:
    resp = admin_client.get("/api/v1/admin/features/pos-profiles")
    assert resp.status_code == 200
    assert [p["key"] for p in resp.json()] == ["mostrador", "mesa", "mixto"]
    keys = set(POS_PROFILES[0].flags)
    for profile in POS_PROFILES:
        assert set(profile.flags) == keys, profile.key
        for key in profile.flags:
            assert key.startswith("pos.") and key in FEATURE_BY_KEY, key


def test_apply_pos_profile_sets_each_flag_and_backend_still_enforces_per_flag(
    admin_client: TestClient, device_client: TestClient
) -> None:
    # Con asiento por ítem encendido, «mostrador» apaga mesas: el asiento,
    # que depende de mesas, se apaga también y se informa.
    assert admin_client.put("/api/v1/admin/features/pos.seats", json={"enabled": True}).status_code == 200
    resp = admin_client.post("/api/v1/admin/features/pos-profile", json={"profile": "mostrador"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["profile"] == "mostrador"
    assert "pos.tables" in body["changed"]
    assert body["turned_off_dependents"] == ["pos.seats"]

    flags = {f["key"]: f["enabled"] for f in admin_client.get("/api/v1/admin/features").json()}
    for key, value in POS_PROFILE_BY_KEY["mostrador"].flags.items():
        assert flags[key] is value, key
    assert flags["pos.seats"] is False
    # Lo que el perfil no maneja no se toca.
    assert flags["pos.delivery"] is True

    # El backend sigue cortando por flag: sin `pos.tables` no hay mapa de mesas.
    tables = device_client.get("/api/v1/tables/status")
    assert tables.status_code == 400
    assert tables.json()["error"]["code"] == "FEATURE_DISABLED"

    # Y cada cambio quedó auditado como un interruptor más.
    audit = admin_client.get("/api/v1/admin/audit?entity=feature").json()
    assert any(r["entity_id"] == "pos.tables" and r["after"] == {"enabled": False} for r in audit)
    assert any(r["entity_id"] == "pos_profile" for r in audit)

    # Volver a «mixto» enciende mesas otra vez.
    resp = admin_client.post("/api/v1/admin/features/pos-profile", json={"profile": "mixto"})
    assert resp.status_code == 200
    flags = {f["key"]: f["enabled"] for f in admin_client.get("/api/v1/admin/features").json()}
    assert flags["pos.tables"] is True and flags["pos.counter"] is True


def test_apply_pos_profile_per_store_is_an_override(admin_client: TestClient, store: Store) -> None:
    resp = admin_client.post("/api/v1/admin/features/pos-profile", json={"profile": "mesa", "store_id": store.id})
    assert resp.status_code == 200
    store_rows = {f["key"]: f for f in admin_client.get(f"/api/v1/admin/features?store_id={store.id}").json()}
    assert store_rows["pos.counter"]["enabled"] is False
    assert store_rows["pos.counter"]["source"] == "store_override"
    org_rows = {f["key"]: f for f in admin_client.get("/api/v1/admin/features").json()}
    assert org_rows["pos.counter"]["enabled"] is True


def test_apply_pos_profile_rejects_unknown_profile(admin_client: TestClient) -> None:
    resp = admin_client.post("/api/v1/admin/features/pos-profile", json={"profile": "full"})
    assert resp.status_code in (400, 422)
