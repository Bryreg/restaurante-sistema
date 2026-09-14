"""Auditoría con antes y después tras un PATCH (SPEC-NEGOCIO §11.3)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.auth.models import Employee
from app.stores.models import Store


def test_audit_row_has_before_and_after_on_store_update(admin_client: TestClient, store: Store) -> None:
    resp = admin_client.patch(f"/api/v1/admin/stores/{store.id}", json={"name": "Sede Renombrada"})
    assert resp.status_code == 200

    audit_resp = admin_client.get("/api/v1/admin/audit?entity=store")
    assert audit_resp.status_code == 200
    rows = audit_resp.json()
    row = next(r for r in rows if r["entity_id"] == str(store.id))
    assert row["before"]["name"] == "Sede Centro"
    assert row["after"]["name"] == "Sede Renombrada"
    assert row["action"] == "update"


def test_audit_row_records_actor(admin_client: TestClient, employees: dict[str, Employee]) -> None:
    operator = employees["operator"]
    admin_client.patch(f"/api/v1/admin/employees/{operator.id}", json={"active": False})

    # `employee_id` en /admin/audit filtra por quién hizo el cambio (el
    # autorizador), no por el empleado afectado; el admin es quien lo hizo.
    admin_id = employees["admin"].id
    audit_resp = admin_client.get(f"/api/v1/admin/audit?entity=employee&employee_id={admin_id}")
    rows = audit_resp.json()
    assert any(r["entity_id"] == str(operator.id) and r["after"]["active"] is False for r in rows)
    for r in rows:
        assert r["actor_kind"] == "admin"
        assert r["actor_employee_name"] == "Admin"


def test_audit_never_leaks_pin_or_password(admin_client: TestClient, employees: dict[str, Employee]) -> None:
    operator = employees["operator"]
    admin_client.patch(f"/api/v1/admin/employees/{operator.id}", json={"pin": "8899"})

    audit_resp = admin_client.get("/api/v1/admin/audit?entity=employee")
    body_text = audit_resp.text
    assert "pin_hash" not in body_text
    assert "password_hash" not in body_text
