"""Fixtures propias de `tests/analytics/**` (T4, fase 3).

No redefine ninguna fixture de `tests/conftest.py`. `"analytics"` ya está en
`app.main.DOMAINS`/`app.core.models_registry.MODEL_MODULES` (paso 0 del
pedido, hecho por el orquestador humano): el router se monta solo a través
de `app.main.create_app()` — este conftest **no remonta nada**
(`Duplicate Operation ID`, `docs/CONTEXTO-AGENTES.md §11`).

**Duplicación deliberada** de `main_product`/`sell`/`set_recipe`/
`admin_actor`/`create_ingredient` (ya existen en `tests/reports/conftest.py`
y `tests/inventory/conftest.py`): mismo criterio que esos dos archivos ya
declaran ("cada carpeta arma su propia base sin imports cruzados entre
carpetas de test").

**Excepción declarada al "todo entra por HTTP"**
(`docs/CONTEXTO-AGENTES.md §11`): la configuración de OTRO dominio
(categoría/producto de carta) se arma DIRECTO por ORM, porque no es el flujo
que este territorio prueba y `catalog` ya la cubre por HTTP en su propia
suite (precedente explícito de `tests/reports/conftest.py`/
`tests/channels/conftest.py` para el mismo dilema). Lo que SÍ es el flujo de
`analytics` —ventas, conteos aplicados, movimientos de inventario— entra
siempre por la puerta real (HTTP: `POST /orders`, `POST /admin/counts`,
`POST /admin/ingredients`) o, cuando no hay ruta HTTP para el dato exacto
que un test necesita armar a mano (un movimiento de inventario con un
instante puntual, para construir una ventana de conteo determinística),
por `app.inventory.hooks.record_movement` — la MISMA función pública que
usa `tests/inventory/test_variance_food_cost.py` para el mismo propósito,
nunca `db.add(StockMovement(...))` directo.
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
from app.stores.models import Store

_RANGE_PREFIX: dict[FiscalDocumentType, str] = {
    FiscalDocumentType.POS_EQUIVALENT: "POS",
    FiscalDocumentType.INVOICE: "FE",
    FiscalDocumentType.ADJUSTMENT_NOTE: "NA",
    FiscalDocumentType.CREDIT_NOTE: "NC",
    FiscalDocumentType.DEBIT_NOTE: "ND",
}


def idem_headers() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid.uuid4())}


def _seed_fiscal_ranges(db: Session, store: Store, *, to_number: int = 999_999_999) -> None:
    now = clock_module.now_utc()
    for document_type, prefix in _RANGE_PREFIX.items():
        fiscal_service.create_range(
            db, organization_id=store.organization_id, store_id=store.id, document_type=document_type,
            prefix=prefix, from_number=1, to_number=to_number, resolution_number="18760000001",
            resolution_date=date(2020, 1, 1), valid_from=date(2020, 1, 1), valid_until=date(2099, 12, 31),
            technical_key="fixture-technical-key", now=now,
        )
    db.commit()


@pytest.fixture(autouse=True)
def default_fiscal_range(db: Session, store: Store) -> None:
    _seed_fiscal_ranges(db, store)


@pytest.fixture()
def enable_analytics(set_feature: Callable[..., None]) -> Callable[[], None]:
    """Prende toda la cadena de flags que `analytics` necesita para
    probarse ENCENDIDA de punta a punta: `catalog.recipes` ->
    `inventory.perpetual` -> `inventory.counts` -> `inventory.variance`;
    `inventory.perpetual` -> `purchases`; y las dos claves propias de este
    territorio (`analytics.menu_engineering`, `inventory.replenishment`).
    Un test que necesite una capa apagada la apaga explícitamente con
    `set_feature` DESPUÉS de llamar a esto (`docs/CONTEXTO-AGENTES.md §11`:
    la precondición se arma explícita en el test, no se hereda del default)."""

    def _enable() -> None:
        set_feature("catalog.recipes", True)
        set_feature("inventory.perpetual", True)
        set_feature("inventory.counts", True)
        set_feature("inventory.variance", True)
        set_feature("purchases", True)
        set_feature("analytics.menu_engineering", True)
        set_feature("inventory.replenishment", True)

    return _enable


@pytest.fixture()
def admin_actor(store: Store, employees: dict[str, Employee]) -> Actor:
    admin = employees["admin"]
    return Actor(
        kind="admin", organization_id=store.organization_id, store_id=store.id,
        employee_id=admin.id, employee_name=admin.name, role="admin",
    )


@pytest.fixture()
def main_product(db: Session, store: Store) -> Product:
    """Plato SIN estación (pasa directo a `served`, sin cruzar cocina):
    $25.000, INC 8 %."""
    now = clock_module.now_utc()
    category = Category(
        organization_id=store.organization_id, store_id=store.id, name="Platos", sort_order=1,
        default_course="main", default_station=None, active=True,
    )
    db.add(category)
    db.flush()
    row = Product(
        organization_id=store.organization_id, store_id=store.id, category_id=category.id, name="Bandeja Paisa",
        description=None, station=None, default_course="main", price_dine_in=25000, price_takeout=None,
        price_delivery=None, price_platform=None, tax_code="inc_8", active=True, available=True, daily_count=None,
        daily_remaining=None, unavailable_by_employee_id=None, unavailable_by_employee_name=None,
        unavailable_at=None, created_at=now, updated_at=now,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@pytest.fixture()
def second_product(db: Session, store: Store) -> Product:
    now = clock_module.now_utc()
    category = Category(
        organization_id=store.organization_id, store_id=store.id, name="Platos 2", sort_order=2,
        default_course="main", default_station=None, active=True,
    )
    db.add(category)
    db.flush()
    row = Product(
        organization_id=store.organization_id, store_id=store.id, category_id=category.id, name="Sancocho",
        description=None, station=None, default_course="main", price_dine_in=18000, price_takeout=None,
        price_delivery=None, price_platform=None, tax_code="inc_8", active=True, available=True, daily_count=None,
        daily_remaining=None, unavailable_by_employee_id=None, unavailable_by_employee_name=None,
        unavailable_at=None, created_at=now, updated_at=now,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


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


@pytest.fixture()
def sell(device_client: TestClient) -> Callable[..., Any]:
    """Crea una comanda `counter`, agrega `qty` unidades de `product`, la
    cobra en efectivo y devuelve el `PaymentOut`. Turno y persona ya
    identificados por quien llama (`open_shift`/`identify` antes)."""

    def _sell(product: Product, *, qty: int = 1, pin: str = "1111") -> dict[str, Any]:
        order_resp = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem_headers())
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
            "splits": [{"method": "cash", "amount": order["totals"]["total"], "tendered": order["totals"]["total"]}],
        }
        if order.get("tip") is not None:
            pay_body["tip"] = {"asked": True, "accepted": False, "modified": False, "amount": 0}
        pay_resp = device_client.post(f"/api/v1/orders/{order['id']}/payments", json=pay_body, headers=idem_headers())
        assert pay_resp.status_code == 201, pay_resp.text
        return pay_resp.json()

    return _sell


@pytest.fixture()
def create_ingredient(admin_client: TestClient, store: Store) -> Callable[..., dict[str, Any]]:
    def _create(
        *,
        name: str = "Pechuga de pollo",
        base_unit: str = "g",
        purchase_unit: str = "kg",
        purchase_factor: int = 1000,
        yield_pct: int = 100,
        official_cost: str | None = "10",
        min_stock: str = "1000",
        lead_time_days: int | None = None,
    ) -> dict[str, Any]:
        resp = admin_client.post(
            f"/api/v1/admin/ingredients?store_id={store.id}",
            json={
                "name": name, "category": "Proteínas", "base_unit": base_unit, "purchase_unit": purchase_unit,
                "purchase_factor": purchase_factor, "yield_pct": yield_pct, "official_cost": official_cost,
                "estimated_cost": None, "min_stock": min_stock, "key_item": False,
                "consumption_untracked": False, "substitute_ingredient_id": None, "active": True,
                "lead_time_days": lead_time_days,
            },
        )
        assert resp.status_code == 201, resp.text
        return resp.json()

    return _create


@pytest.fixture()
def apply_full_count(admin_client: TestClient, store: Store) -> Callable[..., dict[str, Any]]:
    """`POST /admin/counts` (`scope=full`) + una línea por insumo + `apply`,
    puerta real de `app.inventory`. Devuelve el conteo ABIERTO (con `id`);
    quien llama ya sabe que quedó aplicado (se afirma acá con el status)."""

    def _apply(lines: dict[int, str]) -> dict[str, Any]:
        opened = admin_client.post(f"/api/v1/admin/counts?store_id={store.id}", json={"scope": "full"})
        assert opened.status_code == 201, opened.text
        count = opened.json()
        admin_client.put(
            f"/api/v1/admin/counts/{count['id']}/lines?store_id={store.id}",
            json={"lines": [{"ingredient_id": iid, "qty_counted": qty, "was_counted": True} for iid, qty in lines.items()]},
        )
        applied = admin_client.post(
            f"/api/v1/admin/counts/{count['id']}/apply?store_id={store.id}",
            json={"authorizer_pin": "9999"},
            headers=idem_headers(),
        )
        assert applied.status_code == 200, applied.text
        return count

    return _apply
