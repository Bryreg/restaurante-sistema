"""Fixtures propias de `tests/channels` (pedido 2c).

No redefine nada de `tests/conftest.py`: agrega el rango fiscal vigente (sin
él no se puede cobrar desde 1b-2), una plataforma con comisión, un producto,
un producto de cargo de domicilio, y helpers HTTP delgados para abrir una
comanda de plataforma o de domicilio y cobrarla.

Las fixtures crean los datos DIRECTO cuando son de configuración (plataforma,
carta) y por HTTP cuando son del flujo real (comanda, cobro): el camino de
plata se prueba por el camino de plata.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from datetime import date
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.catalog.models import Category, Product
from app.channels.models import DeliveryPlatform
from app.channels.service import ensure_platform_payment_method
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

# 18 % en puntos básicos enteros. Con una venta de $100.000 la comisión es
# exactamente $18.000 — el ejemplo del contrato de este pedido.
COMMISSION_BP = 1_800


def idem() -> dict[str, str]:
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
def platform(db: Session, store: Store) -> DeliveryPlatform:
    now = clock_module.now_utc()
    row = DeliveryPlatform(
        organization_id=store.organization_id,
        store_id=store.id,
        name="Rappi",
        code="rappi",
        commission_bp=COMMISSION_BP,
        active=True,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.flush()
    ensure_platform_payment_method(db, store=store)
    db.commit()
    db.refresh(row)
    return row


@pytest.fixture()
def drink_product(db: Session, store: Store) -> Product:
    """Producto sin estación, $100.000, INC 8 % — el monto del ejemplo del
    contrato de comisión."""
    now = clock_module.now_utc()
    category = Category(
        organization_id=store.organization_id,
        store_id=store.id,
        name="Bebidas",
        sort_order=0,
        default_course="beverage",
        default_station=None,
        active=True,
    )
    db.add(category)
    db.flush()
    row = Product(
        organization_id=store.organization_id,
        store_id=store.id,
        category_id=category.id,
        name="Gaseosa",
        description=None,
        station=None,
        default_course="beverage",
        price_dine_in=100_000,
        price_takeout=None,
        price_delivery=None,
        price_platform=None,
        tax_code="inc_8",
        active=True,
        available=True,
        daily_count=None,
        daily_remaining=None,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@pytest.fixture()
def delivery_fee_product(db: Session, store: Store) -> Product:
    """El cargo de domicilio **como producto real**: §4.3 lo quiere como
    LÍNEA de la comanda (y por lo tanto con impuesto), no como un campo
    aparte. La línea la arma `app.orders` — este agente no calcula ni un
    peso de impuesto."""
    now = clock_module.now_utc()
    category = Category(
        organization_id=store.organization_id,
        store_id=store.id,
        name="Servicios",
        sort_order=9,
        default_course=None,
        default_station=None,
        active=True,
    )
    db.add(category)
    db.flush()
    row = Product(
        organization_id=store.organization_id,
        store_id=store.id,
        category_id=category.id,
        name="Cargo de domicilio",
        description=None,
        station=None,
        default_course=None,
        price_dine_in=6_000,
        price_takeout=None,
        price_delivery=None,
        price_platform=None,
        tax_code="inc_8",
        active=True,
        available=True,
        daily_count=None,
        daily_remaining=None,
        is_delivery_fee=True,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@pytest.fixture()
def channels_on(set_feature: Callable[..., None]) -> None:
    """Las cuatro funciones de 2c encendidas, respetando dependencias."""
    set_feature("pos.takeout", True)
    set_feature("pos.delivery", True)
    set_feature("pos.platforms", True)


@pytest.fixture()
def platform_order(
    device_client: TestClient,
    identify: Any,
    employees: dict,
    open_shift: Any,
    drink_product: Product,
    platform: DeliveryPlatform,
    channels_on: None,
) -> Callable[..., dict[str, Any]]:
    """Turno abierto + comanda de plataforma con un ítem. Devuelve el
    `OrderOut`."""

    def _build(*, qty: int = 1, external_id: str = "RAPPI-9001") -> dict[str, Any]:
        open_shift()
        identify(device_client, employees["cashier"])
        resp = device_client.post(
            "/api/v1/orders",
            json={
                "channel": "platform",
                "platform": {"platform_id": platform.id, "external_id": external_id},
            },
            headers=idem(),
        )
        assert resp.status_code == 201, resp.text
        order = resp.json()
        items = device_client.post(
            f"/api/v1/orders/{order['id']}/items",
            json={"expected_version": order["version"], "items": [{"product_id": drink_product.id, "qty": qty}]},
            headers=idem(),
        )
        assert items.status_code == 200, items.text
        return items.json()

    return _build


@pytest.fixture()
def delivery_order(
    device_client: TestClient,
    identify: Any,
    employees: dict,
    open_shift: Any,
    drink_product: Product,
    delivery_fee_product: Product,
    channels_on: None,
) -> Callable[..., dict[str, Any]]:
    """Turno abierto + comanda de domicilio (con domiciliario) y un ítem."""

    def _build(*, qty: int = 1, courier_key: str = "operator") -> dict[str, Any]:
        open_shift()
        identify(device_client, employees["cashier"])
        resp = device_client.post(
            "/api/v1/orders",
            json={
                "channel": "delivery",
                "delivery": {
                    "address": "Calle 1 #2-3",
                    "phone": "3001234567",
                    "courier_employee_id": employees[courier_key].id,
                },
            },
            headers=idem(),
        )
        assert resp.status_code == 201, resp.text
        order = resp.json()
        items = device_client.post(
            f"/api/v1/orders/{order['id']}/items",
            json={"expected_version": order["version"], "items": [{"product_id": drink_product.id, "qty": qty}]},
            headers=idem(),
        )
        assert items.status_code == 200, items.text
        return items.json()

    return _build


@pytest.fixture()
def pay(device_client: TestClient) -> Callable[..., Any]:
    def _pay(order: dict[str, Any], *, splits: list[dict[str, Any]], **extra: Any) -> Any:
        # `pos.tips` viene encendida en el perfil `full` (el de los tests),
        # así que cobrar exige haber PREGUNTADO por la propina
        # (`TIP_NOT_ASKED`). Por defecto se pregunta y no se deja propina;
        # los tests que quieren propina mandan `tip=` explícito.
        body: dict[str, Any] = {
            "pin": "1111",
            "splits": splits,
            "tip": {"asked": True, "accepted": False, "modified": False, "amount": 0},
            **extra,
        }
        return device_client.post(
            f"/api/v1/orders/{order['id']}/payments", json=body, headers=idem()
        )

    return _pay
