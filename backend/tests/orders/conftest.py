"""Fixtures propias de `tests/orders` y `tests/kitchen`.

No redefine ninguna fixture de `tests/conftest.py` (CONTRATO-INTERNO-1b-1.md
§3): sólo agrega lo que la comanda necesita (mesas, un par de productos y
helpers HTTP delgados para crear/agregar/enviar).
"""

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
from app.fiscal import service as fiscal_service
from app.fiscal.models import FiscalDocumentType
from app.stores.models import Store, Table, Zone

# Prefijo corto por tipo (`fiscal_ranges.prefix` es `String(10)`); duplicado
# a propósito de `tests/payments/conftest.py`, `tests/fiscal/conftest.py` y
# `tests/reports/conftest.py` (directorios hermanos, mismo criterio: cada
# uno arma su propia base sin imports cruzados entre carpetas de test). La
# mayoría de `tests/orders` no cobra nada (territorio de `backend-cobro`),
# pero los tests que sí llegan a `POST /orders/{id}/payments` (p. ej.
# `tests/orders/test_admin_times.py`, que necesita un documento real para
# probar `payment_methods`/`table_minutes` del reporte) necesitan un rango
# vigente: sin esto, `pay_order` falla con `400 NO_FISCAL_RANGE`.
_RANGE_PREFIX: dict[FiscalDocumentType, str] = {
    FiscalDocumentType.POS_EQUIVALENT: "POS",
    FiscalDocumentType.INVOICE: "FE",
    FiscalDocumentType.ADJUSTMENT_NOTE: "NA",
    FiscalDocumentType.CREDIT_NOTE: "NC",
    FiscalDocumentType.DEBIT_NOTE: "ND",
}


def idem_headers() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid.uuid4())}


@pytest.fixture(autouse=True)
def default_fiscal_range(db: Session, store: Store) -> None:
    now = clock_module.now_utc()
    for document_type, prefix in _RANGE_PREFIX.items():
        fiscal_service.create_range(
            db,
            organization_id=store.organization_id,
            store_id=store.id,
            document_type=document_type,
            prefix=prefix,
            from_number=1,
            to_number=999_999_999,
            resolution_number="18760000001",
            resolution_date=date(2020, 1, 1),
            valid_from=date(2020, 1, 1),
            valid_until=date(2099, 12, 31),
            technical_key="fixture-technical-key",
            now=now,
        )
    db.commit()


@pytest.fixture()
def zone(db: Session, store: Store) -> Zone:
    row = Zone(store_id=store.id, name="Salón", sort_order=1, active=True)
    db.add(row)
    db.commit()
    return row


@pytest.fixture()
def tables(db: Session, zone: Zone, store: Store) -> list[Table]:
    rows = []
    for i in range(1, 5):
        t = Table(zone_id=zone.id, store_id=store.id, number=str(i), seats=4, active=True)
        db.add(t)
        rows.append(t)
    db.commit()
    for t in rows:
        db.refresh(t)
    return rows


