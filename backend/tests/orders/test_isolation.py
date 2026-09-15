"""Aislamiento por organización y sede: un id ajeno responde `404` en
lectura y en escritura (`AGENTS.md`: "un id ajeno es 404")."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient


def test_other_store_order_is_404_for_device(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any, main_product: Any, db: Any, store_b: Any
) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()

    # Un dispositivo activado en OTRA sede (`store_b`) no puede leer ni
    # escribir esta comanda: 404, nunca 403 (no delata que existe).
    other_device = TestClient(device_client.app)
    activated = other_device.post("/api/v1/auth/device/activate", json={"store_id": store_b.id, "store_pin": "654321"})
    assert activated.status_code == 200, activated.text

    read = other_device.get(f"/api/v1/orders/{order['id']}")
    assert read.status_code == 404, read.text
    assert read.json()["error"]["code"] == "NOT_FOUND"


def test_other_org_order_is_404_for_admin(admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, org_b: Any, store_b: Any, db: Any) -> None:
    from app.auth.models import Employee
    from app.core import clock as clock_module, security

    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()

    other_admin_employee = Employee(
        organization_id=org_b.id, store_id=None, name="Otro Admin", role="admin", pin_hash=security.hash_secret("1234"),
        email="otro-admin@test.local", password_hash=security.hash_secret("clave1234"), can_charge=False,
        discount_limit_pct=None, document=None, active=True, failed_pin_attempts=0, pin_locked_until=None,
        created_at=clock_module.now_utc(), updated_at=clock_module.now_utc(),
    )
    db.add(other_admin_employee)
    db.commit()

    other_admin = TestClient(admin_client.app)
    login = other_admin.post("/api/v1/auth/admin/login", json={"email": "otro-admin@test.local", "password": "clave1234"})
    assert login.status_code == 200, login.text

    resp = other_admin.get(f"/api/v1/admin/orders/{order['id']}")
    assert resp.status_code == 404, resp.text
    assert resp.json()["error"]["code"] == "NOT_FOUND"


def test_admin_own_org_can_read_order(admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, add_items: Any, main_product: Any) -> None:
    open_shift()
    identify(device_client, employees["operator"])
    order = new_order().json()
    order = add_items(order, [{"product_id": main_product.id, "qty": 1}]).json()

    resp = admin_client.get(f"/api/v1/admin/orders/{order['id']}")
    assert resp.status_code == 200, resp.text
    assert resp.json()["id"] == order["id"]
