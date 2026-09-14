"""CRUD de empleados: baja lógica, nunca DELETE, aislamiento por organización."""

from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.auth.models import Employee
from app.core import clock
from app.core.security import hash_secret
from app.stores.models import Organization, Store


def test_create_employee(admin_client: TestClient, store: Store) -> None:
    resp = admin_client.post(
        "/api/v1/admin/employees",
        json={"name": "Nuevo Mesero", "role": "operator", "pin": "7777", "store_id": store.id},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "Nuevo Mesero"
    assert "pin" not in body


def test_deactivate_instead_of_delete(admin_client: TestClient, employees: dict[str, Employee]) -> None:
    operator = employees["operator"]
    resp = admin_client.patch(f"/api/v1/admin/employees/{operator.id}", json={"active": False})
    assert resp.status_code == 200
    assert resp.json()["active"] is False

    listing = admin_client.get("/api/v1/admin/employees").json()
    assert any(row["id"] == operator.id for row in listing)  # sigue existiendo, no se borró


def test_employee_of_other_org_is_404(
    admin_client: TestClient, db: Session, org_b: Organization, store_b: Store
) -> None:
    now = clock.now_utc()
    foreign = Employee(
        organization_id=org_b.id,
        store_id=store_b.id,
        name="De otra organización",
        role="operator",
        pin_hash=hash_secret("1212"),
        email=None,
        password_hash=None,
        can_charge=False,
        discount_limit_pct=None,
        document=None,
        active=True,
        failed_pin_attempts=0,
        pin_locked_until=None,
        created_at=now,
        updated_at=now,
    )
    db.add(foreign)
    db.flush()

    resp = admin_client.patch(f"/api/v1/admin/employees/{foreign.id}", json={"active": False})
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "NOT_FOUND"

    listing = admin_client.get("/api/v1/admin/employees").json()
    assert all(row["id"] != foreign.id for row in listing)


def test_duplicate_email_is_rejected(admin_client: TestClient, employees: dict[str, Employee], store: Store) -> None:
    resp = admin_client.post(
        "/api/v1/admin/employees",
        json={
            "name": "Otro Admin",
            "role": "admin",
            "pin": "8888",
            "email": "admin@test.local",
            "password": "x",
        },
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "EMAIL_TAKEN"
