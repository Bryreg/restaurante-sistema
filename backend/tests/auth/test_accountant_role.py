"""Rol de contador y matriz de permisos (auditoría e11)."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient

from app.auth import permissions
from app.auth.service import SUPERVISOR_ACTIONS

API = "/api/v1"


def _accountant_client(admin_client: TestClient, client: TestClient) -> TestClient:
    created = admin_client.post(f"{API}/admin/employees", json={
        "name": "Contadora", "role": "accountant", "pin": "4826",
        "email": "contadora@example.com", "password": "clave-del-contador"})
    assert created.status_code in (200, 201), created.text
    ok = client.post(f"{API}/auth/admin/login", json={"email": "contadora@example.com", "password": "clave-del-contador"})
    assert ok.status_code == 200, ok.text
    return client


def test_accountant_reads_but_cannot_write(admin_client: TestClient, client: TestClient, store: Any) -> None:
    acc = _accountant_client(admin_client, client)
    assert acc.get(f"{API}/auth/me").json()["user"]["role"] == "accountant"
    assert acc.get(f"{API}/admin/audit").status_code == 200
    assert acc.get(f"{API}/admin/stores").status_code == 200
    blocked = acc.post(f"{API}/admin/payroll/holidays", params={"store_id": store.id},
                       json={"holiday_date": "2026-03-10", "name": "x"}, headers={"Idempotency-Key": str(uuid4())})
    assert blocked.status_code == 403
    assert blocked.json()["error"]["code"] == "ACCOUNTANT_READ_ONLY"
    # Su propia seguridad sí la maneja.
    assert acc.post(f"{API}/auth/admin/2fa/setup").status_code == 200


def test_accountant_never_appears_in_the_pos(admin_client: TestClient, client: TestClient, device_client: TestClient) -> None:
    _accountant_client(admin_client, client)
    names = [e["name"] for e in device_client.get(f"{API}/device/employees").json()]
    assert "Contadora" not in names


def test_every_authorizable_action_has_a_row() -> None:
    assert SUPERVISOR_ACTIONS <= set(permissions.AUTHORIZABLE_ACTIONS)
    rows = permissions.matrix()
    assert all(r["accountant"] in ("no", "si", "solo_ver") for r in rows)
    void = next(r for r in rows if r["capacidad"] == "Anular una comanda")
    assert void["supervisor"] == "autoriza"
    approve = next(r for r in rows if r["capacidad"] == "Aprobar una cuenta por pagar")
    assert approve["supervisor"] == "con_autorizacion"


def test_permissions_endpoint(admin_client: TestClient) -> None:
    rows = admin_client.get(f"{API}/admin/permissions").json()
    assert {"area", "capability", "operator", "supervisor", "admin", "accountant"} <= set(rows[0])
