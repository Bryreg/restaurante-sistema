"""Fixtures propias de `tests/refunds`. Mismo motivo que
`tests/customers/conftest.py`: `app.refunds.router` todavía no está en
`app.main.DOMAINS` (fuera de mi territorio), así que se monta a mano para que
los tests HTTP de este dominio puedan ejercer `/api/v1/admin/pending-refunds/*`
de punta a punta contra el `app` real."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.catalog.models import Category, Product
from app.core import clock as clock_module
from app.main import app
from app.refunds import models as _refunds_models  # noqa: F401  (registra las tablas en Base.metadata)
from app.refunds.router import router as refunds_router
from app.stores.models import Store

def _mount_before_spa_fallback(router: Any) -> None:
    """Ver `tests/customers/conftest.py::_mount_before_spa_fallback`: si
    `frontend/dist` existe, el catch-all SPA de `app.main._mount_frontend`
    ya está registrado antes de que este conftest corra, y por orden de
    registro interceptaría cualquier ruta agregada después."""

    app.include_router(router, prefix="/api/v1")
    routes = app.router.routes
    spa_fallback = [r for r in routes if getattr(r, "path", None) == "/{full_path:path}"]
    if spa_fallback:
        rest = [r for r in routes if r not in spa_fallback]
        app.router.routes = rest + spa_fallback


if not getattr(app, "_refunds_router_mounted", False):
    _mount_before_spa_fallback(refunds_router)
    app._refunds_router_mounted = True  # type: ignore[attr-defined]


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
    """Abre turno, crea una comanda `counter` con un ítem y la cobra en
    efectivo exacto. Devuelve el `PaymentOut` (trae `document.id`).

    `fiscal.dee_pos` se apaga a propósito: con la flag encendida (default),
    `app.fiscal.service.reserve_next_number` exige un `FiscalRange` vigente
    (territorio de `backend-fiscal`, sin ruta admin todavía para crear uno
    en este árbol — ver `gaps`). Apagada, el documento se emite como
    `internal_receipt` con el `FiscalCounter` clásico, sin rango: esto no
    prueba rangos DIAN (no es mi territorio), sólo necesita un documento
    real para las pruebas de clientes/devoluciones."""

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
