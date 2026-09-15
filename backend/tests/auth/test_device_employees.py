"""`GET /device/employees` («Quién opera», SPEC-NEGOCIO §9.1; A-9 de la
entrega de 1a). Sólo `id`, `name`, `role`: nunca `document`, `email`,
`discount_limit_pct`, `can_charge` ni hashes (CONTRATO-INTERNO-1b-1.md §2.4).
"""

from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.auth.models import Employee
from app.core import clock, security
from app.stores.models import Organization, Store


def test_lists_store_employees_and_org_admins_ordered_by_name(
    device_client: TestClient, employees: dict[str, Employee]
) -> None:
    resp = device_client.get("/api/v1/device/employees")
    assert resp.status_code == 200, resp.text
    rows = resp.json()

    names = [r["name"] for r in rows]
    assert names == sorted(names), "el orden es por nombre"
    assert names == ["Admin", "Cashier", "Operator", "Operator2", "Operator3", "Supervisor"]

    for row in rows:
        assert set(row.keys()) == {"id", "name", "role"}, row


def test_never_exposes_pii_or_pos_privileges(device_client: TestClient, employees: dict[str, Employee]) -> None:
    resp = device_client.get("/api/v1/device/employees")
    body = resp.json()
    forbidden = {"document", "email", "discount_limit_pct", "can_charge", "pin_hash", "password_hash"}
    for row in body:
        assert forbidden.isdisjoint(row.keys()), row


def test_excludes_inactive_employees(
    device_client: TestClient, admin_client: TestClient, employees: dict[str, Employee]
) -> None:
    operator = employees["operator"]
    deactivate = admin_client.patch(f"/api/v1/admin/employees/{operator.id}", json={"active": False})
    assert deactivate.status_code == 200, deactivate.text

    resp = device_client.get("/api/v1/device/employees")
    ids = [r["id"] for r in resp.json()]
    assert operator.id not in ids


def test_excludes_employees_of_another_store_in_the_same_organization(
    device_client: TestClient, db: Session, org: Organization, employees: dict[str, Employee]
) -> None:
    now = clock.now_utc()
    other_store = Store(
        organization_id=org.id,
        name="Sede Norte",
        nit=None,
        dv=None,
        legal_name=None,
        address=None,
        municipality_dane=None,
        opening_hours=[],
        cutoff_hour=6,
        active_channels=["counter"],
        store_pin_hash=security.hash_secret("999999"),
        active=True,
        created_at=now,
        updated_at=now,
    )
    db.add(other_store)
    db.flush()
    stranger = Employee(
        organization_id=org.id,
        store_id=other_store.id,
        name="Ajeno De Otra Sede",
        role="operator",
        pin_hash=security.hash_secret("7654"),
        can_charge=False,
        active=True,
        failed_pin_attempts=0,
        created_at=now,
        updated_at=now,
    )
    db.add(stranger)
    db.commit()

    resp = device_client.get("/api/v1/device/employees")
    ids = [r["id"] for r in resp.json()]
    assert stranger.id not in ids, "un empleado de otra sede de la MISMA organización no opera acá"


def test_does_not_require_identified_person(device_client: TestClient, employees: dict[str, Employee]) -> None:
    """`GET /device/employees` es justamente la pantalla para elegir quién se
    va a identificar: exige el dispositivo activado, nunca una persona ya
    identificada (`current_device`, persona opcional)."""

    resp = device_client.get("/api/v1/device/employees")
    assert resp.status_code == 200, resp.text
    assert len(resp.json()) >= 1
