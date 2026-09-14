"""Matriz de autorización: supervisor sí en su lista, nunca en retiros ni
rescates (SPEC-NEGOCIO §2.2 y CONTRATO-INTERNO §2)."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.auth.models import Employee


def test_supervisor_can_authorize_discount_over_limit(
    device_client: TestClient, employees: dict[str, Employee]
) -> None:
    device_client.post(
        "/api/v1/auth/device/identify",
        json={"employee_id": employees["operator"].id, "pin": "2222"},
    )
    resp = device_client.post(
        "/api/v1/auth/authorize", json={"pin": "5555", "action": "discount_over_limit"}
    )
    assert resp.status_code == 200
    assert resp.json()["authorizer"]["role"] == "supervisor"


def test_supervisor_cannot_authorize_pickup(
    device_client: TestClient, employees: dict[str, Employee]
) -> None:
    device_client.post(
        "/api/v1/auth/device/identify",
        json={"employee_id": employees["operator"].id, "pin": "2222"},
    )
    resp = device_client.post("/api/v1/auth/authorize", json={"pin": "5555", "action": "pickup"})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "AUTHORIZATION_NOT_ALLOWED"


def test_admin_can_authorize_anything(
    device_client: TestClient, employees: dict[str, Employee]
) -> None:
    device_client.post(
        "/api/v1/auth/device/identify",
        json={"employee_id": employees["operator"].id, "pin": "2222"},
    )
    resp = device_client.post("/api/v1/auth/authorize", json={"pin": "9999", "action": "pickup"})
    assert resp.status_code == 200
    assert resp.json()["authorizer"]["role"] == "admin"


def test_authorize_without_pin_names_who_to_ask(
    device_client: TestClient, employees: dict[str, Employee]
) -> None:
    device_client.post(
        "/api/v1/auth/device/identify",
        json={"employee_id": employees["operator"].id, "pin": "2222"},
    )
    resp = device_client.post("/api/v1/auth/authorize", json={"action": "pickup"})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "AUTHORIZATION_REQUIRED"
    assert "administrador" in resp.json()["error"]["message"]


def test_authorize_wrong_pin(device_client: TestClient, employees: dict[str, Employee]) -> None:
    device_client.post(
        "/api/v1/auth/device/identify",
        json={"employee_id": employees["operator"].id, "pin": "2222"},
    )
    resp = device_client.post(
        "/api/v1/auth/authorize", json={"pin": "0000", "action": "courtesy"}
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "AUTHORIZATION_INVALID"


def test_supervisor_disabled_by_feature_cannot_authorize(
    device_client: TestClient, employees: dict[str, Employee], set_feature: Any
) -> None:
    device_client.post(
        "/api/v1/auth/device/identify",
        json={"employee_id": employees["operator"].id, "pin": "2222"},
    )
    set_feature("roles.supervisor", False)
    resp = device_client.post(
        "/api/v1/auth/authorize", json={"pin": "5555", "action": "discount_over_limit"}
    )
    assert resp.status_code == 400
    # El PIN sigue siendo válido; lo que no tiene es permiso con la función apagada.
    assert resp.json()["error"]["code"] == "AUTHORIZATION_NOT_ALLOWED"
