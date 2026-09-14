"""Configuración fiscal versionada por `valid_from` (SPEC-NEGOCIO §8.1)."""

from __future__ import annotations

from datetime import date

from fastapi.testclient import TestClient

from app.stores.models import Store


def test_fiscal_vigente_es_la_de_mayor_valid_from_pasada(admin_client: TestClient, store: Store) -> None:
    resp = admin_client.get(f"/api/v1/admin/stores/{store.id}/fiscal")
    assert resp.status_code == 200
    assert resp.json()["regime"] == "ordinary"

    future = date(2030, 1, 1)
    put_resp = admin_client.put(
        f"/api/v1/admin/stores/{store.id}/fiscal",
        json={
            "valid_from": future.isoformat(),
            "person_type": "legal",
            "regime": "simple",
            "franchise": True,
            "inc_responsible": False,
            "iva_responsible": True,
            "rut_codes": [],
            "price_includes_tax": True,
            "default_tax": "iva_19",
        },
    )
    assert put_resp.status_code == 200

    # La vigente hoy sigue siendo la vieja: la nueva es futura.
    still_current = admin_client.get(f"/api/v1/admin/stores/{store.id}/fiscal")
    assert still_current.json()["regime"] == "ordinary"

    history = admin_client.get(f"/api/v1/admin/stores/{store.id}/fiscal/history")
    assert len(history.json()) == 2


def test_fiscal_requires_valid_from(admin_client: TestClient, store: Store) -> None:
    resp = admin_client.put(
        f"/api/v1/admin/stores/{store.id}/fiscal",
        json={
            "person_type": "natural",
            "regime": "ordinary",
            "default_tax": "inc_8",
        },
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "FISCAL_VALID_FROM_REQUIRED"
