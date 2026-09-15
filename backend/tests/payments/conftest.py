"""Fixtures propias de `tests/payments` y `tests/fiscal`
(`CONTRATO-INTERNO-1b-1.md §3`): no redefine ninguna fixture de
`tests/conftest.py`, sólo agrega lo que el cobro necesita (un producto para
vender, mesas para `dine_in`, y helpers HTTP delgados para crear la comanda,
agregar ítems y cobrar).
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.catalog.models import Category, Product
from app.core import clock as clock_module
from app.stores.models import Store, Table, Zone


def idem_headers() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid.uuid4())}


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
def add_items(device_client: TestClient) -> Callable[..., Any]:
    def _add(order: dict[str, Any], items: list[dict[str, Any]]) -> Any:
        body = {"expected_version": order["version"], "items": items}
        resp = device_client.post(f"/api/v1/orders/{order['id']}/items", json=body, headers=idem_headers())
        assert resp.status_code == 200, resp.text
        return resp.json()

    return _add


@pytest.fixture()
def pay(device_client: TestClient) -> Callable[..., Any]:
    def _pay(
        order: dict[str, Any],
        *,
        splits: list[dict[str, Any]],
        pin: str = "1111",
        tip: dict[str, Any] | None = None,
        expected_version: int | None = None,
        sub_account_id: int | None = None,
        headers: dict[str, str] | None = None,
    ) -> Any:
        body: dict[str, Any] = {"pin": pin, "splits": splits}
        if tip is not None:
            body["tip"] = tip
        if expected_version is not None:
            body["expected_version"] = expected_version
        if sub_account_id is not None:
            body["sub_account_id"] = sub_account_id
        return device_client.post(
            f"/api/v1/orders/{order['id']}/payments", json=body, headers=headers or idem_headers()
        )

    return _pay


@pytest.fixture()
def counter_order_with_items(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, drink_product: Product
) -> Callable[..., Any]:
    """Abre turno (responsable = cajero, PIN "1111", `can_charge=True`) y crea
    una comanda `counter` con un ítem `pending` (`drink_product`, sin
    estación). Devuelve el `OrderOut`. `opened_by` permite identificarse como
    otra persona antes de crear la comanda (para probar `CANNOT_CHARGE`)."""

    def _build(*, qty: int = 1, opened_by: str = "cashier") -> dict[str, Any]:
        open_shift()
        identify(device_client, employees[opened_by])
        order_resp = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem_headers())
        assert order_resp.status_code == 201, order_resp.text
        order = order_resp.json()
        items_resp = device_client.post(
            f"/api/v1/orders/{order['id']}/items",
            json={"expected_version": order["version"], "items": [{"product_id": drink_product.id, "qty": qty}]},
            headers=idem_headers(),
        )
        assert items_resp.status_code == 200, items_resp.text
        return items_resp.json()

    return _build


@pytest.fixture()
def dine_in_order_with_items(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, drink_product: Product, tables: list[Table]
) -> Callable[..., Any]:
    """Igual que `counter_order_with_items` pero canal `dine_in` sobre la
    primera mesa, para probar que cobrar libera la mesa."""

    def _build(*, qty: int = 1) -> dict[str, Any]:
        open_shift()
        identify(device_client, employees["cashier"])
        order_resp = device_client.post(
            "/api/v1/orders", json={"channel": "dine_in", "table_ids": [tables[0].id]}, headers=idem_headers()
        )
        assert order_resp.status_code == 201, order_resp.text
        order = order_resp.json()
        items_resp = device_client.post(
            f"/api/v1/orders/{order['id']}/items",
            json={"expected_version": order["version"], "items": [{"product_id": drink_product.id, "qty": qty}]},
            headers=idem_headers(),
        )
        assert items_resp.status_code == 200, items_resp.text
        return items_resp.json()

    return _build


@pytest.fixture()
def paid_order(counter_order_with_items: Callable[..., Any], pay: Callable[..., Any]) -> Callable[..., Any]:
    """Comanda `counter` cobrada en efectivo exacto, sin propina. Devuelve el
    `PaymentOut`."""

    def _pay_order(**kwargs: Any) -> Any:
        order = counter_order_with_items()
        resp = pay(order, splits=[{"method": "cash", "amount": order["totals"]["total"]}], **kwargs)
        assert resp.status_code == 201, resp.text
        return resp.json()

    return _pay_order
