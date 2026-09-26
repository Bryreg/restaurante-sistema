"""La puerta de entrada en la tablet: la sesión de administrador abierta desde
un dispositivo es corta, salir de ella devuelve el POS, y re-activar no
duplica sesiones de dispositivo."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.models import DeviceSession
from tests.conftest import ADMIN_EMAIL, ADMIN_PASSWORD, STORE_PIN

API = "/api/v1"


def _max_age(set_cookie: str) -> int:
    for part in set_cookie.split(";"):
        part = part.strip()
        if part.lower().startswith("max-age="):
            return int(part.split("=", 1)[1])
    raise AssertionError(f"sin Max-Age: {set_cookie}")


def test_admin_login_on_a_pc_keeps_the_long_session(client: TestClient, employees: dict[str, Any]) -> None:
    resp = client.post(f"{API}/auth/admin/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert resp.status_code == 200, resp.text
    assert _max_age(resp.headers["set-cookie"]) == 12 * 3600
    me = client.get(f"{API}/auth/me").json()
    assert me["kind"] == "admin"
    assert me["on_device"] is False


def test_admin_login_from_a_tablet_is_short_and_logout_returns_the_pos(
    device_client: TestClient, employees: dict[str, Any]
) -> None:
    resp = device_client.post(
        f"{API}/auth/admin/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}
    )
    assert resp.status_code == 200, resp.text
    assert _max_age(resp.headers["set-cookie"]) == 15 * 60

    me = device_client.get(f"{API}/auth/me").json()
    assert me["kind"] == "admin"
    assert me["on_device"] is True
    assert me["session_expires_at"] is not None

    out = device_client.post(f"{API}/auth/logout")
    assert out.status_code == 200
    back = device_client.get(f"{API}/auth/me")
    assert back.status_code == 200
    assert back.json()["kind"] == "device"


def test_reactivating_revokes_the_previous_device_session(device_client: TestClient, store: Any, db: Session) -> None:
    again = device_client.post(f"{API}/auth/device/activate", json={"store_id": store.id, "store_pin": STORE_PIN})
    assert again.status_code == 200, again.text

    db.expire_all()
    sessions = list(db.execute(select(DeviceSession).order_by(DeviceSession.created_at)).scalars())
    assert len(sessions) == 2  # nada se borra
    assert [s.revoked_at is None for s in sessions].count(True) == 1
    assert device_client.get(f"{API}/auth/me").json()["kind"] == "device"


def test_supervisor_on_the_tablet_gets_no_cost_fields_in_the_session(
    device_client: TestClient, identify: Any, employees: dict[str, Any]
) -> None:
    identify(device_client, employees["supervisor"])
    me = device_client.get(f"{API}/auth/me").json()
    assert me["employee"]["role"] == "supervisor"
    assert "cost" not in str(me).lower()
