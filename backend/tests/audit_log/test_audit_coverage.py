"""Auditoría 2026-10-06 (e9, e12): el historial registra cambios de salario,
festivos e ingresos (y los fallidos), y se lee de a páginas."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.conftest import ADMIN_EMAIL, ADMIN_PASSWORD

API = "/api/v1"


def test_wage_and_holiday_changes_are_audited(
    admin_client: TestClient, store: Any, employees: dict[str, Any]
) -> None:
    op = employees["operator"]
    for i, (wage, since) in enumerate(((10_000, "2026-01-01"), (12_000, "2026-06-01"))):
        r = admin_client.post(f"{API}/admin/payroll/wages", params={"store_id": store.id},
                              json={"employee_id": op.id, "hourly_wage_pesos": wage, "valid_from": since},
                              headers={"Idempotency-Key": f"w{i}"})
        assert r.status_code == 201, r.text
    r = admin_client.post(f"{API}/admin/payroll/holidays", params={"store_id": store.id},
                          json={"holiday_date": "2026-03-10", "name": "Fiesta local"},
                          headers={"Idempotency-Key": "h1"})
    assert r.status_code == 201, r.text

    wages = admin_client.get(f"{API}/admin/audit", params={"entity": "payroll_wage_rate"}).json()
    assert [w["after"]["hourly_wage_pesos"] for w in wages] == [12_000, 10_000]
    assert wages[0]["before"] == {"hourly_wage_pesos": 10_000, "valid_from": "2026-01-01"}
    holidays = admin_client.get(f"{API}/admin/audit", params={"entity": "payroll_holiday"}).json()
    assert holidays[0]["after"]["name"] == "Fiesta local"


def test_logins_are_audited_and_the_list_pages(client: TestClient, admin_client: TestClient) -> None:
    bad = client.post(f"{API}/auth/admin/login", json={"email": ADMIN_EMAIL, "password": "equivocada"})
    assert bad.status_code >= 400
    ok = client.post(f"{API}/auth/admin/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert ok.status_code == 200, ok.text

    logins = admin_client.get(f"{API}/admin/audit", params={"entity": "admin_login"}).json()
    actions = [row["action"] for row in logins]
    assert "login" in actions and "login_failed" in actions
    assert all("password" not in str(row["after"]) for row in logins)

    everything = admin_client.get(f"{API}/admin/audit").json()
    page = admin_client.get(f"{API}/admin/audit", params={"limit": 1}).json()
    second = admin_client.get(f"{API}/admin/audit", params={"limit": 1, "offset": 1}).json()
    assert len(everything) >= 2 and len(page) == 1
    assert page[0]["id"] == everything[0]["id"] and second[0]["id"] == everything[1]["id"]
