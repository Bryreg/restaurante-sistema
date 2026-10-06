"""Tanda 5, i4: devoluciones al proveedor y notas crédito.

Una línea de recepción se devuelve con motivo y PIN: saca stock del lote de
la línea, baja la cuenta por pagar (o, si ya estaba pagada, deja saldo a
favor) y queda en la auditoría. Las lecturas del libro y de la auditoría van
directo a las tablas (excepción declarada en el conftest: lecturas)."""

from __future__ import annotations

from typing import Any, Callable
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit.models import AuditLog
from app.inventory import hooks as inventory_hooks
from app.inventory.models import StockBatch, StockMovement
from app.stores.models import Store

API = "/api/v1"


def _idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


def _receive(
    client: TestClient,
    store: Store,
    supplier_id: int,
    ingredient_id: int,
    *,
    qty: str = "2000",
    price: str = "14500",
    tax_base: int = 0,
    tax_rate: int = 0,
    tax_amount: int = 0,
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
            "lines": [
                {
                    "ingredient_id": ingredient_id,
                    "qty_received": qty,
                    "qty_invoiced": qty,
                    "purchase_unit_price": price,
                    "tax_base": tax_base,
                    "tax_rate": tax_rate,
                    "tax_amount": tax_amount,
                    "lot_code": "L-1",
                }
            ],
        },
        headers=_idem(),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _return(client: TestClient, reception: dict[str, Any], qty: str, *, reason: str = "Llegó dañado", pin: str = "9999") -> Any:
    return client.post(
        f"{API}/admin/receptions/{reception['id']}/returns",
        json={"reception_line_id": reception["lines"][0]["id"], "qty": qty, "reason": reason, "authorizer_pin": pin},
        headers=_idem(),
    )


def _payable(client: TestClient, payable_id: int) -> dict[str, Any]:
    resp = client.get(f"{API}/admin/payables/{payable_id}")
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_partial_return_moves_stock_from_the_line_lot_and_lowers_the_payable(
    admin_client: TestClient,
    db: Session,
    store: Store,
    create_supplier: Callable[..., Any],
    ingredient_seeded: Any,
) -> None:
    supplier = create_supplier()
    rec = _receive(admin_client, store, supplier["id"], ingredient_seeded.id)  # 2 kg a 14.500 = 29.000
    assert _payable(admin_client, rec["payable_id"])["balance"] == 29_000
    stock_before = inventory_hooks.current_stock(db, store_id=store.id, ingredient_id=ingredient_seeded.id)

    resp = _return(admin_client, rec, "500")
    assert resp.status_code == 201, resp.text
    body = resp.json()
    # 500 g × $14,5/g = $7.250, toda a la cuenta por pagar.
    assert body["amount"] == 7_250
    assert body["applied_to_payable"] == 7_250
    assert body["credit_amount"] == 0
    assert body["reason"] == "Llegó dañado"
    assert body["authorized_by_employee_name"] == "Admin"

    payable = _payable(admin_client, rec["payable_id"])
    assert payable["balance"] == 21_750
    assert payable["returned"] == 7_250
    assert payable["amount"] == 29_000  # el monto original no se toca

    db.expire_all()
    assert inventory_hooks.current_stock(db, store_id=store.id, ingredient_id=ingredient_seeded.id) == stock_before - 500_000
    batch = db.get(StockBatch, rec["lines"][0]["stock_batch_id"])
    assert batch is not None and batch.qty_remaining == 1_500_000
    movement = db.execute(
        select(StockMovement).where(StockMovement.ref_type == "supplier_return", StockMovement.ref_id == body["id"])
    ).scalar_one()
    assert movement.qty_base == -500_000
    assert "Llegó dañado" in (movement.note or "")

    audit = db.execute(select(AuditLog).where(AuditLog.entity == "supplier_return")).scalars().all()
    assert len(audit) == 1
    assert audit[0].reason == "Llegó dañado"

    detail = admin_client.get(f"{API}/admin/receptions/{rec['id']}").json()
    assert detail["lines"][0]["qty_returned"] == "500"
    summary = admin_client.get(f"{API}/admin/payables/summary?store_id={store.id}").json()
    assert summary["total_open"] == 21_750


