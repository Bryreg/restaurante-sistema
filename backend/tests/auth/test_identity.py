"""Identidades: admin (correo+contraseña), dispositivo (PIN de sede) y
persona activa (PIN de 4 dígitos) — SPEC-NEGOCIO §2.1."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.auth.models import Employee
from app.stores.models import Store


def test_admin_login_sets_httponly_cookie(client: TestClient, employees: dict[str, Employee]) -> None:
    resp = client.post(
        "/api/v1/auth/admin/login", json={"email": "admin@test.local", "password": "admin1234"}
    )
    assert resp.status_code == 200
    set_cookie = resp.headers.get("set-cookie", "")
    assert "admin_session=" in set_cookie
    assert "httponly" in set_cookie.lower()
    body = resp.json()
    assert "password_hash" not in body["user"]
    assert "pin_hash" not in body["user"]


def test_admin_login_wrong_password(client: TestClient, employees: dict[str, Employee]) -> None:
    resp = client.post(
        "/api/v1/auth/admin/login", json={"email": "admin@test.local", "password": "nope"}
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "INVALID_CREDENTIALS"


def test_device_activate_sets_httponly_cookie(client: TestClient, store: Store) -> None:
    resp = client.post(
        "/api/v1/auth/device/activate", json={"store_id": store.id, "store_pin": "123456"}
    )
    assert resp.status_code == 200
    set_cookie = resp.headers.get("set-cookie", "")
    assert "device_session=" in set_cookie
    assert "httponly" in set_cookie.lower()


def test_device_activate_wrong_pin(client: TestClient, store: Store) -> None:
    resp = client.post(
        "/api/v1/auth/device/activate", json={"store_id": store.id, "store_pin": "000000"}
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "STORE_PIN_INVALID"


def test_identify_five_failures_locks_pin(
    device_client: TestClient, employees: dict[str, Employee]
) -> None:
    operator = employees["operator"]
    for _ in range(4):
        resp = device_client.post(
            "/api/v1/auth/device/identify", json={"employee_id": operator.id, "pin": "0000"}
        )
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "PIN_INVALID"

    fifth = device_client.post(
        "/api/v1/auth/device/identify", json={"employee_id": operator.id, "pin": "0000"}
    )
    assert fifth.status_code == 400
    assert fifth.json()["error"]["code"] == "PIN_LOCKED"

    # Ni siquiera el PIN correcto entra mientras está bloqueada.
    still_locked = device_client.post(
        "/api/v1/auth/device/identify", json={"employee_id": operator.id, "pin": "2222"}
    )
    assert still_locked.status_code == 400
    assert still_locked.json()["error"]["code"] == "PIN_LOCKED"


def test_identified_person_expires_with_clock(
    device_client: TestClient, employees: dict[str, Employee], clock: Any
) -> None:
    from app.core.config import settings

    operator = employees["operator"]
    ok = device_client.post(
        "/api/v1/auth/device/identify", json={"employee_id": operator.id, "pin": "2222"}
    )
    assert ok.status_code == 200

    me = device_client.get("/api/v1/auth/me").json()
    assert me["employee"] is not None
    assert me["employee"]["id"] == operator.id

    clock.advance(minutes=settings.EMPLOYEE_SESSION_MINUTES + 1)

    me_after = device_client.get("/api/v1/auth/me").json()
    assert me_after["employee"] is None
    assert me_after["employee_expires_at"] is None


def test_identify_unknown_employee_is_404(device_client: TestClient) -> None:
    resp = device_client.post(
        "/api/v1/auth/device/identify", json={"employee_id": 999999, "pin": "1234"}
    )
    assert resp.status_code == 404


def test_pin_and_password_never_in_employee_response(
    admin_client: TestClient, employees: dict[str, Employee]
) -> None:
    resp = admin_client.get("/api/v1/admin/employees")
    assert resp.status_code == 200
    for row in resp.json():
        assert "pin_hash" not in row
        assert "password_hash" not in row
        assert "pin" not in row
        assert "password" not in row
