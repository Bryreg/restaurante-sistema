"""Food cost real con ventana ALINEADA y guardas (informe de visualización,
#3; analista #1), y el food cost teórico de la misma ventana al lado.

Antes: las ventas se tomaban por `business_date` inclusivo en los dos
extremos y el inventario por instante — una ventana de 16 h se comparaba
contra días enteros de venta (−77,75 % en los datos simulados), y la venta
del día del conteo caía en dos ventanas. Ahora todo usa los instantes de los
conteos `(apertura anterior, apertura actual]`, las comandas por `paid_at`.

**Duplicación deliberada** de `main_product`/`set_recipe`/`sell` (ya existen
en `tests/analytics/conftest.py`): cada carpeta de test arma su propia base,
sin imports cruzados entre carpetas (mismo criterio que ese conftest)."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from datetime import date, datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.auth.deps import Actor
from app.auth.models import Employee
from app.catalog.models import Category, Product
from app.core import clock as clock_module
from app.core import tz
from app.fiscal import service as fiscal_service
from app.fiscal.models import FiscalDocumentType
from app.inventory import hooks
from app.inventory.models import CostSource, MovementCause
from app.stores.models import Store

API = "/api/v1"


def _idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid.uuid4())}


@pytest.fixture(autouse=True)
def _fiscal_ranges(db: Session, store: Store) -> None:
    now = clock_module.now_utc()
    for document_type, prefix in ((FiscalDocumentType.POS_EQUIVALENT, "POS"), (FiscalDocumentType.INVOICE, "FE")):
        fiscal_service.create_range(
            db, organization_id=store.organization_id, store_id=store.id, document_type=document_type,
            prefix=prefix, from_number=1, to_number=999_999_999, resolution_number="18760000001",
            resolution_date=date(2020, 1, 1), valid_from=date(2020, 1, 1), valid_until=date(2099, 12, 31),
            technical_key="fixture-technical-key", now=now,
        )
    db.commit()


@pytest.fixture(autouse=True)
def _flags(set_feature: Callable[..., None]) -> None:
    for key in ("catalog.recipes", "inventory.perpetual", "inventory.counts", "inventory.variance", "purchases"):
        set_feature(key, True)


def _product(db: Session, store: Store, name: str, price: int) -> Product:
    now = clock_module.now_utc()
    category = Category(
        organization_id=store.organization_id, store_id=store.id, name=f"Cat {name}", sort_order=1,
        default_course="main", default_station=None, active=True,
    )
    db.add(category)
    db.flush()
    row = Product(
        organization_id=store.organization_id, store_id=store.id, category_id=category.id, name=name,
        description=None, station=None, default_course="main", price_dine_in=price, price_takeout=None,
        price_delivery=None, price_platform=None, tax_code="inc_8", active=True, available=True, daily_count=None,
        daily_remaining=None, unavailable_by_employee_id=None, unavailable_by_employee_name=None,
        unavailable_at=None, created_at=now, updated_at=now,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _admin_actor(store: Store, employees: dict[str, Employee]) -> Actor:
    admin = employees["admin"]
    return Actor(
        kind="admin", organization_id=store.organization_id, store_id=store.id,
        employee_id=admin.id, employee_name=admin.name, role="admin",
    )


def _set_recipe(db: Session, actor: Actor, product_id: int, ingredient_id: int, qty: str) -> None:
    from app.recipes import service as recipes_service
    from app.recipes.schemas import ComponentLineIn, ProductRecipeIn

    recipes_service.put_product_recipe(
        db, actor=actor, product_id=product_id,
        data=ProductRecipeIn(version=0, lines=[ComponentLineIn(ingredient_id=ingredient_id, qty=qty, unit="g")]),
    )
    db.commit()


def _sell(device_client: TestClient, product: Product) -> None:
    order = device_client.post(f"{API}/orders", json={"channel": "counter"}, headers=_idem()).json()
    order = device_client.post(
        f"{API}/orders/{order['id']}/items",
        json={"expected_version": order["version"], "items": [{"product_id": product.id, "qty": 1}]},
        headers=_idem(),
    ).json()
    body: dict[str, Any] = {
        "pin": "1111",
        "splits": [{"method": "cash", "amount": order["totals"]["total"], "tendered": order["totals"]["total"]}],
    }
    if order.get("tip") is not None:
        body["tip"] = {"asked": True, "accepted": False, "modified": False, "amount": 0}
    paid = device_client.post(f"{API}/orders/{order['id']}/payments", json=body, headers=_idem())
    assert paid.status_code == 201, paid.text


def _count(admin_client: TestClient, store: Store, ingredient_id: int, qty: str) -> dict[str, Any]:
    opened = admin_client.post(f"{API}/admin/counts?store_id={store.id}", json={"scope": "full"}).json()
    admin_client.put(
        f"{API}/admin/counts/{opened['id']}/lines?store_id={store.id}",
        json={"lines": [{"ingredient_id": ingredient_id, "qty_counted": qty, "was_counted": True}]},
    )
    applied = admin_client.post(
        f"{API}/admin/counts/{opened['id']}/apply?store_id={store.id}", json={"authorizer_pin": "9999"}, headers=_idem()
    )
    assert applied.status_code == 200, applied.text
    return opened


def _noon(day: int) -> datetime:
    # 12:00 en Bogotá (17:00 UTC): lejos del corte de la sede.
    return datetime(2026, 3, 1, 17, tzinfo=timezone.utc) + timedelta(days=day)


def _purchase(db: Session, store: Store, actor: Actor, ingredient_id: int, qty_base: int, cost_micros: int | None) -> None:
    hooks.record_movement(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=qty_base, cause=MovementCause.PURCHASE, cost_micros=cost_micros,
        cost_source=CostSource.OFFICIAL if cost_micros is not None else CostSource.NONE,
        actor=actor, business_date=tz.business_date_for(clock_module.now_utc(), store.cutoff_hour),
        at=clock_module.now_utc(),
    )
    db.commit()


@pytest.fixture()
def scene(
    db: Session, store: Store, employees: dict[str, Employee], admin_client: TestClient, device_client: TestClient,
    identify: Any, open_shift: Any, create_ingredient: Callable[..., dict[str, Any]],
) -> dict[str, Any]:
    """Insumo a $1/g; «Bandeja» ($25.000 con INC 8 % → $23.148 netos) gasta
    100 g ($100 de costo teórico congelado). Cada test pide `scene` ANTES
    que `clock`: el dispositivo y el admin se autentican con el reloj real
    (el vencimiento del token se valida contra la hora real)."""
    ing = create_ingredient(name="Insumo ventana", official_cost="1", min_stock="1")
    actor = _admin_actor(store, employees)
    bandeja = _product(db, store, "Bandeja", 25000)
    _set_recipe(db, actor, bandeja.id, ing["id"], "100")
    open_shift()

    def sell(product: Product = bandeja) -> None:
        identify(device_client, employees["cashier"])
        _sell(device_client, product)

    return {"ing": ing["id"], "actor": actor, "bandeja": bandeja, "sell": sell}


def _food_cost(admin_client: TestClient, store: Store) -> dict[str, Any]:
    resp = admin_client.get(f"{API}/admin/food-cost", params={"store_id": store.id, "from": "2020-01-01", "to": "2030-01-01"})
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_food_cost_uses_the_count_instants_for_sales_and_publishes_theoretical_and_gap(
    db: Session, store: Store, admin_client: TestClient, scene: dict[str, Any], clock: Any
) -> None:
    ing = scene["ing"]
    clock.set(_noon(0))
    c1 = _count(admin_client, store, ing, "20000")  # $20.000
    clock.set(_noon(1))
    scene["sell"]()  # 100 g, $23.148 netos
    clock.set(_noon(1) + timedelta(hours=1))
    _purchase(db, store, scene["actor"], ing, 1_000_000, 1_000_000)  # 1.000 g a $1 = $1.000
    clock.set(_noon(4))
    # 20.000 − 100 (venta) + 1.000 (compra) − 500 (fuga) = 20.400 g = $20.400
    c2 = _count(admin_client, store, ing, "20400")
    # Venta del MISMO día de negocio del conteo de cierre, pero después de
    # él: con la ventana por `business_date` inclusivo entraba; ya no.
    clock.set(_noon(4) + timedelta(hours=2))
    scene["sell"]()

    body = _food_cost(admin_client, store)
    assert body["opening_count_id"] == c1["id"] and body["closing_count_id"] == c2["id"]
    assert body["available"] is True, body
    assert body["window_hours"] == 96
    assert body["window_days"] == 4
    assert body["orders_in_window"] == 1
    assert body["net_sales"] == 23148
    assert (body["opening_value"], body["purchases_value"], body["closing_value"]) == (20000, 1000, 20400)
    # Real: (20.000 + 1.000 − 20.400) ÷ 23.148 = 600 ÷ 23.148 = 2,59 % → 259 bp.
    assert body["pct_bp"] == 259
    # Teórico: 100 ÷ 23.148 = 0,43 % → 43 bp; brecha 259 − 43 = 216 bp.
    assert body["theoretical_pct_bp"] == 43
    assert body["costed_pct_bp"] == 10000
    assert body["gap_bp"] == 216
    assert body["theoretical_reason"] is None
    assert (body["min_window_days"], body["min_costed_pct_bp"]) == (1, 8000)


def test_food_cost_is_null_with_a_reason_when_the_window_is_shorter_than_a_day(
    db: Session, store: Store, admin_client: TestClient, scene: dict[str, Any], clock: Any
) -> None:
    ing = scene["ing"]
    clock.set(_noon(0))
    _count(admin_client, store, ing, "20000")
    clock.set(_noon(0) + timedelta(hours=4))
    scene["sell"]()
    clock.set(_noon(0) + timedelta(hours=16))
    _count(admin_client, store, ing, "19900")

    body = _food_cost(admin_client, store)
    assert body["available"] is False
    assert body["pct_bp"] is None
    assert body["gap_bp"] is None
    assert body["window_hours"] == 16 and body["window_days"] == 0
    assert "16 h" in body["reason"] and "24 h" in body["reason"]
    # El teórico sí se puede publicar: 100 ÷ 23.148 → 43 bp.
    assert body["theoretical_pct_bp"] == 43
    assert body["orders_in_window"] == 1


def test_food_cost_is_null_when_real_cost_is_negative(
    db: Session, store: Store, admin_client: TestClient, scene: dict[str, Any], clock: Any
) -> None:
    ing = scene["ing"]
    clock.set(_noon(0))
    _count(admin_client, store, ing, "1000")
    clock.set(_noon(1))
    scene["sell"]()
    clock.set(_noon(4))
    _count(admin_client, store, ing, "12000")  # final 12 veces el inicial, sin compras

    body = _food_cost(admin_client, store)
    assert body["available"] is False
    assert body["pct_bp"] is None
    assert "inventario final" in body["reason"]
    assert body["gap_bp"] is None


def test_food_cost_is_null_when_purchases_are_zero_but_there_were_receptions(
    db: Session, store: Store, admin_client: TestClient, scene: dict[str, Any], clock: Any
) -> None:
    ing = scene["ing"]
    clock.set(_noon(0))
    _count(admin_client, store, ing, "20000")
    clock.set(_noon(1))
    scene["sell"]()
    _purchase(db, store, scene["actor"], ing, 5_000_000, None)  # entra mercancía SIN costo
    clock.set(_noon(4))
    _count(admin_client, store, ing, "20000")

    body = _food_cost(admin_client, store)
    assert body["purchases_value"] == 0
    assert body["available"] is False
    assert body["pct_bp"] is None
    assert "recepciones" in body["reason"]


def test_food_cost_theoretical_is_null_below_eighty_percent_costed_coverage(
    db: Session, store: Store, admin_client: TestClient, scene: dict[str, Any], clock: Any
) -> None:
    ing = scene["ing"]
    sin_ficha = _product(db, store, "Sin ficha", 18000)  # $16.667 netos, sin receta
    clock.set(_noon(0))
    _count(admin_client, store, ing, "20000")
    clock.set(_noon(1))
    scene["sell"]()
    scene["sell"](sin_ficha)
    clock.set(_noon(4))
    _count(admin_client, store, ing, "19800")  # 100 de la venta + 100 de fuga

    body = _food_cost(admin_client, store)
    assert body["net_sales"] == 23148 + 16667
    assert body["orders_in_window"] == 2
    # Real: 200 ÷ 39.815 = 0,50 % → 50 bp (el real no depende de las fichas).
    assert body["pct_bp"] == 50
    # Cobertura: 23.148 ÷ 39.815 = 58,14 % → 5814 bp < 8000: sin teórico.
    assert body["costed_pct_bp"] == 5814
    assert body["theoretical_pct_bp"] is None
    assert "ficha" in body["theoretical_reason"]
    assert body["gap_bp"] is None


def test_theoretical_food_cost_scales_to_costed_coverage_and_refuses_below_the_threshold() -> None:
    """Con 90 % de las ventas con ficha, el teórico es costo ÷ ventas de lo
    costeado (900 ÷ 9.000 = 10 %), no costo ÷ ventas totales (9 %), que
    inflaría la brecha real − teórico en un punto (informe #4/#15)."""
    scaled = hooks.theoretical_food_cost(net_sales=10_000, costed_net=9_000, theoretical_cost_micros=900_000_000)
    assert (scaled.pct_bp, scaled.costed_pct_bp, scaled.reason) == (1000, 9000, None)

    low = hooks.theoretical_food_cost(net_sales=10_000, costed_net=7_000, theoretical_cost_micros=700_000_000)
    assert low.pct_bp is None and low.costed_pct_bp == 7000
    assert low.reason is not None and "70,0" in low.reason

    none = hooks.theoretical_food_cost(net_sales=10_000, costed_net=0, theoretical_cost_micros=None)
    assert none.pct_bp is None and none.costed_pct_bp == 0 and none.reason