def test_tax_is_returned_in_proportion(
    admin_client: TestClient, store: Store, create_supplier: Callable[..., Any], ingredient_seeded: Any
) -> None:
    supplier = create_supplier()
    rec = _receive(
        admin_client, store, supplier["id"], ingredient_seeded.id, qty="2000", tax_base=29_000, tax_rate=19, tax_amount=5_510
    )
    body = _return(admin_client, rec, "1000").json()
    # La mitad: 14.500 + 2.755 de impuesto.
    assert body["amount"] == 17_255


def test_return_on_a_paid_payable_becomes_credit(
    admin_client: TestClient, store: Store, create_supplier: Callable[..., Any], ingredient_seeded: Any
) -> None:
    supplier = create_supplier()
    rec = _receive(admin_client, store, supplier["id"], ingredient_seeded.id)
    pid = rec["payable_id"]
    assert admin_client.post(f"{API}/admin/payables/{pid}/approve", json={"authorizer_pin": "9999"}).status_code == 200
    paid = admin_client.post(
        f"{API}/admin/payables/{pid}/payments",
        json={"amount": 25_000, "method": "transfer", "paid_at": "2026-01-12T10:00:00Z", "authorizer_pin": "9999"},
        headers=_idem(),
    )
    assert paid.status_code == 201, paid.text
    body = _return(admin_client, rec, "1000").json()  # $14.500, quedaban $4.000
    assert body["applied_to_payable"] == 4_000
    assert body["credit_amount"] == 10_500
    assert _payable(admin_client, pid)["balance"] == 0
    listed = admin_client.get(f"{API}/admin/supplier-returns?store_id={store.id}&supplier_id={supplier['id']}").json()
    assert [r["credit_amount"] for r in listed] == [10_500]


def test_cannot_return_more_than_received_and_needs_reason_and_pin(
    admin_client: TestClient, store: Store, create_supplier: Callable[..., Any], ingredient_seeded: Any
) -> None:
    supplier = create_supplier()
    rec = _receive(admin_client, store, supplier["id"], ingredient_seeded.id)
    assert _return(admin_client, rec, "1500").status_code == 201
    over = _return(admin_client, rec, "600")
    assert over.status_code == 400
    assert over.json()["error"]["code"] == "RETURN_EXCEEDS_RECEIVED"
    assert _return(admin_client, rec, "100", reason="   ").status_code in (400, 422)
    bad_pin = _return(admin_client, rec, "100", pin="0000")
    assert bad_pin.status_code >= 400


def test_a_reception_with_returns_cannot_be_reversed_whole(
    admin_client: TestClient, store: Store, create_supplier: Callable[..., Any], ingredient_seeded: Any
) -> None:
    supplier = create_supplier()
    rec = _receive(admin_client, store, supplier["id"], ingredient_seeded.id)
    assert _return(admin_client, rec, "100").status_code == 201
    rev = admin_client.request("DELETE", f"{API}/admin/receptions/{rec['id']}", json={"authorizer_pin": "9999"})
    assert rev.status_code == 409
    assert rev.json()["error"]["code"] == "RECEPTION_HAS_RETURNS"


def test_return_is_idempotent(
    admin_client: TestClient, db: Session, store: Store, create_supplier: Callable[..., Any], ingredient_seeded: Any
) -> None:
    supplier = create_supplier()
    rec = _receive(admin_client, store, supplier["id"], ingredient_seeded.id)
    key = _idem()
    body = {"reception_line_id": rec["lines"][0]["id"], "qty": "200", "reason": "Vencido", "authorizer_pin": "9999"}
    first = admin_client.post(f"{API}/admin/receptions/{rec['id']}/returns", json=body, headers=key)
    again = admin_client.post(f"{API}/admin/receptions/{rec['id']}/returns", json=body, headers=key)
    assert first.status_code == 201 and again.status_code == 201
    assert first.json()["id"] == again.json()["id"]
    assert len(admin_client.get(f"{API}/admin/supplier-returns?store_id={store.id}").json()) == 1


def test_returns_are_admin_only_and_behind_purchases(
    admin_client: TestClient,
    device_client: TestClient,
    store: Store,
    set_feature: Callable[..., None],
    create_supplier: Callable[..., Any],
    ingredient_seeded: Any,
) -> None:
    supplier = create_supplier()
    rec = _receive(admin_client, store, supplier["id"], ingredient_seeded.id)
    assert _return(device_client, rec, "100").status_code in (401, 403)
    set_feature("purchases", False)
    off = _return(admin_client, rec, "100")
    assert off.status_code == 400
    assert off.json()["error"]["code"] == "FEATURE_DISABLED"
