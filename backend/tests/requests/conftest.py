"""Fixtures propias de `requests`.

Excepción declarada a «todo entra por HTTP» (`docs/CONTEXTO-AGENTES.md §11`):
los insumos se insertan directo (igual que `ingredient_seeded` del conftest
compartido) porque su alta por HTTP no es lo que se prueba acá; y los
administradores de otra organización también, porque no hay pantalla que
cree un administrador en una organización ajena.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.auth.models import Employee
from app.core import clock as clock_module
from app.core import security
from app.inventory.models import BaseUnit, Ingredient
from app.main import app
from app.stores.models import Organization, Store

API = "/api/v1"


def idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


@pytest.fixture()
def make_ingredient(db: Session, org: Organization, store: Store) -> Callable[..., Ingredient]:
    def _make(name: str, *, min_stock: int = 5000, base_unit: BaseUnit = BaseUnit.G) -> Ingredient:
        now = clock_module.now_utc()
        row = Ingredient(
            organization_id=org.id,
            store_id=store.id,
            name=name,
            category=None,
            base_unit=base_unit,
            purchase_unit="kg",
            purchase_factor=1000,
            yield_pct=100,
            official_cost_micros=14_500_000,
            estimated_cost_micros=None,
            min_stock=min_stock,
            lead_time_days=2,
            perishable=False,
            key_item=False,
            active=True,
            consumption_untracked=False,
            substitute_ingredient_id=None,
            supplier_id=None,
            created_at=now,
            updated_at=now,
        )
        db.add(row)
        db.commit()
        return row

    return _make


@pytest.fixture()
def admin_client_b(db: Session, org_b: Organization, store_b: Store) -> TestClient:
    now = clock_module.now_utc()
    db.add(
        Employee(
            organization_id=org_b.id,
            store_id=None,
            name="Admin B",
            role="admin",
            pin_hash=security.hash_secret("7777"),
            email="admin-b@test.local",
            password_hash=security.hash_secret("otra-clave-1234"),
            can_charge=False,
            discount_limit_pct=None,
            document=None,
            active=True,
            failed_pin_attempts=0,
            pin_locked_until=None,
            created_at=now,
            updated_at=now,
        )
    )
    db.commit()
    c = TestClient(app)
    resp = c.post("/api/v1/auth/admin/login", json={"email": "admin-b@test.local", "password": "otra-clave-1234"})
    assert resp.status_code == 200, resp.text
    return c


def find_secret_keys(value: Any, path: str = "") -> list[str]:
    """Toda clave con `cost` o `margin` en una respuesta, a cualquier profundidad."""
    found: list[str] = []
    if isinstance(value, dict):
        for key, inner in value.items():
            if "cost" in key.lower() or "margin" in key.lower():
                found.append(f"{path}.{key}")
            found.extend(find_secret_keys(inner, f"{path}.{key}"))
    elif isinstance(value, list):
        for i, inner in enumerate(value):
            found.extend(find_secret_keys(inner, f"{path}[{i}]"))
    return found
