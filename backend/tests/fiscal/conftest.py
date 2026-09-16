"""Fixtures propias de `tests/fiscal` (`CONTRATO-INTERNO-1b-1.md §3`): no
redefine ninguna fixture de `tests/conftest.py`. `tests/payments/conftest.py`
no es visible acá (directorio hermano, no ancestro) — se repite el producto
mínimo y el rango fiscal en vez de importar entre paquetes de test.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date
from typing import Any

import pytest
from sqlalchemy.orm import Session

from app.auth.deps import Actor
from app.auth.models import Employee
from app.catalog.models import Category, Product
from app.core import clock as clock_module
from app.core.modules import find_spec_safe
from app.fiscal import service as fiscal_service
from app.fiscal.models import FiscalDocumentType
from app.stores.models import Store

# `app.core.models_registry.MODEL_MODULES` todavía no incluye "customers" ni
# "refunds" (archivo `app/core/**`, fuera de mi territorio — ver `gaps` en
# el entregable): `tests/conftest.py::db` arma el esquema con
# `Base.metadata.create_all()`, que sólo crea las tablas de los `models.py`
# YA importados. Mis tests de este árbol ejercitan `app.customers.hooks`/
# `app.refunds.hooks` (protegidos con `find_spec_safe`, se llaman de
# verdad cuando el paquete existe) — sin este import a nivel de módulo, el
# PRIMER test del proceso que paga con `customer`/`refund` revienta con
# `sqlite3.OperationalError: no such table: customers` porque
# `create_all()` corrió antes de que Python viera esas clases. Importar acá
# (se ejecuta una sola vez, al recolectar este archivo, antes de que
# cualquier fixture `db` de este directorio corra) las registra en
# `Base.metadata` para el resto del proceso — sin tocar `MODEL_MODULES`.
if find_spec_safe("app.customers.models") is not None:
    import app.customers.models  # noqa: F401
if find_spec_safe("app.refunds.models") is not None:
    import app.refunds.models  # noqa: F401

# Prefijo corto por tipo (`fiscal_ranges.prefix` es `String(10)`; el `.value`
# de `adjustment_note`/`credit_note`/`debit_note` no entra).
_RANGE_PREFIX: dict[FiscalDocumentType, str] = {
    FiscalDocumentType.POS_EQUIVALENT: "POS",
    FiscalDocumentType.INVOICE: "FE",
    FiscalDocumentType.ADJUSTMENT_NOTE: "NA",
    FiscalDocumentType.CREDIT_NOTE: "NC",
    FiscalDocumentType.DEBIT_NOTE: "ND",
}


def seed_fiscal_ranges(db: Session, store: Store, *, to_number: int = 999_999_999) -> None:
    """Un rango vigente y amplio por cada tipo DIAN-trazable, para que pagar
    en un test no tropiece con `400 NO_FISCAL_RANGE` (pedido 1b-2: el cobro
    ahora exige un rango cargado, como una sede real). Los tests que
    ejercitan `NO_FISCAL_RANGE`/`FISCAL_RANGE_EXHAUSTED` de verdad usan una
    sede/rango propios, sin esta fixture (ver `test_ranges.py`)."""
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
    """Producto SIN estación: $5.000, INC 8%."""
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
    """Producto CON estación: $25.000, INC 8% (para superar el umbral de
    factura con `requests_invoice` explícito en los tests de notas)."""
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


# ---------------------------------------------------------------------------
# Ronda 2 (B-1, `backend-consumo`): notas «vuelve»/«se usó» y su reversión de
# consumo teórico. Duplicadas a propósito de `tests/orders/conftest.py`/
# `tests/reports/conftest.py` (mismo criterio de la cabecera: cada carpeta
# arma su propia base sin imports cruzados entre carpetas de test).
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
