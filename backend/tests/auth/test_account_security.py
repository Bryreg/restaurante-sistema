"""Seguridad de la cuenta de administrador (auditoría e5): límite de
intentos, verificación en dos pasos y recuperación con códigos."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.auth import account_security
from tests.conftest import ADMIN_EMAIL, ADMIN_PASSWORD

API = "/api/v1"


def _login(c: TestClient, password: str = ADMIN_PASSWORD, code: str | None = None) -> Any:
    body: dict[str, Any] = {"email": ADMIN_EMAIL, "password": password}
    if code is not None:
        body["totp_code"] = code
    return c.post(f"{API}/auth/admin/login", json=body)


def test_totp_known_vector() -> None:
    # RFC 6238, apéndice B (SHA-1, 8 dígitos → los últimos 6): T=59 → 94287082.
    from datetime import datetime, timezone

    secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"  # "12345678901234567890"
    assert account_security.totp_now(secret, datetime.fromtimestamp(59, tz=timezone.utc)) == "287082"


def test_five_failures_lock_the_account(client: TestClient, employees: dict[str, Any]) -> None:
    for _ in range(5):
        assert _login(client, "equivocada").status_code == 400
    locked = _login(client)
    assert locked.status_code == 429
    assert locked.json()["error"]["code"] == "LOGIN_LOCKED"


def test_two_factor_and_recovery(client: TestClient, admin_client: TestClient) -> None:
    setup = admin_client.post(f"{API}/auth/admin/2fa/setup").json()
    assert setup["otpauth_uri"].startswith("otpauth://totp/")
    bad = admin_client.post(f"{API}/auth/admin/2fa/enable", json={"code": "000000"})
    assert bad.status_code == 400
    enabled = admin_client.post(
        f"{API}/auth/admin/2fa/enable", json={"code": account_security.totp_now(setup["secret"])}
    )
    assert enabled.status_code == 200, enabled.text
    codes = enabled.json()["recovery_codes"]
    assert len(codes) == 10

    # Sin código: pide el código. Con el de la app: entra.
    need = _login(client)
    assert need.status_code == 401 and need.json()["error"]["code"] == "TOTP_REQUIRED"
    assert _login(client, code=account_security.totp_now(setup["secret"])).status_code == 200
    # Un código de recuperación sirve una sola vez.
    assert _login(client, code=codes[0]).status_code == 200
    assert _login(client, code=codes[0]).status_code == 401

    # Olvidé la contraseña: correo + código de recuperación.
    rec = client.post(f"{API}/auth/recover",
                      json={"email": ADMIN_EMAIL, "recovery_code": codes[1], "new_password": "una-clave-nueva-larga"})
    assert rec.status_code == 200, rec.text
    assert _login(client, "una-clave-nueva-larga", code=codes[2]).status_code == 200

    state = admin_client.get(f"{API}/auth/admin/security").json()
    assert state == {"totp_enabled": True, "recovery_codes_left": 7}


def test_change_password_needs_the_current_one(admin_client: TestClient) -> None:
    wrong = admin_client.post(f"{API}/auth/admin/password",
                              json={"current_password": "no-es", "new_password": "otra-clave-larga-1"})
    assert wrong.status_code == 401
    ok = admin_client.post(f"{API}/auth/admin/password",
                           json={"current_password": ADMIN_PASSWORD, "new_password": "otra-clave-larga-1"})
    assert ok.status_code == 200
