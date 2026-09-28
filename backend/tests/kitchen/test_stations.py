"""`GET /kitchen/stations` (`kitchen.kds`): las estaciones configuradas de la
sede, para la barra del KDS. Lectura de dispositivo: no exige persona
identificada, y sólo trae nombres."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient


def test_lists_the_configured_stations_without_an_identified_person(device_client: TestClient) -> None:
    resp = device_client.get("/api/v1/kitchen/stations")
    assert resp.status_code == 200, resp.text
    assert resp.json() == ["hot_kitchen", "cold_kitchen", "bar", "desserts", "none"]


def test_is_behind_the_kds_feature(device_client: TestClient, set_feature: Any, store: Any) -> None:
    set_feature("kitchen.kds", False)
    set_feature("kitchen.kds", False, store.id)
    resp = device_client.get("/api/v1/kitchen/stations")
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"


def test_requires_an_activated_device(client: TestClient) -> None:
    assert client.get("/api/v1/kitchen/stations").status_code == 401
