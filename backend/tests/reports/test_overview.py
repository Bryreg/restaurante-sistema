"""`GET /admin/reports/overview?store_id=<id>|all&from&to` — «Informes»: todas
las secciones de una vez.

Lo que se prueba es que NO hay una segunda matemática: cada sección es
exactamente lo que `GET /admin/sales` devuelve para esa agrupación, «Todas
las sedes» es la suma de cada sede (mismos documentos, misma función), la
hora pico la marca el servidor, el período anterior se compara con la misma
agregación y lo que el servidor no sabe viaja como `null` con motivo.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date, timedelta
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.auth.models import Employee
from app.catalog.models import Category, Product
from app.core import clock as clock_module
from app.core import security
from app.main import app
from app.stores.models import Store
from tests.conftest import STORE_PIN, _denominations_for, _seed_store_settings
from tests.reports.conftest import idem_headers, seed_fiscal_ranges

API = "/api/v1"
WIDE = {"from": "2020-01-01", "to": "2099-12-31"}


def _overview(admin_client: TestClient, store_id: int | str, **params: str) -> dict[str, Any]:
    resp = admin_client.get(f"{API}/admin/reports/overview", params={"store_id": store_id, **WIDE, **params})
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] = resp.json()
    return body


def _sales(admin_client: TestClient, store_id: int, group_by: str, **params: str) -> dict[str, Any]:
    resp = admin_client.get(
        f"{API}/admin/sales", params={"store_id": store_id, **WIDE, "group_by": group_by, **params}
    )
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] = resp.json()
    return body


def _card_payment(pin: str, order: dict[str, Any]) -> dict[str, Any]:
    body: dict[str, Any] = {"pin": pin, "splits": [{"method": "card", "amount": order["totals"]["total"]}]}
    if order.get("tip") is not None:
        body["tip"] = {"asked": True, "accepted": False, "modified": False, "amount": 0}
    return body


def _sell_by_card(device: TestClient, product: Any) -> None:
    order = device.post(f"{API}/orders", json={"channel": "counter"}, headers=idem_headers()).json()
    order = device.post(
        f"{API}/orders/{order['id']}/items",
        json={"expected_version": order["version"], "items": [{"product_id": product.id, "qty": 1}]},
        headers=idem_headers(),
    ).json()
    pay = device.post(
        f"{API}/orders/{order['id']}/payments",
        json=_card_payment("1111", order),
        headers=idem_headers(),
    )
    assert pay.status_code == 201, pay.text


# ---------------------------------------------------------------------------
# Una segunda sede de la MISMA organización, vendiendo de verdad (dispositivo
# propio, turno propio, carta propia).
# ---------------------------------------------------------------------------


@pytest.fixture()
def second_store(db: Session, store: Store) -> Store:
    now = clock_module.now_utc()
    row = Store(
        organization_id=store.organization_id,
        name="Sede Norte",
        nit=None,
        dv=None,
        legal_name=None,
        address=None,
        municipality_dane=None,
        opening_hours=[],
        cutoff_hour=6,
        active_channels=["counter", "dine_in", "takeout", "delivery", "platform"],
        store_pin_hash=security.hash_secret(STORE_PIN),
        active=True,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.flush()
    _seed_store_settings(db, row)
    db.commit()
    seed_fiscal_ranges(db, row)
    return row


@pytest.fixture()
def sell_in_second_store(db: Session, second_store: Store) -> Callable[..., dict[str, Any]]:
    now = clock_module.now_utc()
    category = Category(
        organization_id=second_store.organization_id, store_id=second_store.id, name="Platos Norte", sort_order=0,
        default_course="main", default_station=None, active=True,
    )
    db.add(category)
    db.flush()
    product = Product(
        organization_id=second_store.organization_id, store_id=second_store.id, category_id=category.id,
        name="Ajiaco", description=None, station=None, default_course="main", price_dine_in=30000,
        price_takeout=None, price_delivery=None, price_platform=None, tax_code="inc_8", active=True,
        available=True, daily_count=None, daily_remaining=None, unavailable_by_employee_id=None,
        unavailable_by_employee_name=None, unavailable_at=None, created_at=now, updated_at=now,
    )
    cashier = Employee(
        organization_id=second_store.organization_id, store_id=second_store.id, name="Cajera Norte",
        role="operator", pin_hash=security.hash_secret("7777"), email=None, password_hash=None, can_charge=True,
        discount_limit_pct=None, document=None, active=True, failed_pin_attempts=0, pin_locked_until=None,
        created_at=now, updated_at=now,
    )
    db.add_all([product, cashier])
    db.commit()

    device = TestClient(app)
    resp = device.post(f"{API}/auth/device/activate", json={"store_id": second_store.id, "store_pin": STORE_PIN})
    assert resp.status_code == 200, resp.text
    resp = device.post(f"{API}/auth/device/identify", json={"employee_id": cashier.id, "pin": "7777"})
    assert resp.status_code == 200, resp.text
    resp = device.post(
        f"{API}/shifts/open",
        json={"opening_cash": _denominations_for(200_000), "cash_reserve": 0, "cash_responsible_id": cashier.id},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert resp.status_code in (200, 201), resp.text

    def _sell(qty: int = 1) -> dict[str, Any]:
        order = device.post(f"{API}/orders", json={"channel": "counter"}, headers=idem_headers()).json()
        order = device.post(
            f"{API}/orders/{order['id']}/items",
            json={"expected_version": order["version"], "items": [{"product_id": product.id, "qty": qty}]},
            headers=idem_headers(),
        ).json()
        pay = device.post(
            f"{API}/orders/{order['id']}/payments",
            json=_card_payment("7777", order),
            headers=idem_headers(),
        )
        assert pay.status_code == 201, pay.text
        result: dict[str, Any] = pay.json()
        return result

    return _sell


# ---------------------------------------------------------------------------
# Una sede.
# ---------------------------------------------------------------------------


def test_one_store_every_section_is_the_same_math_as_sales(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, drink_product: Any, store: Any,
) -> None:
    open_shift()
    identify(device_client, employees["cashier"])
    sell(main_product, qty=2, tip_amount=3_000)
    _sell_by_card(device_client, drink_product)

    body = _overview(admin_client, store.id)
    assert body["scope"] == "store"
    assert body["store_id"] == store.id
    assert body["store_ids"] == [store.id]
    assert body["by_store"] is None

    # Indicadores: el total de «Ventas», tal cual (con período anterior).
    sales_total = _sales(admin_client, store.id, "business_date")["total"]
    for field in ("gross", "net", "tax", "tips", "orders", "avg_ticket", "avg_per_cover"):
        assert body["total"][field] == sales_total[field], field
    assert body["total"]["previous_period"] is not None
    # La propina nunca es venta.
    assert body["total"]["tips"] == 3_000
    assert body["total"]["net"] == body["total"]["gross"] - body["total"]["tax"]

    # Cada sección es la agrupación de «Ventas» correspondiente.
    for section, group_by in (
        ("by_method", "method"),
        ("by_hour", "hour"),
        ("by_employee", "employee"),
        ("by_channel", "channel"),
        ("by_zone", "zone"),
    ):
        assert body[section] == _sales(admin_client, store.id, group_by)["rows"], section
    assert body["cost"]["by_category"] == _sales(admin_client, store.id, "category")["rows"]

    # Método de pago: pagos y participación del servidor.
    methods = {r["key"]: r for r in body["by_method"]}
    assert set(methods) == {"cash", "card"}
    assert sum(r["share_bp"] for r in body["by_method"]) == 10_000
    assert all(r["payments"] == 1 for r in body["by_method"])

    # Top de productos: con unidades y la categoría para filtrar.
    products = {p["label"]: p for p in body["products"]}
    assert products["Bandeja Paisa"]["units"] == 2
    assert products["Bandeja Paisa"]["category_label"] == "Platos"
    assert products["Gaseosa"]["category_label"] == "Bebidas"
    assert body["products"][0]["label"] == "Bandeja Paisa"  # ordenado por venta neta
    assert {c["label"] for c in body["categories"]} == {"Bebidas", "Platos"}


def test_the_server_marks_the_peak_hour(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, store: Any,
) -> None:
    open_shift()
    identify(device_client, employees["cashier"])
    sell(main_product, qty=1)
    sell(main_product, qty=1)

    body = _overview(admin_client, store.id)
    peak = body["peak_hour"]
    assert peak is not None
    with_sales = [r for r in body["by_hour"] if r["net"] > 0]
    assert len(with_sales) >= 1
    top = max(with_sales, key=lambda r: r["net"])
    assert peak["hour"] == int(top["key"])
    assert peak["label"] == top["label"]
    assert peak["net"] == top["net"]
    assert peak["orders"] == top["orders"]
    assert peak["orders"] >= 1


def test_without_sales_there_is_no_peak_and_no_data_is_null_with_a_reason(
    admin_client: TestClient, store: Any,
) -> None:
    body = _overview(admin_client, store.id)
    assert body["peak_hour"] is None
    assert body["total"]["net"] == 0
    assert body["total"]["avg_ticket"] is None
    # La sede nunca operó: no hay contra qué comparar, y se dice por qué.
    previous = body["total"]["previous_period"]
    assert previous["net"] is None
    assert previous["null_reason"]
    # Costo: sin ventas costeadas, `null` (nunca `$0`).
    assert body["cost"]["theoretical_cost"] is None
    assert body["cost"]["gross_margin"] is None
    # Domicilios y clientes: lo que el servidor no tiene, con motivo.
    missing = body["delivery_customers"]["missing"]
    assert {m["key"] for m in missing} == {"delivery_zone", "returning_customers"}
    assert all(m["reason"] for m in missing)
    assert body["delivery_customers"]["delivery"] is None


def test_the_previous_period_is_the_same_aggregation(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, store: Any,
) -> None:
    open_shift()
    identify(device_client, employees["cashier"])
    sell(main_product, qty=1)
    days = [r for r in _sales(admin_client, store.id, "business_date")["rows"] if r["net"] > 0]
    assert len(days) == 1
    sold_on = date.fromisoformat(days[0]["key"])
    day_after = (sold_on + timedelta(days=1)).isoformat()

    # Mirando el día siguiente, el período anterior es el día de la venta.
    body = _overview(admin_client, store.id, **{"from": day_after, "to": day_after})
    that_day = _sales(admin_client, store.id, "business_date", **{"from": sold_on.isoformat(), "to": sold_on.isoformat()})
    previous = body["total"]["previous_period"]
    assert previous["date_from"] == sold_on.isoformat()
    assert previous["net"] == that_day["total"]["net"]
    assert previous["orders"] == that_day["total"]["orders"] == 1
    assert body["total"]["net"] == 0
    # Contra una venta real, la variación la calcula el servidor: −100 %.
    assert previous["delta_bp"] == -10_000


def test_menu_engineering_summary_respects_its_feature(
    admin_client: TestClient, set_feature: Any, store: Any,
) -> None:
    set_feature("analytics.menu_engineering", False)
    menu = _overview(admin_client, store.id)["menu_engineering"]
    assert menu["available"] is False
    assert menu["reason"]
    assert menu["star"] is None and menu["dog"] is None


def test_menu_engineering_summary_counts_come_from_analytics(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, store: Any,
) -> None:
    open_shift()
    identify(device_client, employees["cashier"])
    sell(main_product, qty=1)

    menu = _overview(admin_client, store.id)["menu_engineering"]
    matrix = admin_client.get(f"{API}/admin/menu-engineering", params={"store_id": store.id, **WIDE}).json()
    if matrix["available"]:
        for klass in ("star", "plowhorse", "puzzle", "dog", "unclassified", "insufficient_sample"):
            assert menu[klass] == matrix["counts_by_class"][klass], klass
    else:
        assert menu["available"] is False
        assert menu["reason"] == matrix["reason"]


def test_another_organizations_store_is_a_404_and_garbage_is_a_400(
    admin_client: TestClient, store_b: Any,
) -> None:
    resp = admin_client.get(f"{API}/admin/reports/overview", params={"store_id": store_b.id, **WIDE})
    assert resp.status_code == 404
    resp = admin_client.get(f"{API}/admin/reports/overview", params={"store_id": "todas", **WIDE})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


def test_the_device_never_reaches_the_overview(device_client: TestClient, store: Any) -> None:
    resp = device_client.get(f"{API}/admin/reports/overview", params={"store_id": store.id, **WIDE})
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Todas las sedes.
# ---------------------------------------------------------------------------


def test_all_stores_is_the_sum_of_each_store(
    admin_client: TestClient, device_client: TestClient, identify: Any, employees: Any, open_shift: Any,
    sell: Any, main_product: Any, store: Any, second_store: Store, sell_in_second_store: Any, store_b: Any,
) -> None:
    open_shift()
    identify(device_client, employees["cashier"])
    sell(main_product, qty=1, tip_amount=1_000)
    sell(main_product, qty=2)
    sell_in_second_store(qty=1)

    one = _overview(admin_client, store.id)
    two = _overview(admin_client, second_store.id)
    everything = _overview(admin_client, "all")

    assert everything["scope"] == "all"
    assert everything["store_id"] is None
    # Sólo las sedes de la organización del administrador: nunca la de otra.
    assert sorted(everything["store_ids"]) == sorted([store.id, second_store.id])
    assert store_b.id not in everything["store_ids"]

    for field in ("gross", "net", "tax", "tips", "orders"):
        assert everything["total"][field] == one["total"][field] + two["total"][field], field

    # Por sede: una fila por sede, cada una igual a su propio informe.
    rows = {r["store_id"]: r for r in everything["by_store"]}
    assert set(rows) == {store.id, second_store.id}
    assert rows[store.id]["store_name"] == "Sede Centro"
    assert rows[second_store.id]["store_name"] == "Sede Norte"
    for sid, alone in ((store.id, one), (second_store.id, two)):
        assert rows[sid]["net"] == alone["total"]["net"]
        assert rows[sid]["orders"] == alone["total"]["orders"]
        assert rows[sid]["avg_ticket"] == alone["total"]["avg_ticket"]
    assert sum(r["net"] for r in everything["by_store"]) == everything["total"]["net"]
    assert sum(r["share_bp"] for r in everything["by_store"]) == 10_000
    # Ordenadas por venta: la que más vendió primero.
    assert everything["by_store"][0]["net"] >= everything["by_store"][1]["net"]

    # Las secciones también consolidan: cada medio suma lo de las dos sedes.
    def by_key(rows: list[dict[str, Any]]) -> dict[str, int]:
        return {r["key"]: r["net"] for r in rows}

    merged: dict[str, int] = {}
    for part in (one, two):
        for k, v in by_key(part["by_method"]).items():
            merged[k] = merged.get(k, 0) + v
    assert by_key(everything["by_method"]) == merged
    labels = {p["label"] for p in everything["products"]}
    assert {"Bandeja Paisa", "Ajiaco"} <= labels

    # La ingeniería de menú es por sede: consolidada, «sin dato» con motivo.
    assert everything["menu_engineering"]["available"] is False
    assert "sede" in everything["menu_engineering"]["reason"]
