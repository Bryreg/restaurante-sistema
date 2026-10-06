"""Tanda 5, i1: historial de precios por proveedor y aviso de subida.

`GET /admin/ingredients/{id}/supplier-prices` deriva todo de las recepciones
confirmadas; al confirmar una recepción cuyo precio subió más que el umbral
(regla `supplier_price_rise`, 10 % por defecto) contra la compra anterior al
mismo proveedor, sale un aviso por `app.notifications` con `dedupe`."""

from __future__ import annotations

from typing import Any, Callable
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.notifications.models import Notification, NotificationRule
from app.stores.models import Store


def _receive(
    client: TestClient,
    store: Store,
    supplier_id: int,
    ingredient_id: int,
    price: str,
    *,
    confirm_price: bool = True,
    qty: str = "1000",
) -> dict[str, Any]:
    resp = client.post(
        f"/api/v1/receptions?store_id={store.id}",
        json={
            "supplier_id": supplier_id,
            "invoice_number": f"FE-{uuid4().hex[:6]}",
            "invoice_date": "2026-01-10",
            "no_invoice": False,
            "received_by_pin": "2222",
            "confirm_price": confirm_price,
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
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _rises(db: Session, store: Store) -> list[Notification]:
    return list(
        db.execute(
            select(Notification).where(Notification.store_id == store.id, Notification.type == "supplier_price_rise")
        ).scalars()
    )


def test_history_lists_last_prices_per_supplier_with_change(
    admin_client: TestClient, store: Store, create_supplier: Callable[..., Any], ingredient_seeded: Any
) -> None:
    a = create_supplier(name="Avícola A", nit="900-1")
    b = create_supplier(name="Avícola B", nit="900-2")
    _receive(admin_client, store, a["id"], ingredient_seeded.id, "14000")
    _receive(admin_client, store, a["id"], ingredient_seeded.id, "15000")
    _receive(admin_client, store, b["id"], ingredient_seeded.id, "13000")

    resp = admin_client.get(f"/api/v1/admin/ingredients/{ingredient_seeded.id}/supplier-prices?store_id={store.id}")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["purchase_unit"] == "kg"
    assert body["alert_threshold_pct"] == 10
    # El proveedor de la compra más reciente primero.
    assert [s["supplier_name"] for s in body["suppliers"]] == ["Avícola B", "Avícola A"]
    rows_a = body["suppliers"][1]["purchases"]
    assert [p["purchase_unit_price"] for p in rows_a] == ["15000", "14000"]
    assert rows_a[0]["unit_cost"] == "15"
    # 15000 vs 14000: +7,14 % → 714 bp, con signo; la primera no tiene contra qué.
    assert rows_a[0]["change_bp"] == 714
    assert rows_a[1]["change_bp"] is None


def test_reversed_receptions_are_not_purchases(
    admin_client: TestClient, store: Store, create_supplier: Callable[..., Any], ingredient_seeded: Any
) -> None:
    a = create_supplier()
    rec = _receive(admin_client, store, a["id"], ingredient_seeded.id, "14000")
    resp = admin_client.request(
        "DELETE", f"/api/v1/admin/receptions/{rec['id']}", json={"authorizer_pin": "9999"}
    )
    assert resp.status_code == 200, resp.text
    body = admin_client.get(
        f"/api/v1/admin/ingredients/{ingredient_seeded.id}/supplier-prices?store_id={store.id}"
    ).json()
    assert body["suppliers"] == []


def test_price_rise_over_threshold_notifies_once_per_day(
    admin_client: TestClient,
    db: Session,
    store: Store,
    create_supplier: Callable[..., Any],
    ingredient_seeded: Any,
) -> None:
    a = create_supplier()
    _receive(admin_client, store, a["id"], ingredient_seeded.id, "10000")
    # +5 %: bajo el umbral, no avisa.
    _receive(admin_client, store, a["id"], ingredient_seeded.id, "10500")
    assert _rises(db, store) == []
    # +14,3 % sobre la anterior (10.500 → 12.000): avisa.
    _receive(admin_client, store, a["id"], ingredient_seeded.id, "12000")
    rows = _rises(db, store)
    assert len(rows) == 1
    assert "subió «Pechuga de pollo»" in rows[0].body
    assert rows[0].payload["supplier_id"] == a["id"]
    assert rows[0].dedupe_key == f"supplier_price_rise:{a['id']}:{ingredient_seeded.id}"
    # Otra subida el mismo día, mismo proveedor e insumo: el dedupe la frena.
    _receive(admin_client, store, a["id"], ingredient_seeded.id, "14000")
    assert len(_rises(db, store)) == 1


def test_rise_is_measured_against_the_same_supplier(
    admin_client: TestClient,
    db: Session,
    store: Store,
    create_supplier: Callable[..., Any],
    ingredient_seeded: Any,
) -> None:
    a = create_supplier(name="Barato", nit="1")
    b = create_supplier(name="Caro", nit="2")
    _receive(admin_client, store, a["id"], ingredient_seeded.id, "10000")
    # Primera compra a B: no hay anterior de B, aunque cueste 30 % más que A.
    _receive(admin_client, store, b["id"], ingredient_seeded.id, "13000")
    assert _rises(db, store) == []


def test_threshold_is_configurable_per_store(
    admin_client: TestClient,
    db: Session,
    store: Store,
    create_supplier: Callable[..., Any],
    ingredient_seeded: Any,
) -> None:
    db.add(
        NotificationRule(
            organization_id=store.organization_id,
            store_id=store.id,
            type="supplier_price_rise",
            enabled=True,
            level="warning",
            threshold=3,
        )
    )
    db.commit()
    a = create_supplier()
    _receive(admin_client, store, a["id"], ingredient_seeded.id, "10000")
    _receive(admin_client, store, a["id"], ingredient_seeded.id, "10500")
    assert len(_rises(db, store)) == 1


def test_price_history_is_admin_only_and_behind_purchases(
    admin_client: TestClient,
    device_client: TestClient,
    store: Store,
    set_feature: Callable[..., None],
    create_supplier: Callable[..., Any],
    ingredient_seeded: Any,
) -> None:
    create_supplier()
    url = f"/api/v1/admin/ingredients/{ingredient_seeded.id}/supplier-prices?store_id={store.id}"
    assert device_client.get(url).status_code in (401, 403)
    set_feature("purchases", False)
    resp = admin_client.get(url)
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
