"""Tanda 5, i3: órdenes de compra.

Borrador (a mano o desde la reposición sugerida) → enviada → recibida en
parte → recibida, o cancelada con motivo. Una recepción que nombra la orden
cierra las líneas que cubre; si se revierte, las reabre."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit.models import AuditLog
from app.core import clock as clock_module
from app.inventory.models import BaseUnit, Ingredient
from app.purchases.models import PurchaseOrderLine
from app.stores.models import Store

API = "/api/v1"


def _idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


def _second_ingredient(db: Session, store: Store, *, supplier_id: int | None = None) -> Ingredient:
    now = clock_module.now_utc()
    row = Ingredient(
        organization_id=store.organization_id,
        store_id=store.id,
        name="Arroz",
        category="Granos",
        base_unit=BaseUnit.G,
        purchase_unit="bulto",
        purchase_factor=25_000,
        yield_pct=100,
        official_cost_micros=4_000_000,
        estimated_cost_micros=None,
        min_stock=10_000,
        lead_time_days=3,
        perishable=False,
        key_item=False,
        active=True,
        consumption_untracked=False,
        substitute_ingredient_id=None,
        supplier_id=supplier_id,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.commit()
    return row


def _create_order(client: TestClient, store: Store, supplier_id: int, lines: list[dict[str, Any]], **extra: Any) -> Any:
    return client.post(
        f"{API}/admin/purchase-orders?store_id={store.id}",
        json={"supplier_id": supplier_id, "lines": lines, **extra},
        headers=_idem(),
    )


def _receive(client: TestClient, store: Store, supplier_id: int, ingredient_ids: list[int], *, order_id: int | None) -> Any:
    return client.post(
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
                    "ingredient_id": iid,
                    "qty_received": "1000",
                    "qty_invoiced": "1000",
                    "purchase_unit_price": "14500",
                    "tax_base": 0,
                    "tax_rate": 0,
                    "tax_amount": 0,
                }
                for iid in ingredient_ids
            ],
        },
        headers=_idem(),
    )


def test_manual_order_lifecycle_with_partial_and_full_reception(
    admin_client: TestClient,
    db: Session,
    store: Store,
    create_supplier: Callable[..., Any],
    ingredient_seeded: Any,
) -> None:
    supplier = create_supplier()
    rice = _second_ingredient(db, store)
    resp = _create_order(
        admin_client,
        store,
        supplier["id"],
        [
            {"ingredient_id": ingredient_seeded.id, "quantity": "3", "expected_unit_price": "14500"},
            {"ingredient_id": rice.id, "quantity": "2", "expected_unit_price": "90000"},
        ],
        notes="Entregar antes de las 10",
    )
    assert resp.status_code == 201, resp.text
    order = resp.json()
    assert order["status"] == "draft"
    assert order["number"] == 1
    assert order["source"] == "manual"
    assert order["supplier_name"] == supplier["name"]
    # 3 kg × 14.500 + 2 bultos × 90.000.
    assert order["expected_total"] == 223_500
    assert [ln["quantity"] for ln in order["lines"]] == ["3", "2"]
    assert order["lines"][0]["qty_base"] == "3000"
    assert order["lines"][1]["purchase_unit"] == "bulto"

    sent = admin_client.post(f"{API}/admin/purchase-orders/{order['id']}/send", headers=_idem())
    assert sent.status_code == 200, sent.text
    assert sent.json()["status"] == "sent"
    assert sent.json()["sent_by_employee_name"] == "Admin"

    # Llega sólo el pollo: la orden queda recibida en parte.
    rec = _receive(admin_client, store, supplier["id"], [ingredient_seeded.id], order_id=order["id"])
    assert rec.status_code == 201, rec.text
    assert rec.json()["purchase_order_id"] == order["id"]
    partial = admin_client.get(f"{API}/admin/purchase-orders/{order['id']}").json()
    assert partial["status"] == "partially_received"
    pollo, arroz = partial["lines"]
    assert pollo["closed"] is True and pollo["closed_reception_id"] == rec.json()["id"]
    assert pollo["received_quantity"] == "1"  # pedido 3 kg, llegó 1: la diferencia queda a la vista
    assert arroz["closed"] is False
    assert partial["reception_ids"] == [rec.json()["id"]]

    # Llega el arroz: recibida.
    rec2 = _receive(admin_client, store, supplier["id"], [rice.id], order_id=order["id"])
    assert rec2.status_code == 201, rec2.text
    done = admin_client.get(f"{API}/admin/purchase-orders/{order['id']}").json()
    assert done["status"] == "received"

    # Una orden recibida ya no espera mercancía ni se cancela.
    again = _receive(admin_client, store, supplier["id"], [rice.id], order_id=order["id"])
    assert again.status_code == 409
    assert again.json()["error"]["code"] == "PURCHASE_ORDER_CLOSED"
    cancel = admin_client.post(
        f"{API}/admin/purchase-orders/{order['id']}/cancel", json={"reason": "ya llegó"}, headers=_idem()
    )
    assert cancel.status_code == 409


def test_reversing_the_reception_reopens_the_lines(
    admin_client: TestClient, store: Store, create_supplier: Callable[..., Any], ingredient_seeded: Any
) -> None:
    supplier = create_supplier()
    order = _create_order(admin_client, store, supplier["id"], [{"ingredient_id": ingredient_seeded.id, "quantity": "1"}]).json()
    admin_client.post(f"{API}/admin/purchase-orders/{order['id']}/send", headers=_idem())
    rec = _receive(admin_client, store, supplier["id"], [ingredient_seeded.id], order_id=order["id"]).json()
    assert admin_client.get(f"{API}/admin/purchase-orders/{order['id']}").json()["status"] == "received"

    rev = admin_client.request("DELETE", f"{API}/admin/receptions/{rec['id']}", json={"authorizer_pin": "9999"})
    assert rev.status_code == 200, rev.text
    back = admin_client.get(f"{API}/admin/purchase-orders/{order['id']}").json()
    assert back["status"] == "sent"
    assert back["lines"][0]["closed"] is False
    assert back["lines"][0]["received_quantity"] == "0"
    assert back["reception_ids"] == []


def test_reception_must_match_the_order_supplier(
    admin_client: TestClient, store: Store, create_supplier: Callable[..., Any], ingredient_seeded: Any
) -> None:
    a = create_supplier(name="A", nit="1")
    b = create_supplier(name="B", nit="2")
    order = _create_order(admin_client, store, a["id"], [{"ingredient_id": ingredient_seeded.id, "quantity": "1"}]).json()
    resp = _receive(admin_client, store, b["id"], [ingredient_seeded.id], order_id=order["id"])
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "PURCHASE_ORDER_SUPPLIER_MISMATCH"


def test_draft_is_editable_without_deleting_lines_and_sent_is_not(
    admin_client: TestClient,
    db: Session,
    store: Store,
    create_supplier: Callable[..., Any],
    ingredient_seeded: Any,
) -> None:
    supplier = create_supplier()
    rice = _second_ingredient(db, store)
    order = _create_order(
        admin_client,
        store,
        supplier["id"],
        [{"ingredient_id": ingredient_seeded.id, "quantity": "1"}, {"ingredient_id": rice.id, "quantity": "1"}],
    ).json()
    edited = admin_client.put(
        f"{API}/admin/purchase-orders/{order['id']}",
        json={"supplier_id": supplier["id"], "lines": [{"ingredient_id": rice.id, "quantity": "4"}]},
        headers=_idem(),
    )
    assert edited.status_code == 200, edited.text
    assert [(ln["ingredient_id"], ln["quantity"]) for ln in edited.json()["lines"]] == [(rice.id, "4")]
    # La línea que salió sigue en la base, marcada: nada se borra.
    rows = db.execute(select(PurchaseOrderLine).where(PurchaseOrderLine.order_id == order["id"])).scalars().all()
    assert len(rows) == 2
    assert sum(1 for r in rows if r.removed_at is not None) == 1
    # Una expected_total sin precios es null con motivo, nunca 0.
    assert edited.json()["expected_total"] is None
    assert "precio esperado" in edited.json()["expected_total_reason"]

    admin_client.post(f"{API}/admin/purchase-orders/{order['id']}/send", headers=_idem())
    locked = admin_client.put(
        f"{API}/admin/purchase-orders/{order['id']}",
        json={"supplier_id": supplier["id"], "lines": [{"ingredient_id": rice.id, "quantity": "5"}]},
        headers=_idem(),
    )
    assert locked.status_code == 409
    assert locked.json()["error"]["code"] == "PURCHASE_ORDER_NOT_DRAFT"


def test_cancel_requires_reason_and_is_audited(
    admin_client: TestClient,
    db: Session,
    store: Store,
    create_supplier: Callable[..., Any],
    ingredient_seeded: Any,
) -> None:
    supplier = create_supplier()
    order = _create_order(admin_client, store, supplier["id"], [{"ingredient_id": ingredient_seeded.id, "quantity": "1"}]).json()
    empty = admin_client.post(f"{API}/admin/purchase-orders/{order['id']}/cancel", json={"reason": "  "}, headers=_idem())
    assert empty.status_code == 400
    resp = admin_client.post(
        f"{API}/admin/purchase-orders/{order['id']}/cancel", json={"reason": "El proveedor no tiene"}, headers=_idem()
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "cancelled"
    assert resp.json()["cancel_reason"] == "El proveedor no tiene"
    audit = db.execute(
        select(AuditLog).where(AuditLog.entity == "purchase_order", AuditLog.action == "cancel")
    ).scalars().all()
    assert len(audit) == 1


def test_numbers_are_consecutive_per_store_and_create_is_idempotent(
    admin_client: TestClient, store: Store, create_supplier: Callable[..., Any], ingredient_seeded: Any
) -> None:
    supplier = create_supplier()
    key = {"Idempotency-Key": str(uuid4())}
    body = {"supplier_id": supplier["id"], "lines": [{"ingredient_id": ingredient_seeded.id, "quantity": "1"}]}
    first = admin_client.post(f"{API}/admin/purchase-orders?store_id={store.id}", json=body, headers=key)
    replay = admin_client.post(f"{API}/admin/purchase-orders?store_id={store.id}", json=body, headers=key)
    assert first.json()["id"] == replay.json()["id"]
    second = _create_order(admin_client, store, supplier["id"], [{"ingredient_id": ingredient_seeded.id, "quantity": "2"}])
    assert second.json()["number"] == 2
    listed = admin_client.get(f"{API}/admin/purchase-orders?store_id={store.id}").json()
    assert [o["number"] for o in listed] == [2, 1]


def test_from_replenishment_rounds_up_to_whole_purchase_units(
    admin_client: TestClient,
    db: Session,
    store: Store,
    set_feature: Callable[..., None],
    create_supplier: Callable[..., Any],
    ingredient_seeded: Any,
) -> None:
    supplier = create_supplier()
    ingredient_seeded.supplier_id = supplier["id"]
    db.commit()
    url = f"{API}/admin/purchase-orders/from-replenishment?store_id={store.id}"

    set_feature("inventory.replenishment", False)
    off = admin_client.post(url, json={"supplier_id": supplier["id"]}, headers=_idem())
    assert off.status_code == 400
    assert off.json()["error"]["code"] == "FEATURE_DISABLED"

    set_feature("inventory.replenishment", True)
    resp = admin_client.post(url, json={"supplier_id": supplier["id"]}, headers=_idem())
    assert resp.status_code == 201, resp.text
    order = resp.json()
    assert order["source"] == "replenishment"
    assert order["status"] == "draft"
    # Sin stock y mínimo de 5 g: la reposición sugiere 5 g → 1 kg entero.
    assert [(ln["ingredient_id"], ln["quantity"]) for ln in order["lines"]] == [(ingredient_seeded.id, "1")]


def test_from_replenishment_with_nothing_to_order_says_what_to_do(
    admin_client: TestClient,
    store: Store,
    set_feature: Callable[..., None],
    create_supplier: Callable[..., Any],
    ingredient_seeded: Any,
) -> None:
    supplier = create_supplier()
    set_feature("inventory.replenishment", True)
    resp = admin_client.post(
        f"{API}/admin/purchase-orders/from-replenishment?store_id={store.id}",
        json={"supplier_id": supplier["id"]},
        headers=_idem(),
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "NOTHING_TO_ORDER"
    assert "Inventario › Insumos" in resp.json()["error"]["message"]


def test_orders_are_admin_only_behind_purchases_and_scoped_by_org(
    admin_client: TestClient,
    device_client: TestClient,
    store: Store,
    store_b: Store,
    set_feature: Callable[..., None],
    create_supplier: Callable[..., Any],
    ingredient_seeded: Any,
) -> None:
    supplier = create_supplier()
    order = _create_order(admin_client, store, supplier["id"], [{"ingredient_id": ingredient_seeded.id, "quantity": "1"}]).json()
    assert device_client.get(f"{API}/admin/purchase-orders/{order['id']}").status_code in (401, 403)
    assert admin_client.get(f"{API}/admin/purchase-orders?store_id={store_b.id}").status_code == 404
    set_feature("purchases", False)
    resp = admin_client.get(f"{API}/admin/purchase-orders?store_id={store.id}")
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"


def test_send_records_the_business_date(
    admin_client: TestClient,
    db: Session,
    clock: Any,
    store: Store,
    create_supplier: Callable[..., Any],
    ingredient_seeded: Any,
) -> None:
    from app.purchases.models import PurchaseOrder

    supplier = create_supplier()
    order = _create_order(admin_client, store, supplier["id"], [{"ingredient_id": ingredient_seeded.id, "quantity": "1"}]).json()
    clock.set(datetime(2026, 1, 15, 3, 0, tzinfo=timezone.utc))  # 22:00 del 14 en Bogotá
    admin_client.post(f"{API}/admin/purchase-orders/{order['id']}/send", headers=_idem())
    db.expire_all()
    row = db.get(PurchaseOrder, order["id"])
    assert row is not None
    assert row.sent_business_date is not None
    assert row.sent_business_date.isoformat() == "2026-01-14"
