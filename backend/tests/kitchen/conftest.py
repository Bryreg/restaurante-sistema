"""`tests/kitchen` reusa las fixtures de `tests/orders/conftest.py` (mismo
territorio, `backend-comanda`, y `backend-dinero-canales` para `platform`):
pytest descubre fixtures por nombre en el namespace del `conftest.py` de
cada carpeta, así que re-exportarlas acá basta — no se redefine nada, sólo
se hacen visibles para este directorio.

`starter_product` es propio de este territorio: un segundo producto CON
estación pero de un curso distinto al de `main_product` (`starter` vs
`main`), para poder probar que el orden del KDS respeta «marchar» entre dos
cursos reales."""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy.orm import Session

from app.catalog.models import Category, Product
from app.core import clock as clock_module
from app.stores.models import Store
from tests.orders.conftest import (  # noqa: F401
    add_items,
    courier,
    delivery_fee_product,
    drink_product,
    idem_headers,
    main_product,
    new_order,
    platform,
    send_order,
    tables,
    zone,
)


@pytest.fixture()
def starter_product(db: Session, store: Store) -> Any:
    """Producto CON estación (`cold_kitchen`), curso `starter` — para probar
    el orden por «marchar» contra `main_product` (curso `main`,
    `hot_kitchen`)."""
    now = clock_module.now_utc()
    category = Category(
        organization_id=store.organization_id, store_id=store.id, name="Entradas", sort_order=2,
        default_course="starter", default_station="cold_kitchen", active=True,
    )
    db.add(category)
    db.flush()
    row = Product(
        organization_id=store.organization_id, store_id=store.id, category_id=category.id, name="Ceviche",
        description=None, station="cold_kitchen", default_course="starter", price_dine_in=18000, price_takeout=16000,
        price_delivery=None, price_platform=None, tax_code="inc_8", active=True, available=True, daily_count=None,
        daily_remaining=None, unavailable_by_employee_id=None, unavailable_by_employee_name=None, unavailable_at=None,
        created_at=now, updated_at=now,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row
