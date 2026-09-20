"""Fixtures propias de `tests/expenses/**`.

`"expenses"` ya está en `app.main.DOMAINS`/`app.core.models_registry
.MODEL_MODULES` (paso 0 del pedido, hecho por el orquestador humano antes de
este territorio): el router se monta solo a través de `app.main.create_app()`
— nunca se remonta acá (`Duplicate Operation ID`).

`drink_product`/`sell` están duplicadas a propósito de `tests/reports/
conftest.py` (carpetas hermanas, mismo criterio del proyecto: cada una arma
su propia base sin imports cruzados entre carpetas de test)."""

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


def idem_headers() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid.uuid4())}


_RANGE_PREFIX: dict[FiscalDocumentType, str] = {
    FiscalDocumentType.POS_EQUIVALENT: "POS",
    FiscalDocumentType.INVOICE: "FE",
    FiscalDocumentType.ADJUSTMENT_NOTE: "NA",
    FiscalDocumentType.CREDIT_NOTE: "NC",
    FiscalDocumentType.DEBIT_NOTE: "ND",
}


def _seed_fiscal_ranges(db: Session, store: Store) -> None:
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


@pytest.fixture(autouse=True)
def default_fiscal_range(db: Session, store: Store) -> None:
    _seed_fiscal_ranges(db, store)


@pytest.fixture()
def enable_obligations(set_feature: Callable[..., None]) -> Callable[[], None]:
    def _enable() -> None:
        set_feature("money.obligations", True)

    return _enable


@pytest.fixture(autouse=True)
def _obligations_on(enable_obligations: Callable[[], None]) -> None:
    """Encendida por default en todo `tests/expenses/**`: un test que
    necesita probarla APAGADA la apaga explícitamente con `set_feature`
    (precondición armada en el test, nunca heredada calladamente al revés)."""
    enable_obligations()


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
def sell(device_client: TestClient) -> Callable[..., Any]:
    """Crea una comanda `counter`, agrega `qty` del producto, la cobra en
    efectivo y devuelve el `PaymentOut`. Turno y persona ya identificados por
    quien llama."""

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


# ---------------------------------------------------------------------------
# Duplicadas a propósito de `tests/reports/conftest.py` (mismo criterio de la
# cabecera del archivo): sólo lo mínimo para que una venta tenga costo
# teórico congelado y `GET /admin/profit`/`GET /admin/break-even` tengan un
# margen de contribución que calcular.
# ---------------------------------------------------------------------------


@pytest.fixture()
def admin_actor(store: Store, employees: dict[str, Employee]) -> Actor:
    admin = employees["admin"]
    return Actor(
        kind="admin", organization_id=store.organization_id, store_id=store.id,
        employee_id=admin.id, employee_name=admin.name, role="admin",
    )


@pytest.fixture()
def enable_purchases(set_feature: Callable[..., None]) -> Callable[[], None]:
    """Duplicada a propósito de `tests/purchases/conftest.py` (D-2, la única
    excepción de territorio sobre `app/purchases/`; carpetas de test
    hermanas no comparten fixtures)."""

    def _enable() -> None:
        set_feature("catalog.recipes", True)
        set_feature("inventory.perpetual", True)
        set_feature("purchases", True)

    return _enable


@pytest.fixture()
def create_reception_with_invoice(
    admin_client: TestClient, store: Store, ingredient_seeded: Any, enable_purchases: Callable[[], None]
) -> Callable[..., dict[str, Any]]:
    """Una recepción confirmada (y su cuenta por pagar) real, vía HTTP — la
    única puerta por la que existe una. `invoice_total` es el campo de D-2;
    `amount_line_pesos` controla el CÁLCULO (`Payable.amount`), así que las
    dos cifras pueden divergir a propósito para probar la diferencia."""

    def _create(*, invoice_total: int | None, amount_line_pesos: str = "14500", qty: str = "1000") -> dict[str, Any]:
        enable_purchases()
        supplier_resp = admin_client.post(
            f"/api/v1/admin/suppliers?store_id={store.id}",
            json={"name": "Distribuidora D-2", "nit": None, "payment_term_days": 30, "invoices_required": True, "active": True},
        )
        assert supplier_resp.status_code == 201, supplier_resp.text
        supplier = supplier_resp.json()

        payload = {
            "supplier_id": supplier["id"],
            "invoice_number": "FE-100",
            "invoice_date": "2026-01-05",
            "no_invoice": False,
            "invoice_total": invoice_total,
            "received_by_pin": "2222",
            "lines": [
                {
                    "ingredient_id": ingredient_seeded.id,
                    "qty_received": qty,
                    "qty_invoiced": qty,
                    "purchase_unit_price": amount_line_pesos,
                    "tax_base": 0,
                    "tax_rate": 0,
                    "tax_amount": 0,
                    "lot_code": "L-D2",
                    "expires_at": "2026-06-01",
                }
            ],
        }
        resp = admin_client.post(f"/api/v1/receptions?store_id={store.id}", json=payload, headers=idem_headers())
        assert resp.status_code == 201, resp.text
        return resp.json()

    return _create


@pytest.fixture()
def set_recipe(db: Session, admin_actor: Actor, set_feature: Callable[..., None]) -> Callable[..., Any]:
    def _set(product_id: int, lines: list[dict[str, Any]], *, version: int = 0) -> Any:
        set_feature("catalog.recipes", True)
        from app.recipes import service as recipes_service
        from app.recipes.schemas import ComponentLineIn, ProductRecipeIn

        out = recipes_service.put_product_recipe(
            db, actor=admin_actor, product_id=product_id,
            data=ProductRecipeIn(version=version, lines=[ComponentLineIn(**line) for line in lines]),
        )
        db.commit()
        return out

    return _set
