"""Tanda 5, i2: comparación de proveedores de un insumo.

Último precio, promedio de los últimos 90 días, cuánto tarda en entregar y
la recomendación (el proveedor activo más barato con compra reciente), todo
en `GET /admin/ingredients/{id}/supplier-prices`."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.stores.models import Store

API = "/api/v1"


def _idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


def _receive(
    client: TestClient,
    store: Store,
    supplier_id: int,
    ingredient_id: int,
    price: str,
    *,
    qty: str = "1000",
    order_id: int | None = None,
) -> dict[str, Any]:
    resp = client.post(
        f"{API}/receptions?store_id={store.id}",
        json={
            "supplier_id": supplier_id,
            "invoice_number": f"FE-{uuid4().hex[:6]}",
            "invoice_date": "2026-01-10",
            "no_invoice": False,
            "received_by_pin": "2222",
            "confirm_price": True,
            "purchase_order_id": order_id,
            "lines": [
                {
                    "ingredient_id": ingredient_id,
                    "qty_received": qty,
                    "qty_invoiced": qty,
                    "purchase_unit_price": price,
                    "tax_base": 0,
                    "tax_rate": 0,
                    "tax_amount": 0,
                }
            ],
        },
        headers=_idem(),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _prices(client: TestClient, store: Store, ingredient_id: int) -> dict[str, Any]:
    resp = client.get(f"{API}/admin/ingredients/{ingredient_id}/supplier-prices?store_id={store.id}")
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_comparison_shows_last_and_weighted_average_and_recommends_the_cheapest_recent(
    admin_client: TestClient,
    clock: Any,
    store: Store,
    create_supplier: Callable[..., Any],
    ingredient_seeded: Any,
) -> None:
    clock.set(datetime(2026, 3, 1, 15, 0, tzinfo=timezone.utc))
    a = create_supplier(name="A", nit="1")
    b = create_supplier(name="B", nit="2")
    # A: 1 kg a 10.000 y 3 kg a 14.000 → promedio ponderado 13.000 por kg.
    _receive(admin_client, store, a["id"], ingredient_seeded.id, "10000", qty="1000")
    _receive(admin_client, store, a["id"], ingredient_seeded.id, "14000", qty="3000")
    # B: último 12.000 → más barato que el último de A (14.000).
    _receive(admin_client, store, b["id"], ingredient_seeded.id, "12000")

    body = _prices(admin_client, store, ingredient_seeded.id)
    assert body["window_days"] == 90
    rows = {r["supplier_name"]: r for r in body["suppliers"]}
    assert rows["A"]["last_purchase_unit_price"] == "14000"
    assert rows["A"]["avg_purchase_unit_price"] == "13000"
    assert rows["A"]["avg_unit_cost"] == "13"
    assert rows["A"]["n_purchases_window"] == 2
    assert body["recommended_supplier_id"] == b["id"]
    assert rows["B"]["recommended"] is True and rows["A"]["recommended"] is False
    assert "último precio más bajo" in body["recommendation_reason"]


def test_a_cheap_but_old_purchase_is_not_recommended(
    admin_client: TestClient,
    clock: Any,
    store: Store,
    create_supplier: Callable[..., Any],
    ingredient_seeded: Any,
) -> None:
    clock.set(datetime(2026, 1, 1, 15, 0, tzinfo=timezone.utc))
    old = create_supplier(name="Viejo", nit="1")
    _receive(admin_client, store, old["id"], ingredient_seeded.id, "5000")
    clock.set(datetime(2026, 6, 1, 15, 0, tzinfo=timezone.utc))
    new = create_supplier(name="Nuevo", nit="2")
    _receive(admin_client, store, new["id"], ingredient_seeded.id, "15000")

    body = _prices(admin_client, store, ingredient_seeded.id)
    rows = {r["supplier_name"]: r for r in body["suppliers"]}
    # Fuera de la ventana: sin promedio (null, no 0) y sin recomendación.
    assert rows["Viejo"]["avg_unit_cost"] is None
    assert rows["Viejo"]["n_purchases_window"] == 0
    assert body["recommended_supplier_id"] == new["id"]
    assert "único proveedor activo" in body["recommendation_reason"]


def test_inactive_supplier_is_never_recommended_and_none_says_why(
    admin_client: TestClient, store: Store, create_supplier: Callable[..., Any], ingredient_seeded: Any
) -> None:
    a = create_supplier()
    _receive(admin_client, store, a["id"], ingredient_seeded.id, "10000")
    admin_client.delete(f"{API}/admin/suppliers/{a['id']}")
    body = _prices(admin_client, store, ingredient_seeded.id)
    assert body["recommended_supplier_id"] is None
    assert body["recommendation_reason"].startswith("Ningún proveedor activo")


def test_lead_time_is_measured_from_purchase_orders(
    admin_client: TestClient,
    db: Session,
    clock: Any,
    store: Store,
    create_supplier: Callable[..., Any],
    ingredient_seeded: Any,
) -> None:
    clock.set(datetime(2026, 3, 2, 15, 0, tzinfo=timezone.utc))
    a = create_supplier(name="Con órdenes", nit="1")
    b = create_supplier(name="Sin órdenes", nit="2")
    order = admin_client.post(
        f"{API}/admin/purchase-orders?store_id={store.id}",
        json={"supplier_id": a["id"], "lines": [{"ingredient_id": ingredient_seeded.id, "quantity": "1"}]},
        headers=_idem(),
    ).json()
    admin_client.post(f"{API}/admin/purchase-orders/{order['id']}/send", headers=_idem())
    clock.set(datetime(2026, 3, 5, 15, 0, tzinfo=timezone.utc))
    _receive(admin_client, store, a["id"], ingredient_seeded.id, "14000", order_id=order["id"])
    _receive(admin_client, store, b["id"], ingredient_seeded.id, "14000")

    rows = {r["supplier_name"]: r for r in _prices(admin_client, store, ingredient_seeded.id)["suppliers"]}
    assert rows["Con órdenes"]["lead_time_days"] == 3
    assert rows["Con órdenes"]["lead_time_source"] == "orders"
    # Sin órdenes y sin ser el proveedor asignado: null con motivo.
    assert rows["Sin órdenes"]["lead_time_days"] is None
    assert rows["Sin órdenes"]["lead_time_reason"]

    # Siendo el proveedor asignado del insumo, vale el lead time del insumo.
    ingredient_seeded.supplier_id = b["id"]
    db.commit()
    rows = {r["supplier_name"]: r for r in _prices(admin_client, store, ingredient_seeded.id)["suppliers"]}
    assert rows["Sin órdenes"]["lead_time_days"] == 2
    assert rows["Sin órdenes"]["lead_time_source"] == "ingredient"
