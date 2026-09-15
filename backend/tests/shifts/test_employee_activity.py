"""`GET /admin/employees/{id}/activity` ampliado en 1b-2: ventas, ticket
promedio, comandas, anulaciones (n, $, %, `after_bill`, sobre efectivo),
descuentos, cortesías, reimpresiones, `% sent_at_payment`, propinas y
comparado contra el promedio del equipo (SPEC-NEGOCIO §9.3).

Lee snapshots reales (`Order`, `OrderItem`, `FiscalDocument`, `Payment`,
`DocumentReprint`) a través de la API pública, nunca inserta filas a mano:
así el test también ejercita `app.orders`/`app.payments`/`app.fiscal`
end-to-end desde el lado de lectura."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.stores.models import Store


def idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid.uuid4())}


def _make_product(db: Session, store: Store, *, price: int = 5000) -> int:
    from app.catalog.models import Category, Product
    from app.core import clock as clock_module

    now = clock_module.now_utc()
    category = Category(
        organization_id=store.organization_id, store_id=store.id, name="Bebidas", sort_order=0,
        default_course="beverage", default_station=None, active=True,
    )
    db.add(category)
    db.flush()
    product = Product(
        organization_id=store.organization_id, store_id=store.id, category_id=category.id, name="Gaseosa",
        description=None, station=None, default_course="beverage", price_dine_in=price, price_takeout=None,
        price_delivery=None, price_platform=None, tax_code="inc_8", active=True, available=True, daily_count=None,
        daily_remaining=None, unavailable_by_employee_id=None, unavailable_by_employee_name=None,
        unavailable_at=None, created_at=now, updated_at=now,
    )
    db.add(product)
    db.commit()
    db.refresh(product)
    return product.id


def test_employee_activity_reports_sales_voids_discounts_courtesies_reprints_and_tips(
    admin_client: TestClient,
    device_client: TestClient,
    db: Session,
    identify: Any,
    employees: dict,
    open_shift: Any,
    store: Store,
    set_feature: Any,
) -> None:
    # `fiscal.dee_pos` apagada: evita depender de un `FiscalRange` vigente
    # (territorio de `backend-fiscal`, sin ruta admin en este árbol
    # todavía) — el documento se emite como `internal_receipt`, que alcanza
    # para leer `FiscalDocument.total`/`tax_total` en los reportes de venta.
    set_feature("fiscal.dee_pos", False)
    product_id = _make_product(db, store)
    cashier = employees["cashier"]
    operator = employees["operator"]
    # Necesario para que `operator` también pueda cobrar (por defecto sólo
    # `cashier` tiene `can_charge=True` en la fixture compartida) y así el
    # promedio del equipo tenga con qué compararse.
    operator.can_charge = True
    db.commit()

    open_shift(cash_responsible=cashier)

    # -- Orden A: se vende completa, con propina (contribuye a sales + tips) --
    identify(device_client, cashier)
    order_a = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem()).json()
    order_a = device_client.post(
        f"/api/v1/orders/{order_a['id']}/items",
        json={"expected_version": order_a["version"], "items": [{"product_id": product_id, "qty": 1}]},
        headers=idem(),
    ).json()
    pay_a = device_client.post(
        f"/api/v1/orders/{order_a['id']}/payments",
        json={
            "pin": "1111",
            "tip": {"asked": True, "accepted": True, "modified": False, "amount": 1000},
            "splits": [{"method": "cash", "amount": order_a["totals"]["total"] + 1000}],
        },
        headers=idem(),
    )
    assert pay_a.status_code == 201, pay_a.text
    document_id = pay_a.json()["document"]["id"]

    # Reimpresión, atribuida a `cashier` (quien la pide en el dispositivo).
    reprint_resp = device_client.post(f"/api/v1/documents/{document_id}/reprint")
    assert reprint_resp.status_code == 200, reprint_resp.text

    # -- Orden B: dos ítems; uno se anula pendiente, el otro se vende --
    order_b = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem()).json()
    order_b = device_client.post(
        f"/api/v1/orders/{order_b['id']}/items",
        json={
            "expected_version": order_b["version"],
            "items": [{"product_id": product_id, "qty": 1}, {"product_id": product_id, "qty": 1}],
        },
        headers=idem(),
    ).json()
    voided_item = order_b["items"][1]
    unit_price = voided_item["unit_price"]

    void_resp = device_client.post(
        f"/api/v1/orders/{order_b['id']}/items/{voided_item['id']}/void",
        json={"expected_version": order_b["version"], "reason": "duplicate"},
        headers=idem(),
    )
    assert void_resp.status_code == 200, void_resp.text
    order_b = void_resp.json()

    # -- Descuento de línea (5%, bajo el límite por defecto: sin PIN) --
    remaining_item = order_b["items"][0]
    discount_resp = device_client.post(
        f"/api/v1/orders/{order_b['id']}/discounts",
        json={
            "expected_version": order_b["version"],
            "scope": "item",
            "item_id": remaining_item["id"],
            "kind": "percent",
            "value": 5,
            "reason": "promo",
        },
        headers=idem(),
    )
    assert discount_resp.status_code == 200, discount_resp.text
    order_b = discount_resp.json()

    pay_b = device_client.post(
        f"/api/v1/orders/{order_b['id']}/payments",
        json={
            "pin": "1111",
            "tip": {"asked": True, "accepted": False, "modified": False, "amount": 0},
            "splits": [{"method": "cash", "amount": order_b["totals"]["total"]}],
        },
        headers=idem(),
    )
    assert pay_b.status_code == 201, pay_b.text

    # -- Orden C, de `operator` (para que el promedio del equipo tenga datos) --
    identify(device_client, operator)
    order_c = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers=idem()).json()
    order_c = device_client.post(
        f"/api/v1/orders/{order_c['id']}/items",
        json={"expected_version": order_c["version"], "items": [{"product_id": product_id, "qty": 1}]},
        headers=idem(),
    ).json()
    pay_c = device_client.post(
        f"/api/v1/orders/{order_c['id']}/payments",
        json={
            "pin": "2222",
            "tip": {"asked": True, "accepted": False, "modified": False, "amount": 0},
            "splits": [{"method": "cash", "amount": order_c["totals"]["total"]}],
        },
        headers=idem(),
    )
    assert pay_c.status_code == 201, pay_c.text

    resp = admin_client.get(f"/api/v1/admin/employees/{cashier.id}/activity?store_id={store.id}")
    assert resp.status_code == 200, resp.text
    body = resp.json()

    activity = body["activity"]
    assert activity is not None
    assert activity["sales"]["orders"] == 2  # A y B (C es de `operator`)
    assert activity["sales"]["net"] > 0
    assert activity["sales"]["avg_ticket"] is not None

    assert activity["voids"]["n"] == 1
    assert activity["voids"]["amount"] == unit_price
    assert activity["voids"]["after_bill"] == 0
    assert activity["voids"]["on_cash"] == 1  # order_b se pagó en efectivo
    assert activity["voids"]["pct_of_sales"] is not None

    assert activity["discounts"]["n"] == 1
    assert activity["discounts"]["amount"] > 0

    assert activity["reprints"] == 1
    assert activity["tips"]["cash"] == 1000
    assert activity["tips"]["total"] == 1000

    assert body["team_average"] is not None
    assert body["team_average"]["sales"]["orders"] >= 1


def test_employee_activity_csv_export(
    admin_client: TestClient, db: Session, employees: dict, store: Store
) -> None:
    cashier = employees["cashier"]
    resp = admin_client.get(f"/api/v1/admin/employees/{cashier.id}/activity?store_id={store.id}&format=csv")
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/csv")
    assert "employee_id" in resp.text


def test_employee_activity_with_no_sales_has_null_metrics_not_zero_by_default(
    admin_client: TestClient, employees: dict, store: Store
) -> None:
    """`null` no es 0: sin ventas, `avg_ticket`/`pct_of_sales` son `None`, no
    ceros disfrazados de "sin actividad" (`docs/ESTADO.md`)."""

    operator3 = employees["operator3"]
    resp = admin_client.get(f"/api/v1/admin/employees/{operator3.id}/activity?store_id={store.id}")
    assert resp.status_code == 200, resp.text
    activity = resp.json()["activity"]
    assert activity is not None
    assert activity["sales"]["orders"] == 0
    assert activity["sales"]["avg_ticket"] is None
    assert activity["voids"]["pct_of_sales"] is None
