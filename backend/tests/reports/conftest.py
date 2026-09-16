"""Fixtures propias de `tests/reports` (y `tests/kitchen`, si hace falta):
no redefine ninguna fixture de `tests/conftest.py`. `seed_fiscal_ranges`
está duplicada a propósito de `tests/payments/conftest.py` y
`tests/fiscal/conftest.py` (directorios hermanos, mismo criterio: cada uno
arma su propia base sin depender de imports cruzados entre carpetas de
test)."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from datetime import date
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.auth.deps import Actor
from app.auth.models import Employee
from app.catalog.models import Category, Product
from app.core import clock as clock_module
from app.core.modules import find_spec_safe
from app.fiscal import service as fiscal_service
from app.fiscal.models import FiscalDocumentType
from app.stores.models import Store, Table, Zone

if find_spec_safe("app.customers.models") is not None:
    import app.customers.models  # noqa: F401
if find_spec_safe("app.refunds.models") is not None:
    import app.refunds.models  # noqa: F401

_RANGE_PREFIX: dict[FiscalDocumentType, str] = {
    FiscalDocumentType.POS_EQUIVALENT: "POS",
    FiscalDocumentType.INVOICE: "FE",
    FiscalDocumentType.ADJUSTMENT_NOTE: "NA",
    FiscalDocumentType.CREDIT_NOTE: "NC",
    FiscalDocumentType.DEBIT_NOTE: "ND",
}


def idem_headers() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid.uuid4())}


def seed_fiscal_ranges(db: Session, store: Store, *, to_number: int = 999_999_999) -> None:
    now = clock_module.now_utc()
    for document_type, prefix in _RANGE_PREFIX.items():
        fiscal_service.create_range(
            db,
            organization_id=store.organization_id,
            store_id=store.id,
            document_type=document_type,
            prefix=prefix,
            from_number=1,
            to_number=to_number,
            resolution_number="18760000001",
            resolution_date=date(2020, 1, 1),
            valid_from=date(2020, 1, 1),
            valid_until=date(2099, 12, 31),
            technical_key="fixture-technical-key",
            now=now,
        )
    db.commit()


@pytest.fixture(autouse=True)
def default_fiscal_range(db: Session, store: Store) -> None:
    seed_fiscal_ranges(db, store)


@pytest.fixture()
def drink_product(db: Session, store: Store) -> Product:
    """Producto SIN estación (pasa directo a `served` al enviar): $5.000, INC 8%."""
    now = clock_module.now_utc()
    category = Category(
        organization_id=store.organization_id, store_id=store.id, name="Bebidas", sort_order=0,
        default_course="beverage", default_station=None, active=True,
    )
    db.add(category)
    db.flush()
    row = Product(
        organization_id=store.organization_id, store_id=store.id, category_id=category.id, name="Gaseosa",
        description=None, station=None, default_course="beverage", price_dine_in=5000, price_takeout=None,
        price_delivery=None, price_platform=None, tax_code="inc_8", active=True, available=True, daily_count=None,
        daily_remaining=None, unavailable_by_employee_id=None, unavailable_by_employee_name=None,
        unavailable_at=None, created_at=now, updated_at=now,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@pytest.fixture()
def main_product(db: Session, store: Store) -> Product:
    """Producto CON estación (pasa por cocina al enviar): $25.000, INC 8%."""
    now = clock_module.now_utc()
    category = Category(
        organization_id=store.organization_id, store_id=store.id, name="Platos", sort_order=1,
        default_course="main", default_station="hot_kitchen", active=True,
    )
    db.add(category)
    db.flush()
    row = Product(
        organization_id=store.organization_id, store_id=store.id, category_id=category.id, name="Bandeja Paisa",
        description=None, station="hot_kitchen", default_course="main", price_dine_in=25000, price_takeout=None,
        price_delivery=None, price_platform=None, tax_code="inc_8", active=True, available=True, daily_count=None,
        daily_remaining=None, unavailable_by_employee_id=None, unavailable_by_employee_name=None,
        unavailable_at=None, created_at=now, updated_at=now,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@pytest.fixture()
def zone(db: Session, store: Store) -> Zone:
    row = Zone(store_id=store.id, name="Salón", sort_order=1, active=True)
    db.add(row)
    db.commit()
    return row


@pytest.fixture()
def tables(db: Session, zone: Zone, store: Store) -> list[Table]:
    rows = []
    for i in range(1, 3):
        t = Table(zone_id=zone.id, store_id=store.id, number=str(i), seats=4, active=True)
        db.add(t)
        rows.append(t)
    db.commit()
    for t in rows:
        db.refresh(t)
    return rows


@pytest.fixture()
def sell(device_client: TestClient) -> Callable[..., Any]:
    """Crea una comanda `counter`, agrega `qty` unidades de `product`, la
    cobra en efectivo (con propina opcional) y devuelve el `PaymentOut`
    (incluye `document`). Turno y persona ya identificados por quien llama
    (usa `open_shift`/`identify` antes)."""

    def _sell(
        product: Product,
        *,
        qty: int = 1,
        pin: str = "1111",
        tip_amount: int = 0,
        method: str = "cash",
        channel: str = "counter",
        table_ids: list[int] | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"channel": channel}
        if table_ids:
            body["table_ids"] = table_ids
        order_resp = device_client.post("/api/v1/orders", json=body, headers=idem_headers())
        assert order_resp.status_code == 201, order_resp.text
        order = order_resp.json()

        items_resp = device_client.post(
            f"/api/v1/orders/{order['id']}/items",
            json={"expected_version": order["version"], "items": [{"product_id": product.id, "qty": qty}]},
            headers=idem_headers(),
        )
        assert items_resp.status_code == 200, items_resp.text
        order = items_resp.json()

        pay_body: dict[str, Any] = {
            "pin": pin,
            "splits": [{"method": method, "amount": order["totals"]["total"] + tip_amount, "tendered": order["totals"]["total"] + tip_amount}],
        }
        if order.get("tip") is not None:
            pay_body["tip"] = {"asked": True, "accepted": tip_amount > 0, "modified": False, "amount": tip_amount}
        pay_resp = device_client.post(f"/api/v1/orders/{order['id']}/payments", json=pay_body, headers=idem_headers())
        assert pay_resp.status_code == 201, pay_resp.text
        return pay_resp.json()

    return _sell


# ---------------------------------------------------------------------------
# Pedido 2a (`backend-consumo`): duplicadas a propósito de
# `tests/orders/conftest.py` (mismo criterio de la cabecera del archivo: cada
# carpeta arma su propia base sin imports cruzados entre carpetas de test).
# ---------------------------------------------------------------------------


@pytest.fixture()
def admin_actor(store: Store, employees: dict[str, Employee]) -> Actor:
    admin = employees["admin"]
    return Actor(
        kind="admin", organization_id=store.organization_id, store_id=store.id,
        employee_id=admin.id, employee_name=admin.name, role="admin",
    )


@pytest.fixture()
def set_recipe(db: Session, admin_actor: Actor) -> Callable[..., Any]:
    def _set(product_id: int, lines: list[dict[str, Any]], *, version: int = 0) -> Any:
        from app.recipes import service as recipes_service
        from app.recipes.schemas import ComponentLineIn, ProductRecipeIn

        out = recipes_service.put_product_recipe(
            db, actor=admin_actor, product_id=product_id,
            data=ProductRecipeIn(version=version, lines=[ComponentLineIn(**line) for line in lines]),
        )
        db.commit()
        return out

    return _set
