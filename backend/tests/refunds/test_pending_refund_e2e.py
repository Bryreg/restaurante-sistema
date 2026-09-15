"""Dueño de este test: `backend-clientes-dinero` (territorio
`app/refunds/**`), como pide la misión: "Vos sos el dueño del test de punta a
punta de este gancho: nota sin turno abierto → devolución pendiente →
`settle` desde un turno → el egreso aparece en el turno que la salda y el
turno original queda intacto." Es un ítem literal del checklist de entrega
de `features/fase-1b-venta/spec.md`.

**Dos pruebas acá:**

1. `test_note_without_open_shift_creates_a_pending_refund_and_settle_pays_it_from_another_shift`
   corre siempre: reproduce el circuito completo de plata (turno cerrado →
   `settle_or_queue_refund` en el momento en que se emitiría la nota → turno
   nuevo → `settle`) llamando el gancho DIRECTO. Es la prueba real y
   principal del invariante de plata, y no depende de que
   `POST /admin/documents/{id}/notes` exista o de que haya un `FiscalRange`
   cargado.
2. `test_the_notes_endpoint_calls_the_hook_end_to_end` pasa por la ruta HTTP
   real de la nota (`app.fiscal.router`, territorio de `backend-fiscal`,
   que apareció en el árbol mientras se escribía este test — el `skipif`
   queda como red de seguridad si algún día ese router se saca del build).
   Arma sus propios `FiscalRange` (`pos_equivalent` y `adjustment_note`: una
   nota "adjustment" sólo corrige un `pos_equivalent`, y ambos reservan
   número DENTRO de un rango vigente) y usa `used: true` en la línea de la
   nota tal como lo exige `app.fiscal.service.issue_note` (selecciona la
   línea para la nota; no es "se usó/vuelve" del inventario, que es fase 2).
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.deps import Actor
from app.auth.models import Employee
from app.core import clock as clock_module
from app.core.modules import find_spec_safe
from app.refunds.hooks import settle_or_queue_refund
from app.refunds.models import PendingRefund, PendingRefundStatus
from app.shifts.models import CashMovement, CashMovementCause, Shift, ShiftStatus
from app.stores.models import Organization, Store


def test_note_without_open_shift_creates_a_pending_refund_and_settle_pays_it_from_another_shift(
    admin_client: TestClient,
    db: Session,
    org: Organization,
    store: Store,
    employees: dict[str, Employee],
    paid_order: Any,
    open_shift: Any,
) -> None:
    # 1. Una venta real, cobrada en efectivo con un turno abierto (necesario
    #    para poder cobrar en absoluto), que después se "nota-ría" (nota de
    #    ajuste, territorio de `backend-fiscal`).
    payment = paid_order()
    document_id = payment["document"]["id"]
    original_shift = db.execute(select(Shift).where(Shift.store_id == store.id)).scalars().one()
    original_shift_id = original_shift.id

    # 2. El turno cierra (o ya estaba cerrado) para cuando alguien emite la
    #    nota de devolución: no hay ningún turno abierto en la sede.
    original_shift.status = ShiftStatus.CLOSED
    db.commit()
    assert db.execute(select(Shift).where(Shift.store_id == store.id, Shift.status == ShiftStatus.OPEN)).scalars().first() is None

    admin = employees["admin"]
    actor = Actor(
        kind="admin", organization_id=org.id, store_id=None, employee_id=admin.id, employee_name=admin.name, role="admin"
    )

    outcome = settle_or_queue_refund(
        db,
        organization_id=org.id,
        store_id=store.id,
        document_id=document_id,
        method="cash",
        amount=5000,
        actor=actor,
        now=clock_module.now_utc(),
    )
    assert outcome.status == "pending"
    pending = db.get(PendingRefund, outcome.pending_refund_id)
    assert pending is not None
    assert pending.status == PendingRefundStatus.PENDING

    # 3. Abre un turno NUEVO y salda la devolución desde ahí.
    new_shift = open_shift()
    assert new_shift["id"] != original_shift_id

    resp = admin_client.post(
        f"/api/v1/admin/pending-refunds/{pending.id}/settle",
        json={"from": "shift", "shift_id": new_shift["id"]},
        headers={"Idempotency-Key": str(uuid.uuid4())},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "settled"
    assert body["settled_shift_id"] == new_shift["id"]

    # 4. El egreso aparece en el turno que la salda...
    new_movements = list(db.execute(select(CashMovement).where(CashMovement.shift_id == new_shift["id"])).scalars())
    assert len(new_movements) == 1
    assert new_movements[0].cause == CashMovementCause.REFUND
    assert new_movements[0].amount == 5000

    # ...y el turno ORIGINAL (el de la venta que se devolvió) queda intacto:
    # ningún movimiento nuevo, ningún cambio de estado más allá del cierre
    # que ya tenía antes de saldar.
    original_movements = list(db.execute(select(CashMovement).where(CashMovement.shift_id == original_shift_id)).scalars())
    assert original_movements == []
    db.refresh(original_shift)
    assert original_shift.status == ShiftStatus.CLOSED


@pytest.mark.skipif(
    find_spec_safe("app.fiscal.router") is None,
    reason="POST /admin/documents/{id}/notes es territorio de backend-fiscal; no existe router.py de app.fiscal todavía (ver gaps del entregable backend-clientes-dinero)",
)
def test_the_notes_endpoint_calls_the_hook_end_to_end(
    admin_client: TestClient,
    device_client: Any,
    db: Session,
    org: Organization,
    store: Store,
    employees: dict[str, Employee],
    identify: Any,
    open_shift: Any,
) -> None:
    # Nota "adjustment" corrige un `pos_equivalent` (territorio de
    # `backend-fiscal`): a diferencia del resto de mis tests (que apagan
    # `fiscal.dee_pos` para no depender de un `FiscalRange`), ACÁ hace
    # falta uno real, tanto para el `pos_equivalent` original como para la
    # `adjustment_note` que lo corrige — ambos DIAN-trazables
    # (`RANGE_BACKED_TYPES`, `app.fiscal.service`).
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
        description=None, station=None, default_course="beverage", price_dine_in=5000, price_takeout=None,
        price_delivery=None, price_platform=None, tax_code="inc_8", active=True, available=True, daily_count=None,
        daily_remaining=None, unavailable_by_employee_id=None, unavailable_by_employee_name=None,
        unavailable_at=None, created_at=now, updated_at=now,
    )
    db.add(product)
    db.commit()

    for document_type in ("pos_equivalent", "adjustment_note"):
        range_resp = admin_client.post(
            "/api/v1/admin/fiscal/ranges",
            json={
                "store_id": store.id,
                "document_type": document_type,
                "prefix": "POS" if document_type == "pos_equivalent" else "AJU",
                "from_number": 1,
                "to_number": 1000,
                "resolution_number": "18760000001",
                "resolution_date": "2026-01-01",
                "valid_from": "2026-01-01",
                "valid_until": "2027-01-01",
            },
        )
        assert range_resp.status_code == 201, range_resp.text

    open_shift(responsible=employees["cashier"])
    identify(device_client, employees["cashier"])
    order = device_client.post("/api/v1/orders", json={"channel": "counter"}, headers={"Idempotency-Key": str(uuid.uuid4())}).json()
    order = device_client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={"expected_version": order["version"], "items": [{"product_id": product.id, "qty": 1}]},
        headers={"Idempotency-Key": str(uuid.uuid4())},
    ).json()
    pay_resp = device_client.post(
        f"/api/v1/orders/{order['id']}/payments",
        json={
            "pin": "1111",
            "tip": {"asked": True, "accepted": False, "modified": False, "amount": 0},
            "splits": [{"method": "cash", "amount": order["totals"]["total"]}],
        },
        headers={"Idempotency-Key": str(uuid.uuid4())},
    )
    assert pay_resp.status_code == 201, pay_resp.text
    payment = pay_resp.json()
    document_id = payment["document"]["id"]
    order_id = payment["order"]["id"]
    item_id = payment["order"]["items"][0]["id"]

    shift = db.execute(select(Shift).where(Shift.store_id == store.id)).scalars().one()
    shift.status = ShiftStatus.CLOSED
    db.commit()

    note_resp = admin_client.post(
        f"/api/v1/admin/documents/{document_id}/notes",
        json={
            "kind": "adjustment",
            "reason": "Producto no entregado",
            "lines": [{"item_id": item_id, "used": True}],
            "refund": {"method": "cash", "amount": 5000},
        },
        headers={"Idempotency-Key": str(uuid.uuid4())},
    )
    assert note_resp.status_code == 201, note_resp.text
    note_body = note_resp.json()
    assert note_body["refund_status"] == "pending"
    note_id = note_body["id"]

    # `app.fiscal.service.settle_or_queue_refund_for_note` (territorio
    # ajeno) llama el gancho con `document_id=note.id` (la NOTA, no la venta
    # original) — la devolución pendiente queda ligada al documento que la
    # autoriza, que es la nota.
    pending = list(db.execute(select(PendingRefund).where(PendingRefund.document_id == note_id)).scalars())
    assert len(pending) == 1
    assert pending[0].status == PendingRefundStatus.PENDING
    assert pending[0].amount == 5000

    new_shift = open_shift()
    settle_resp = admin_client.post(
        f"/api/v1/admin/pending-refunds/{pending[0].id}/settle",
        json={"from": "shift", "shift_id": new_shift["id"]},
        headers={"Idempotency-Key": str(uuid.uuid4())},
    )
    assert settle_resp.status_code == 200, settle_resp.text

    movements = list(db.execute(select(CashMovement).where(CashMovement.shift_id == new_shift["id"])).scalars())
    assert len(movements) == 1
    assert movements[0].cause == CashMovementCause.REFUND
    assert order_id  # referenciado para dejar constancia de la comanda original
