"""Fixtures propias de `tests/fiscal` (`CONTRATO-INTERNO-1b-1.md §3`): no
redefine ninguna fixture de `tests/conftest.py`. `tests/payments/conftest.py`
no es visible acá (directorio hermano, no ancestro) — se repite el producto
mínimo en vez de importar entre paquetes de test.
"""

from __future__ import annotations

import pytest
from sqlalchemy.orm import Session

from app.catalog.models import Category, Product
from app.core import clock as clock_module
from app.stores.models import Store


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
