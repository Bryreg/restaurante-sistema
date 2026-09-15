"""Fixtures propias de `tests/customers` (mismo patrón que
`features/fase-1b-venta/CONTRATO-INTERNO-1b-1.md §3`/`§1`: cada dominio
agrega un `tests/<dominio>/conftest.py` con lo que le falta; no hay un
`CONTRATO-INTERNO-1b-2.md` en este árbol al momento de escribir esto).

Este archivo montaba `app.customers.router` a mano porque `customers` no
estaba en `app.main.DOMAINS` mientras 1b-2 se construía en paralelo. Ya está
(`app/main.py:30`), así que `create_app()` lo monta: el montaje manual pasó a
montarlo por SEGUNDA vez sobre el `app` singleton compartido entre módulos de
test, y de ahí salían las advertencias `Duplicate Operation ID`. Removido en
el cierre del pedido.
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
from app.customers import models as _customers_models  # noqa: F401  (registra las tablas en Base.metadata)
from app.stores.models import Store


def idem_headers() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid.uuid4())}


@pytest.fixture()
def drink_product(db: Session, store: Store) -> Product:
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
def paid_order(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, drink_product: Product, set_feature: Any
) -> Callable[..., Any]:
    """`fiscal.dee_pos` se apaga a propósito: ver la misma nota en
    `tests/refunds/conftest.py::paid_order` — evita depender de un
    `FiscalRange` vigente (territorio de `backend-fiscal`, sin ruta admin en
    este árbol todavía)."""

    def _pay(*, qty: int = 1) -> dict[str, Any]:
        set_feature("fiscal.dee_pos", False)
        open_shift()
        identify(device_client, employees["cashier"])
        order_resp = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem_headers())
        assert order_resp.status_code == 201, order_resp.text
        order = order_resp.json()
        items_resp = device_client.post(
            f"/api/v1/orders/{order['id']}/items",
            json={"expected_version": order["version"], "items": [{"product_id": drink_product.id, "qty": qty}]},
            headers=idem_headers(),
        )
        assert items_resp.status_code == 200, items_resp.text
        order = items_resp.json()
        pay_resp = device_client.post(
            f"/api/v1/orders/{order['id']}/payments",
            json={
                "pin": "1111",
                "tip": {"asked": True, "accepted": False, "modified": False, "amount": 0},
                "splits": [{"method": "cash", "amount": order["totals"]["total"]}],
            },
            headers=idem_headers(),
        )
        assert pay_resp.status_code == 201, pay_resp.text
        return pay_resp.json()

    return _pay
