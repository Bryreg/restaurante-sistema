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


def test_cash_settings_no_exponen_la_tolerancia_muerta(admin_client: TestClient, store: Store) -> None:
    """`tolerance_identified_cause` se fue (migración `0022`).

    Describía la misma frontera que `critical_difference` desde el otro lado y
    `app/shifts/service.py` nunca la leyó: el dueño la editaba creyendo que
    movía el umbral del arqueo y no movía nada. Las fronteras del arqueo son
    dos, y son las dos que el cierre lee.
    """
    resp = admin_client.get(f"/api/v1/admin/stores/{store.id}/cash-settings")
    assert resp.status_code == 200
    assert "tolerance_identified_cause" not in resp.json()
    assert {"tolerance_unknown_cause", "critical_difference"} <= set(resp.json())


def test_critical_difference_debajo_de_la_tolerancia_se_rechaza(
    admin_client: TestClient, store: Store
) -> None:
    """Las tres bandas del arqueo (§3.2) se apoyan en dos fronteras ordenadas.

    Guardar «sin causa $200.000» y «crítica $100.000» las invierte: la banda
    del medio desaparece y toda diferencia que pide causa identificada es
    además crítica. `ge=0` no lo ve, porque cada número por separado es
    válido. Regla de negocio: `400` con código, nunca `500`, y el mensaje
    nombra la acción correctiva (AGENTS.md).
    """
    url = f"/api/v1/admin/stores/{store.id}/cash-settings"
    current = admin_client.get(url).json()

    resp = admin_client.put(
        url, json={**current, "tolerance_unknown_cause": 200_000, "critical_difference": 100_000}
    )

    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "CRITICAL_BELOW_TOLERANCE"
    message = resp.json()["error"]["message"]
    assert "subí la diferencia crítica o bajá la tolerancia" in message

    # Y no guardó nada: la sede sigue con las fronteras que tenía.
    again = admin_client.get(url).json()
    assert again["tolerance_unknown_cause"] == current["tolerance_unknown_cause"]
    assert again["critical_difference"] == current["critical_difference"]


def test_las_dos_fronteras_iguales_tambien_se_rechazan(admin_client: TestClient, store: Store) -> None:
    """Iguales no invierte las bandas, pero borra la del medio: no existe
    ninguna diferencia que pida causa identificada sin ser además crítica.
    La frontera de la banda del medio tiene que ser estrictamente menor."""
    url = f"/api/v1/admin/stores/{store.id}/cash-settings"
    current = admin_client.get(url).json()

    resp = admin_client.put(
        url, json={**current, "tolerance_unknown_cause": 50_000, "critical_difference": 50_000}
    )

    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "CRITICAL_BELOW_TOLERANCE"


def test_el_orden_valido_se_guarda(admin_client: TestClient, store: Store) -> None:
    """El guardrail no puede estorbar el cambio legítimo de una frontera."""
    url = f"/api/v1/admin/stores/{store.id}/cash-settings"
    current = admin_client.get(url).json()

    resp = admin_client.put(
        url, json={**current, "tolerance_unknown_cause": 30_000, "critical_difference": 150_000}
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["tolerance_unknown_cause"] == 30_000
    assert resp.json()["critical_difference"] == 150_000


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
