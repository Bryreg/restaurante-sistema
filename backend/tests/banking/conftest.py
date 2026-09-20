"""Fixtures propias de `tests/banking/**` (T1, fase 3).

No redefine ninguna fixture de `tests/conftest.py` (`db`, `client`, `org`,
`store`, `employees`, `admin_client`, `device_client`, `identify`,
`set_feature`, `clock`, `idem`, `open_shift`...): ninguna se toca acá.

**Convención heredada de `tests/channels/conftest.py`** (precedente
explícito del repo para este mismo dilema): las fixtures de CONFIGURACIÓN de
otro dominio (acá: un producto de carta, un rango fiscal) se arman DIRECTO
por ORM, porque no son el flujo que este territorio prueba y su propio
dominio ya las cubre por HTTP en su propia suite. Lo que SÍ es el flujo de
este territorio —turnos abiertos y cerrados, consignaciones, liquidaciones,
conciliación— entra siempre por la puerta real (HTTP).

`close_shift` cierra en UN PASO (`POST /shifts/{id}/close`): apaga
`cash.blind_close` para la sede de prueba porque el perfil `full` del `org`
de referencia lo trae encendido por defecto, y probar el saldo por
consignar no depende de si el cierre fue a ciegas o no — es
`app.shifts.service._finalize_close` quien escribe `to_deposit` en los dos
casos, con la MISMA fórmula.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from datetime import date
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.auth.models import Employee
from app.catalog.models import Category, Product
from app.core import clock as clock_module
from app.core import security
from app.core import tz as tz_module
from app.core.money import DENOMINATIONS
from app.fiscal import service as fiscal_service
from app.fiscal.models import FiscalDocumentType
from app.main import app
from app.stores.models import Organization, Store
from tests.conftest import KNOWN_PINS, _seed_store_settings


def today_business_date(store: Store) -> date:
    """La fecha de negocio de HOY para `store`, calculada con la MISMA
    puerta que usa el servidor (`app.core.tz.today_business_date`).

    A propósito **no** depende de la fixture `clock` de `tests/conftest.py`:
    esa fixture congela `clock.now_utc()` en una fecha fija (2026-01-15) que
    puede quedar en el PASADO respecto de la fecha real del sistema, y un
    token de sesión (dispositivo o admin) que se emite DESPUÉS de congelar
    el reloj lleva un `exp` calculado con esa fecha pasada — `PyJWT` valida
    la expiración contra la hora real del sistema, así que ese token
    aparece vencido apenas se decodifica (`DEVICE_NOT_ACTIVATED` /
    `NOT_AUTHENTICATED` sin relación aparente con la causa real). Usar la
    hora real evita la trampa por completo; el propio `app/core/tz.py` es
    la única puerta permitida para "hoy", así que esto no es un atajo, es
    la misma regla aplicada al lado del test."""

    return tz_module.today_business_date(store.cutoff_hour)

API = "/api/v1"

_RANGE_PREFIX: dict[FiscalDocumentType, str] = {
    FiscalDocumentType.POS_EQUIVALENT: "POS",
    FiscalDocumentType.INVOICE: "FE",
    FiscalDocumentType.ADJUSTMENT_NOTE: "NA",
    FiscalDocumentType.CREDIT_NOTE: "NC",
    FiscalDocumentType.DEBIT_NOTE: "ND",
}


def idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid.uuid4())}


def denoms(total: int) -> dict[str, Any]:
    rest = total
    items: list[dict[str, int]] = []
    for value in sorted(DENOMINATIONS, reverse=True):
        count, rest = divmod(rest, value)
        if count:
            items.append({"value": value, "count": count})
    assert rest == 0, f"{total} no es representable con denominaciones colombianas"
    return {"denominations": items, "total": total}


@pytest.fixture(autouse=True)
def default_fiscal_range(db: Session, store: Store) -> None:
    """Sin rango vigente no se puede cobrar (`app.fiscal`) — precondición de
    TODO pago, la misma que `tests/channels/conftest.py` ya declara."""
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


def _sale_product(db: Session, store: Store, *, price: int) -> Product:
    now = clock_module.now_utc()
    category = Category(
        organization_id=store.organization_id,
        store_id=store.id,
        name="Banking test",
        sort_order=0,
        default_course=None,
        default_station=None,
        active=True,
    )
    db.add(category)
    db.flush()
    product = Product(
        organization_id=store.organization_id,
        store_id=store.id,
        category_id=category.id,
        name=f"Item banking ${price}",
        description=None,
        station=None,
        default_course=None,
        price_dine_in=price,
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
    db.add(product)
    db.commit()
    db.refresh(product)
    return product


@pytest.fixture()
def org_basic(db: Session) -> Organization:
    """Una organización de perfil `basic` PROPIA (distinta de `org`, que es
    `full`): `money.deposits`/`money.bank` son `False` por default sólo en
    `basic` (`app/core/features.py`), así que probar "apagado por perfil,
    sin que nadie lo haya tocado a mano" necesita esta organización aparte,
    no `set_feature` sobre la de `full`."""

    now = clock_module.now_utc()
    row = Organization(name="Organización Basic", profile="basic", created_at=now, updated_at=now)
    db.add(row)
    db.commit()
    return row


@pytest.fixture()
def store_basic(db: Session, org_basic: Organization) -> Store:
    now = clock_module.now_utc()
    row = Store(
        organization_id=org_basic.id,
        name="Sede Basic",
        nit=None,
        dv=None,
        legal_name=None,
        address=None,
        municipality_dane=None,
        opening_hours=[],
        cutoff_hour=6,
        active_channels=["counter"],
        store_pin_hash=security.hash_secret("999999"),
        active=True,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.flush()
    _seed_store_settings(db, row)
    db.commit()
    return row


@pytest.fixture()
def admin_client_basic(db: Session, org_basic: Organization) -> TestClient:
    now = clock_module.now_utc()
    admin = Employee(
        organization_id=org_basic.id,
        store_id=None,
        name="Admin Basic",
        role="admin",
        pin_hash=security.hash_secret("9999"),
        email="admin-basic@test.local",
        password_hash=security.hash_secret("admin1234"),
        can_charge=False,
        discount_limit_pct=None,
        document=None,
        active=True,
        failed_pin_attempts=0,
        pin_locked_until=None,
        created_at=now,
        updated_at=now,
    )
    db.add(admin)
    db.commit()

    c = TestClient(app)
    resp = c.post("/api/v1/auth/admin/login", json={"email": "admin-basic@test.local", "password": "admin1234"})
    assert resp.status_code == 200, resp.text
    return c


@pytest.fixture()
def close_shift(device_client: TestClient, set_feature: Callable[..., None], store: Store) -> Callable[..., dict]:
    """Cierra el turno `shift_id` en un paso, con `counted_cash` exacto.

    `set_feature("cash.blind_close", False, ...)` corre en CADA llamada (no
    una vez en la fixture) porque algún test puede querer volver a
    encenderlo entre medio; es barato y explícito."""

    def _close(
        shift_id: int,
        *,
        counted_cash: int,
        tips_cash_out: int = 0,
        counted_card: int | None = None,
        counted_transfer: int | None = None,
        closes_day: bool = True,
        cause: str | None = "unrecorded_sale",
    ) -> dict:
        set_feature("cash.blind_close", False, store_id=store.id)
        payload: dict[str, Any] = {
            "counted_cash": denoms(counted_cash),
            "tips_cash_out": tips_cash_out,
            "photo": "cierre.jpg",
            "closes_day": closes_day,
        }
        if counted_card is not None:
            payload["counted_card"] = counted_card
        if counted_transfer is not None:
            payload["counted_transfer"] = counted_transfer
        if cause is not None:
            payload["cause"] = cause
        resp = device_client.post(f"{API}/shifts/{shift_id}/close", json=payload, headers=idem())
        assert resp.status_code == 200, resp.text
        return resp.json()

    return _close


@pytest.fixture()
def make_payment(
    db: Session,
    device_client: TestClient,
    store: Store,
) -> Callable[..., dict]:
    """Vende un ítem de precio EXACTO `amount` por el canal `counter` y lo
    cobra por `method`, con un turno YA abierto (`shift["id"]`). Es el
    camino real de plata: comanda -> ítem -> cobro (`app.orders`/
    `app.payments`, sólo lectura para este territorio)."""

    def _pay(*, shift: dict, method: str, amount: int, tip: int = 0) -> dict:
        product = _sale_product(db, store, price=amount)
        order_resp = device_client.post(f"{API}/orders", json={"channel": "counter"}, headers=idem())
        assert order_resp.status_code == 201, order_resp.text
        order = order_resp.json()

        items_resp = device_client.post(
            f"{API}/orders/{order['id']}/items",
            json={"expected_version": order["version"], "items": [{"product_id": product.id, "qty": 1}]},
            headers=idem(),
        )
        assert items_resp.status_code == 200, items_resp.text
        order = items_resp.json()
        total = order["totals"]["total"]

        split: dict[str, Any] = {"method": method, "amount": total + tip}
        if method != "cash":
            split["reference"] = f"REF-{method}-{order['id']}"

        pay_resp = device_client.post(
            f"{API}/orders/{order['id']}/payments",
            json={
                "pin": KNOWN_PINS["Cashier"],
                "splits": [split],
                "tip": {"asked": True, "accepted": tip > 0, "modified": False, "amount": tip},
            },
            headers=idem(),
        )
        assert pay_resp.status_code == 201, pay_resp.text
        body: dict[str, Any] = pay_resp.json()
        body["_shift_id"] = shift["id"]
        body["_amount"] = total
        return body

    return _pay
