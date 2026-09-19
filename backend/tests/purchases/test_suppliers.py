"""`GET/POST/PATCH/DELETE /admin/suppliers`, `GET /admin/suppliers/{id}
/reliability`."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient

from app.stores.models import Store


def _idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


def test_create_and_list_supplier(admin_client: TestClient, store: Store, create_supplier: Any) -> None:
    supplier = create_supplier(name="Carnes del Valle")
    assert supplier["name"] == "Carnes del Valle"
    assert supplier["active"] is True

    listed = admin_client.get(f"/api/v1/admin/suppliers?store_id={store.id}")
    assert listed.status_code == 200, listed.text
    assert any(s["id"] == supplier["id"] for s in listed.json())


def test_duplicate_nit_is_400(admin_client: TestClient, store: Store, create_supplier: Any) -> None:
    create_supplier(name="Proveedor 1", nit="800111222-3")
    resp = admin_client.post(
        f"/api/v1/admin/suppliers?store_id={store.id}",
        json={
            "name": "Proveedor 2 (mismo NIT)",
            "nit": "800111222-3",
            "payment_term_days": 0,
            "invoices_required": False,
            "active": True,
        },
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "SUPPLIER_DUPLICATE_NIT"


def test_two_suppliers_without_nit_are_allowed(admin_client: TestClient, store: Store, create_supplier: Any) -> None:
    create_supplier(name="Plaza A", nit=None)
    resp = admin_client.post(
        f"/api/v1/admin/suppliers?store_id={store.id}",
        json={"name": "Plaza B", "nit": None, "payment_term_days": 0, "invoices_required": False, "active": True},
    )
    assert resp.status_code == 201, resp.text


def test_update_supplier(admin_client: TestClient, create_supplier: Any) -> None:
    supplier = create_supplier()
    resp = admin_client.patch(f"/api/v1/admin/suppliers/{supplier['id']}", json={"contact_phone": "3009999999"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["contact_phone"] == "3009999999"


def test_delete_is_logical_deactivation(admin_client: TestClient, store: Store, create_supplier: Any) -> None:
    supplier = create_supplier()
    resp = admin_client.delete(f"/api/v1/admin/suppliers/{supplier['id']}")
    assert resp.status_code == 200, resp.text
    assert resp.json()["active"] is False

    listed_active = admin_client.get(f"/api/v1/admin/suppliers?store_id={store.id}&active=true")
    assert all(s["id"] != supplier["id"] for s in listed_active.json())
    listed_all = admin_client.get(f"/api/v1/admin/suppliers?store_id={store.id}")
    assert any(s["id"] == supplier["id"] for s in listed_all.json())


def test_reliability_received_over_invoiced_and_invoice_share(
    admin_client: TestClient, store: Store, create_supplier: Any, ingredient_seeded: Any, clock: Any
) -> None:
    from datetime import datetime, timezone

    # `Reception.business_date` se sella con el instante REAL de la
    # confirmación (`clock.now_utc()`), no con `invoice_date` — hay que fijar
    # el reloj dentro del rango que se va a consultar más abajo.
    clock.set(datetime(2026, 1, 10, 12, 0, tzinfo=timezone.utc))
    supplier = create_supplier(invoices_required=False)

    # Recepción 1: recibido == facturado, con factura.
    payload1 = {
        "supplier_id": supplier["id"],
        "invoice_number": "FE-1",
        "invoice_date": "2026-01-05",
        "no_invoice": False,
        "received_by_pin": "2222",
        "lines": [
            {
                "ingredient_id": ingredient_seeded.id,
                "qty_received": "1000",
                "qty_invoiced": "1000",
                "purchase_unit_price": "14500",
                "tax_base": 0,
                "tax_rate": 0,
                "tax_amount": 0,
                "lot_code": "L-1",
                "expires_at": "2026-06-01",
            }
        ],
    }
    resp1 = admin_client.post(f"/api/v1/receptions?store_id={store.id}", json=payload1, headers=_idem())
    assert resp1.status_code == 201, resp1.text

    # Recepción 2: recibido < facturado (faltante), sin factura.
    payload2 = dict(payload1)
    payload2["no_invoice"] = True
    payload2["invoice_number"] = None
    payload2["lines"] = [
        {
            "ingredient_id": ingredient_seeded.id,
            "qty_received": "800",
            "qty_invoiced": "1000",
            "purchase_unit_price": "14500",
            "tax_base": 0,
            "tax_rate": 0,
            "tax_amount": 0,
            "lot_code": "L-2",
            "expires_at": "2026-06-15",
        }
    ]
    resp2 = admin_client.post(f"/api/v1/receptions?store_id={store.id}", json=payload2, headers=_idem())
    assert resp2.status_code == 201, resp2.text

    reliability = admin_client.get(
        f"/api/v1/admin/suppliers/{supplier['id']}/reliability?from=2026-01-01&to=2026-01-31"
    )
    assert reliability.status_code == 200, reliability.text
    data = reliability.json()
    assert data["receptions"] == 2
    # total recibido 1800 / total facturado 2000 = 90%
    assert data["received_over_invoiced_pct"] == 90
    # una de dos con factura = 50%
    assert data["invoice_share_pct"] == 50


def test_reliability_with_no_receptions_is_all_none(admin_client: TestClient, create_supplier: Any) -> None:
    supplier = create_supplier()
    resp = admin_client.get(f"/api/v1/admin/suppliers/{supplier['id']}/reliability?from=2020-01-01&to=2020-01-31")
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["receptions"] == 0
    assert data["received_over_invoiced_pct"] is None
    assert data["invoice_share_pct"] is None
    assert data["avg_price_drift_pct"] is None