@pytest.fixture()
def main_product(db: Session, store: Store) -> Product:
    """Producto CON estación (pasa por cocina al enviar)."""
    now = clock_module.now_utc()
    category = Category(
        organization_id=store.organization_id, store_id=store.id, name="Platos", sort_order=0,
        default_course="main", default_station="hot_kitchen", active=True,
    )
    db.add(category)
    db.flush()
    row = Product(
        organization_id=store.organization_id, store_id=store.id, category_id=category.id, name="Bandeja Paisa",
        description=None, station="hot_kitchen", default_course="main", price_dine_in=25000, price_takeout=22000,
        price_delivery=None, price_platform=None, tax_code="inc_8", active=True, available=True, daily_count=None,
        daily_remaining=None, unavailable_by_employee_id=None, unavailable_by_employee_name=None, unavailable_at=None,
        created_at=now, updated_at=now,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@pytest.fixture()
def drink_product(db: Session, store: Store) -> Product:
    """Producto SIN estación: pasa directo a `served` al enviar."""
    now = clock_module.now_utc()
    category = Category(
        organization_id=store.organization_id, store_id=store.id, name="Bebidas", sort_order=1,
        default_course="beverage", default_station=None, active=True,
    )
    db.add(category)
    db.flush()
    row = Product(
        organization_id=store.organization_id, store_id=store.id, category_id=category.id, name="Gaseosa",
        description=None, station=None, default_course="beverage", price_dine_in=5000, price_takeout=None,
        price_delivery=None, price_platform=None, tax_code="inc_8", active=True, available=True, daily_count=None,
        daily_remaining=None, unavailable_by_employee_id=None, unavailable_by_employee_name=None, unavailable_at=None,
        created_at=now, updated_at=now,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@pytest.fixture()
def new_order(device_client: TestClient) -> Callable[..., dict[str, Any]]:
    def _create(*, channel: str = "counter", expect_status: int = 201, **body: Any) -> Any:
        payload: dict[str, Any] = {"channel": channel, **body}
        resp = device_client.post("/api/v1/orders", json=payload, headers=idem_headers())
        if expect_status is not None:
            assert resp.status_code == expect_status, resp.text
        return resp

    return _create


@pytest.fixture()
def add_items(device_client: TestClient) -> Callable[..., Any]:
    def _add(order: dict[str, Any], items: list[dict[str, Any]], *, authorizer_pin: str | None = None, headers: dict[str, str] | None = None) -> Any:
        body: dict[str, Any] = {"expected_version": order["version"], "items": items}
        if authorizer_pin is not None:
            body["authorizer_pin"] = authorizer_pin
        resp = device_client.post(f"/api/v1/orders/{order['id']}/items", json=body, headers=headers or idem_headers())
        return resp

    return _add


@pytest.fixture()
def send_order(device_client: TestClient) -> Callable[..., Any]:
    def _send(order: dict[str, Any]) -> Any:
        resp = device_client.post(
            f"/api/v1/orders/{order['id']}/send", json={"expected_version": order["version"]}, headers=idem_headers()
        )
        return resp

    return _send


# ---------------------------------------------------------------------------
# Pedido 2a (`backend-consumo`): fixtures para armar fichas técnicas contra
# `app.recipes.service` directamente (mismo patrón que `default_fiscal_range`
# llama `app.fiscal.service` sin pasar por HTTP admin): más rápido que loguear
# un admin y no duplica la validación del router, que es territorio de
# `backend-recetas`.
# ---------------------------------------------------------------------------


@pytest.fixture()
def admin_actor(store: Store, employees: dict[str, Employee]) -> Actor:
    admin = employees["admin"]
    return Actor(
        kind="admin",
        organization_id=store.organization_id,
        store_id=store.id,
        employee_id=admin.id,
        employee_name=admin.name,
        role="admin",
    )


@pytest.fixture()
def set_recipe(db: Session, admin_actor: Actor) -> Callable[..., Any]:
    """`lines` es una lista de `{"ingredient_id"|"preparation_id": id, "qty": "texto decimal", "unit": "g"|"ml"|"unit"}`
    (mismo contrato que `POST/PUT /admin/products/{id}/recipe`). Devuelve
    `ProductRecipeOut` (trae `version`, `theoretical_cost`, `cost_source`)."""

    def _set(product_id: int, lines: list[dict[str, Any]], *, version: int = 0) -> Any:
        from app.recipes import service as recipes_service
        from app.recipes.schemas import ComponentLineIn, ProductRecipeIn

        out = recipes_service.put_product_recipe(
            db,
            actor=admin_actor,
            product_id=product_id,
            data=ProductRecipeIn(version=version, lines=[ComponentLineIn(**line) for line in lines]),
        )
        db.commit()
        return out

    return _set


@pytest.fixture()
def make_preparation(db: Session, admin_actor: Actor, store: Store) -> Callable[..., Any]:
    def _make(
        name: str,
        *,
        mode: str = "exploded",
        standard_yield_qty: str = "1000",
        standard_yield_unit: str = "g",
        lines: list[dict[str, Any]],
    ) -> Any:
        from app.recipes import service as recipes_service
        from app.recipes.schemas import ComponentLineIn, PreparationIn

        prep = recipes_service.create_preparation(
            db,
            actor=admin_actor,
            store_id=store.id,
            data=PreparationIn(
                name=name,
                mode=mode,  # type: ignore[arg-type]
                standard_yield_qty=standard_yield_qty,
                standard_yield_unit=standard_yield_unit,  # type: ignore[arg-type]
                lines=[ComponentLineIn(**line) for line in lines],
            ),
        )
        db.commit()
        return prep

    return _make


@pytest.fixture()
def produce_preparation(db: Session, admin_actor: Actor) -> Callable[..., Any]:
    def _produce(preparation: Any, *, qty_expected: str, qty_real: str) -> Any:
        from app.recipes import service as recipes_service
        from app.recipes.schemas import ProduceIn

        out = recipes_service.produce_preparation(
            db,
            actor=admin_actor,
            preparation=preparation,
            data=ProduceIn(qty_expected=qty_expected, qty_real=qty_real, employee_pin="9999"),
        )
        db.commit()
        return out

    return _produce
