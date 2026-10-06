"""u6: recibir la mercancía cierra el pedido de insumos que la originó.

`POST /receptions` y `POST /admin/reception-drafts/{id}/complete` aceptan
`supply_request_ids`: los pedidos aprobados y por comprar que la recepción
cubre. Se validan antes de escribir (un pedido ya cerrado no deja la
recepción a medias) y se marcan `bought` en la misma transacción."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.stores.models import Store

API = "/api/v1"


def _idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


def _reception_payload(supplier_id: int, ingredient_id: int, **overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "supplier_id": supplier_id,
        "invoice_number": "FE-001",
        "invoice_date": "2026-01-10",
        "no_invoice": False,
        "received_by_pin": "2222",
        "lines": [
            {
                "ingredient_id": ingredient_id,
                "qty_received": "2000",
                "qty_invoiced": "2000",
                "purchase_unit_price": "14500",
                "tax_base": 0,
                "tax_rate": 0,
                "tax_amount": 0,
            }
        ],
    }
    payload.update(overrides)
    return payload


@pytest.fixture()
def approved_request(
    device_client: TestClient, open_shift: Any, admin_client: TestClient, ingredient_seeded: Any, set_feature: Any
) -> Any:
    """Crea pedidos de insumos desde la tablet y los aprueba el admin."""
    set_feature("inventory.perpetual", True)
    open_shift()

    def _make(*, approve: bool = True) -> int:
        created = device_client.post(
            f"{API}/requests/supplies",
            json={"lines": [{"ingredient_id": ingredient_seeded.id, "qty": "2", "entry_unit": "kg"}]},
            headers=_idem(),
        )
        assert created.status_code == 201, created.text
        request_id = int(created.json()["id"])
        if approve:
            resp = admin_client.post(f"{API}/admin/requests/{request_id}/approve", json={}, headers=_idem())
            assert resp.status_code == 200, resp.text
        return request_id

    return _make


def _status(admin_client: TestClient, store: Store, request_id: int) -> str:
    rows = admin_client.get(f"{API}/admin/requests?store_id={store.id}").json()
    return str(next(r for r in rows if r["id"] == request_id)["status"])


def test_reception_marks_the_covered_supply_requests_bought(
    admin_client: TestClient, store: Store, create_supplier: Any, ingredient_seeded: Any, approved_request: Any
) -> None:
    first = approved_request()
    second = approved_request()
    untouched = approved_request()
    supplier = create_supplier()

    resp = admin_client.post(
        f"{API}/receptions?store_id={store.id}",
        json=_reception_payload(supplier["id"], ingredient_seeded.id, supply_request_ids=[first, second, first]),
        headers=_idem(),
    )
    assert resp.status_code == 201, resp.text

    assert _status(admin_client, store, first) == "bought"
    assert _status(admin_client, store, second) == "bought"
    assert _status(admin_client, store, untouched) == "approved"
    # Lo que queda «por comprar» en Compras ya no lo incluye.
    open_ids = [r["id"] for r in admin_client.get(f"{API}/admin/requests/supplies?store_id={store.id}").json()]
    assert open_ids == [untouched]


def test_without_supply_request_ids_nothing_is_closed(
    admin_client: TestClient, store: Store, create_supplier: Any, ingredient_seeded: Any, approved_request: Any
) -> None:
    request_id = approved_request()
    supplier = create_supplier()
    resp = admin_client.post(
        f"{API}/receptions?store_id={store.id}",
        json=_reception_payload(supplier["id"], ingredient_seeded.id),
        headers=_idem(),
    )
    assert resp.status_code == 201, resp.text
    assert _status(admin_client, store, request_id) == "approved"


def test_a_request_not_open_rejects_the_whole_reception_before_writing(
    admin_client: TestClient,
    store: Store,
    create_supplier: Any,
    ingredient_seeded: Any,
    approved_request: Any,
    db: Session,
) -> None:
    from app.inventory.models import StockMovement
    from app.purchases.models import Reception

    approved = approved_request()
    pending = approved_request(approve=False)
    supplier = create_supplier()

    resp = admin_client.post(
        f"{API}/receptions?store_id={store.id}",
        json=_reception_payload(supplier["id"], ingredient_seeded.id, supply_request_ids=[approved, pending]),
        headers=_idem(),
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "SUPPLY_REQUEST_NOT_OPEN"

    db.expire_all()
    assert db.execute(select(func.count()).select_from(Reception)).scalar_one() == 0
    assert db.execute(select(func.count()).select_from(StockMovement)).scalar_one() == 0
    assert _status(admin_client, store, approved) == "approved"

    unknown = admin_client.post(
        f"{API}/receptions?store_id={store.id}",
        json=_reception_payload(supplier["id"], ingredient_seeded.id, supply_request_ids=[999_999]),
        headers=_idem(),
    )
    assert unknown.status_code == 404, unknown.text


def test_with_requests_off_supply_request_ids_is_feature_disabled(
    admin_client: TestClient, store: Store, create_supplier: Any, ingredient_seeded: Any, approved_request: Any, set_feature: Any
) -> None:
    request_id = approved_request()
    set_feature("pos.requests", False)
    supplier = create_supplier()
    resp = admin_client.post(
        f"{API}/receptions?store_id={store.id}",
        json=_reception_payload(supplier["id"], ingredient_seeded.id, supply_request_ids=[request_id]),
        headers=_idem(),
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"


def test_completing_a_pos_draft_also_closes_the_requests(
    device_client: TestClient,
    admin_client: TestClient,
    store: Store,
    create_supplier: Any,
    ingredient_seeded: Any,
    approved_request: Any,
) -> None:
    request_id = approved_request()
    supplier = create_supplier()
    draft = device_client.post(
        f"{API}/reception-drafts",
        json={
            "supplier_id": supplier["id"],
            "invoice_number": "FE-500",
            "no_invoice": False,
            "photo": "data:image/png;base64,iVBORw0KGgo=",
            "lines": [{"ingredient_id": ingredient_seeded.id, "quantity": "2"}],
        },
        headers=_idem(),
    )
    assert draft.status_code == 201, draft.text

    payload = _reception_payload(supplier["id"], ingredient_seeded.id, supply_request_ids=[request_id])
    payload.pop("received_by_pin")
    resp = admin_client.post(
        f"{API}/admin/reception-drafts/{draft.json()['id']}/complete", json=payload, headers=_idem()
    )
    assert resp.status_code == 201, resp.text
    assert _status(admin_client, store, request_id) == "bought"
