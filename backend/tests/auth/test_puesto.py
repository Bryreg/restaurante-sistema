"""Inicio por rol: el puesto de cada persona (`employees.puesto`, 0027) y la
última persona que usó la tablet (`device_sessions.last_employee_id`)."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.auth.models import Employee
from app.audit.models import AuditLog


def test_puesto_is_optional_and_null_means_sees_everything(admin_client: TestClient, store: Any) -> None:
    resp = admin_client.post(
        "/api/v1/admin/employees",
        json={"name": "Sin Puesto", "role": "operator", "pin": "7777", "store_id": store.id},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["puesto"] is None


def test_admin_sets_changes_and_clears_the_puesto(admin_client: TestClient, store: Any, db: Session) -> None:
    created = admin_client.post(
        "/api/v1/admin/employees",
        json={"name": "Cocinera", "role": "operator", "pin": "7777", "store_id": store.id, "puesto": "cocina"},
    )
    assert created.status_code == 200, created.text
    employee_id = created.json()["id"]
    assert created.json()["puesto"] == "cocina"

    changed = admin_client.patch(f"/api/v1/admin/employees/{employee_id}", json={"puesto": "bar"})
    assert changed.json()["puesto"] == "bar"

    # Omitido = no cambia.
    untouched = admin_client.patch(f"/api/v1/admin/employees/{employee_id}", json={"name": "Cocinera Jefe"})
    assert untouched.json()["puesto"] == "bar"

    # `null` explícito = vuelve a ver todo.
    cleared = admin_client.patch(f"/api/v1/admin/employees/{employee_id}", json={"puesto": None})
    assert cleared.json()["puesto"] is None

    db.expire_all()
    row = db.get(Employee, employee_id)
    assert row is not None and row.puesto is None
    # El cambio queda en la auditoría como cualquier otro campo del empleado.
    audits = db.query(AuditLog).filter(AuditLog.entity == "employee", AuditLog.entity_id == str(employee_id)).all()
    assert any((a.after or {}).get("puesto") == "bar" for a in audits)


def test_an_unknown_puesto_is_rejected(admin_client: TestClient, store: Any) -> None:
    resp = admin_client.post(
        "/api/v1/admin/employees",
        json={"name": "X", "role": "operator", "pin": "7777", "store_id": store.id, "puesto": "gerencia"},
    )
    assert resp.status_code in (400, 422)


def test_identify_and_me_carry_the_puesto_and_the_last_person_of_the_tablet(
    device_client: TestClient, identify: Any, employees: dict[str, Employee], db: Session
) -> None:
    waiter = employees["operator"]
    waiter.puesto = "salon"
    db.commit()

    me = device_client.get("/api/v1/auth/me").json()
    assert me["last_employee_id"] is None

    resp = identify(device_client, waiter)
    assert resp.status_code == 200, resp.text  # type: ignore[attr-defined]
    assert resp.json()["employee"]["puesto"] == "salon"  # type: ignore[attr-defined]

    me = device_client.get("/api/v1/auth/me").json()
    assert me["employee"]["puesto"] == "salon"
    assert me["last_employee_id"] == waiter.id

    # Soltar la persona no borra quién fue la última.
    assert device_client.post("/api/v1/auth/device/release").status_code == 200
    me = device_client.get("/api/v1/auth/me").json()
    assert me["employee"] is None
    assert me["last_employee_id"] == waiter.id


def test_device_employee_list_still_has_only_three_fields(
    device_client: TestClient, employees: dict[str, Employee], db: Session
) -> None:
    employees["operator"].puesto = "cocina"
    db.commit()
    rows = device_client.get("/api/v1/device/employees").json()
    for row in rows:
        assert set(row) == {"id", "name", "role"}, row
