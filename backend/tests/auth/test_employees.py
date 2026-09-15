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


# ---------------------------------------------------------------------------
# A-7 (decisión resuelta por default en 1b-1, CONTRATO-INTERNO-1b-1.md §2.4):
# `document` y `email` son PII que no entra a la auditoría exportable, aunque
# `GET /admin/employees` los siga devolviendo al admin.
# ---------------------------------------------------------------------------


def _deep_keys(value: object) -> set[str]:
    found: set[str] = set()
    if isinstance(value, dict):
        for key, sub in value.items():
            found.add(str(key))
            found |= _deep_keys(sub)
    elif isinstance(value, list):
        for sub in value:
            found |= _deep_keys(sub)
    return found


def test_employee_audit_never_carries_document_or_email(
    admin_client: TestClient, store: Store
) -> None:
    created = admin_client.post(
        "/api/v1/admin/employees",
        json={
            "name": "Con Documento",
            "role": "operator",
            "pin": "4321",
            "store_id": store.id,
            "document": "1094567890",
            "email": "condocumento@test.local",
        },
    )
    assert created.status_code == 200, created.text
    employee_id = created.json()["id"]
    # `GET /admin/employees` (no auditoría) sí los devuelve al admin.
    assert created.json()["document"] == "1094567890"
    assert created.json()["email"] == "condocumento@test.local"

    updated = admin_client.patch(
        f"/api/v1/admin/employees/{employee_id}", json={"document": "1099999999"}
    )
    assert updated.status_code == 200, updated.text

    audit = admin_client.get("/api/v1/admin/audit", params={"entity": "employee"})
    assert audit.status_code == 200, audit.text
    rows = [r for r in audit.json() if r["entity_id"] == str(employee_id)]
    assert rows, "tiene que haber al menos la fila de creación y la de actualización"

    keys = _deep_keys(rows)
    assert "document" not in keys, keys
    assert "email" not in keys, keys
    # El resto de los campos sigue viajando (no es un before/after vacío).
    assert "name" in keys
