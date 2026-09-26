"""Recibir mercancía desde el POS: recepción por completar.

Decisión del dueño: captura manual + foto, sin OCR y SIN PRECIOS para el
cajero; el administrador completa los costos por el camino de siempre
(`create_reception`). Se prueba: que el cajero registra sin precios, que la
tablet no recibe ningún costo, que la foto es obligatoria, que completar crea
recepción/lotes/cuenta por pagar sin duplicar el egreso del cajón, que
rechazar deja motivo, y que toda validación corre antes de escribir.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.stores.models import Store

API = "/api/v1"
PHOTO = "data:image/png;base64,iVBORw0KGgo="
MONEY_SECRETS = ("cost", "margin", "price")


def _idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


def _deep_keys(value: Any) -> set[str]:
    found: set[str] = set()
    if isinstance(value, dict):
        for key, sub in value.items():
            found.add(str(key).lower())
            found |= _deep_keys(sub)
    elif isinstance(value, list):
        for sub in value:
            found |= _deep_keys(sub)
    return found


def _assert_no_cost(payload: Any) -> None:
    leaked = {k for k in _deep_keys(payload) if any(s in k for s in MONEY_SECRETS)}
    assert not leaked, f"la tablet recibió campos de costo/precio: {sorted(leaked)}"


def _draft_payload(supplier_id: int, ingredient_id: int, **overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "supplier_id": supplier_id,
        "invoice_number": "FE-500",
        "no_invoice": False,
        "photo": PHOTO,
        "lines": [{"ingredient_id": ingredient_id, "quantity": "2", "lot_code": "L-7", "expires_at": "2026-12-31"}],
    }
    payload.update(overrides)
    return payload


def _complete_payload(supplier_id: int, ingredient_id: int, **overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "supplier_id": supplier_id,
        "invoice_number": "FE-500",
        "invoice_date": "2026-01-15",
        "no_invoice": False,
        "lines": [
            {
                "ingredient_id": ingredient_id,
                "qty_received": "2000",
                "qty_invoiced": "2000",
                "purchase_unit_price": "14500",
                "tax_base": 0,
                "tax_rate": 0,
                "tax_amount": 0,
                "lot_code": "L-7",
                "expires_at": "2026-12-31",
            }
        ],
    }
    payload.update(overrides)
    return payload


def _count(db: Session, model: Any, *where: Any) -> int:
    db.expire_all()
    return int(db.execute(select(func.count()).select_from(model).where(*where)).scalar_one())


@pytest.fixture()
def pos(device_client: TestClient, identify: Any, employees: dict[str, Any]) -> TestClient:
    """La tablet con el cajero identificado."""
    identify(device_client, employees["cashier"])
    return device_client


@pytest.fixture()
def supplier(create_supplier: Any) -> dict[str, Any]:
    return create_supplier()


def _create_draft(pos: TestClient, supplier: dict[str, Any], ingredient_id: int, **overrides: Any) -> dict[str, Any]:
    resp = pos.post(f"{API}/reception-drafts", json=_draft_payload(supplier["id"], ingredient_id, **overrides), headers=_idem())
    assert resp.status_code == 201, resp.text
    return resp.json()


# ---------------------------------------------------------------------------
# El cajero registra.
# ---------------------------------------------------------------------------


def test_the_cashier_registers_without_prices_and_no_stock_moves(
    pos: TestClient, supplier: dict[str, Any], ingredient_seeded: Any, db: Session, employees: dict[str, Any]
) -> None:
    from app.inventory.models import StockMovement
    from app.purchases.models import Reception, ReceptionDraft, ReceptionDraftLine

    body = _create_draft(pos, supplier, ingredient_seeded.id)

    assert body["status"] == "pending"
    assert body["supplier_name"] == supplier["name"]
    assert body["created_by_employee_name"] == employees["cashier"].name
    assert body["cash_paid_amount"] is None
    assert body["photo"].startswith("/api/v1/photos/")
    [line] = body["lines"]
    assert line["quantity"] == "2"
    assert line["purchase_unit"] == "kg"
    assert line["ingredient_name"] == ingredient_seeded.name
    _assert_no_cost(body)

    # La cantidad en unidad de compra se convierte una sola vez, acá: 2 kg = 2000 g.
    row = db.execute(select(ReceptionDraftLine)).scalar_one()
    assert row.qty_purchase_milli == 2000
    assert row.purchase_factor == 1000
    assert row.qty_base == 2_000_000

    # El stock NO sube hasta que el administrador complete con el costo real.
    assert _count(db, ReceptionDraft) == 1
    assert _count(db, Reception) == 0
    assert _count(db, StockMovement, StockMovement.ingredient_id == ingredient_seeded.id) == 0


def test_a_price_sent_from_the_tablet_is_refused_not_ignored(
    pos: TestClient, supplier: dict[str, Any], ingredient_seeded: Any, db: Session
) -> None:
    from app.purchases.models import ReceptionDraft

    payload = _draft_payload(supplier["id"], ingredient_seeded.id)
    payload["lines"][0]["purchase_unit_price"] = "14500"
    resp = pos.post(f"{API}/reception-drafts", json=payload, headers=_idem())
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"
    assert "purchase_unit_price" in resp.json()["error"]["message"]
    assert _count(db, ReceptionDraft) == 0


def test_the_photo_is_mandatory(pos: TestClient, supplier: dict[str, Any], ingredient_seeded: Any, db: Session) -> None:
    from app.purchases.models import ReceptionDraft

    payload = _draft_payload(supplier["id"], ingredient_seeded.id)
    del payload["photo"]
    resp = pos.post(f"{API}/reception-drafts", json=payload, headers=_idem())
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "PHOTO_REQUIRED"
    assert _count(db, ReceptionDraft) == 0


def test_invoice_number_or_no_invoice(pos: TestClient, supplier: dict[str, Any], ingredient_seeded: Any) -> None:
    resp = pos.post(
        f"{API}/reception-drafts", json=_draft_payload(supplier["id"], ingredient_seeded.id, invoice_number="  "), headers=_idem()
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "INVOICE_NUMBER_REQUIRED"

    body = _create_draft(pos, supplier, ingredient_seeded.id, invoice_number="ignorado", no_invoice=True)
    assert body["no_invoice"] is True
    assert body["invoice_number"] is None


def test_an_unknown_ingredient_rejects_before_taking_cash_out_of_the_drawer(
    device_client: TestClient, open_shift: Any, supplier: dict[str, Any], ingredient_seeded: Any, db: Session
) -> None:
    from app.purchases.models import ReceptionDraft
    from app.shifts.models import CashMovement

    open_shift()  # identifica al cajero
    payload = _draft_payload(supplier["id"], ingredient_seeded.id, cash_paid_amount=50_000)
    payload["lines"].append({"ingredient_id": 999_999, "quantity": "1"})
    resp = device_client.post(f"{API}/reception-drafts", json=payload, headers=_idem())
    assert resp.status_code == 404, resp.text
    assert _count(db, ReceptionDraft) == 0
    assert _count(db, CashMovement) == 0


def test_a_zero_quantity_is_refused_before_writing(
    pos: TestClient, supplier: dict[str, Any], ingredient_seeded: Any, db: Session
) -> None:
    from app.purchases.models import ReceptionDraft

    payload = _draft_payload(supplier["id"], ingredient_seeded.id)
    payload["lines"][0]["quantity"] = "0"
    resp = pos.post(f"{API}/reception-drafts", json=payload, headers=_idem())
    assert resp.status_code == 400, resp.text
    assert _count(db, ReceptionDraft) == 0


def test_an_inactive_supplier_is_refused(pos: TestClient, create_supplier: Any, ingredient_seeded: Any) -> None:
    inactive = create_supplier(name="Viejo", nit="800", active=False)
    resp = pos.post(f"{API}/reception-drafts", json=_draft_payload(inactive["id"], ingredient_seeded.id), headers=_idem())
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "SUPPLIER_INACTIVE"


def test_paying_from_the_drawer_without_an_open_shift_is_409_and_writes_nothing(
    pos: TestClient, supplier: dict[str, Any], ingredient_seeded: Any, db: Session
) -> None:
    from app.purchases.models import ReceptionDraft

    resp = pos.post(
        f"{API}/reception-drafts",
        json=_draft_payload(supplier["id"], ingredient_seeded.id, cash_paid_amount=20_000),
        headers=_idem(),
    )
    assert resp.status_code == 409, resp.text
    assert resp.json()["error"]["code"] == "NO_OPEN_SHIFT"
    assert _count(db, ReceptionDraft) == 0


def test_without_a_person_identified_the_tablet_cannot_register(
    device_client: TestClient, supplier: dict[str, Any], ingredient_seeded: Any
) -> None:
    resp = device_client.post(
        f"{API}/reception-drafts", json=_draft_payload(supplier["id"], ingredient_seeded.id), headers=_idem()
    )
    assert resp.status_code == 401, resp.text


def test_the_same_idempotency_key_never_duplicates_a_draft(
    pos: TestClient, supplier: dict[str, Any], ingredient_seeded: Any, db: Session
) -> None:
    from app.purchases.models import ReceptionDraft

    headers = _idem()
    payload = _draft_payload(supplier["id"], ingredient_seeded.id)
    first = pos.post(f"{API}/reception-drafts", json=payload, headers=headers)
    second = pos.post(f"{API}/reception-drafts", json=payload, headers=headers)
    assert first.status_code == second.status_code == 201
    assert first.json()["id"] == second.json()["id"]
    assert _count(db, ReceptionDraft) == 1


def test_with_purchases_off_the_tablet_gets_feature_disabled(
    pos: TestClient, supplier: dict[str, Any], ingredient_seeded: Any, set_feature: Any
) -> None:
    set_feature("purchases", False)
    for resp in (
        pos.post(f"{API}/reception-drafts", json=_draft_payload(supplier["id"], ingredient_seeded.id), headers=_idem()),
        pos.get(f"{API}/reception-drafts"),
        pos.get(f"{API}/device/suppliers"),
        pos.get(f"{API}/device/reception-ingredients"),
    ):
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "FEATURE_DISABLED"


# ---------------------------------------------------------------------------
# Lo que ve la tablet.
# ---------------------------------------------------------------------------


def test_the_tablet_reads_suppliers_ingredients_and_today_without_any_cost(
    pos: TestClient, supplier: dict[str, Any], create_supplier: Any, ingredient_seeded: Any
) -> None:
    create_supplier(name="Dado de baja", nit="801", active=False)
    _create_draft(pos, supplier, ingredient_seeded.id)

    suppliers = pos.get(f"{API}/device/suppliers")
    assert suppliers.status_code == 200, suppliers.text
    assert [s["name"] for s in suppliers.json()] == [supplier["name"]]
    assert set(suppliers.json()[0]) == {"id", "name", "invoices_required"}

    ingredients = pos.get(f"{API}/device/reception-ingredients")
    assert ingredients.status_code == 200, ingredients.text
    assert ingredients.json() == [
        {"id": ingredient_seeded.id, "name": ingredient_seeded.name, "purchase_unit": "kg", "base_unit": "g"}
    ]

    today = pos.get(f"{API}/reception-drafts")
    assert today.status_code == 200, today.text
    assert len(today.json()) == 1

    for resp in (suppliers, ingredients, today):
        _assert_no_cost(resp.json())


def test_the_openapi_of_the_tablet_routes_declares_no_cost_fields(client: TestClient) -> None:
    spec = client.get("/openapi.json").json()
    schemas = spec["components"]["schemas"]
    for name in ("ReceptionDraftOut", "ReceptionDraftLineOut", "DeviceSupplierOut", "DeviceReceptionIngredientOut", "ReceptionDraftIn", "ReceptionDraftLineIn"):
        props = set(schemas[name]["properties"])
        leaked = {p for p in props if any(s in p.lower() for s in MONEY_SECRETS)}
        assert not leaked, f"{name} declara {sorted(leaked)}"


def test_admin_routes_of_drafts_are_not_reachable_from_the_tablet(pos: TestClient, store: Store) -> None:
    for method, path in (
        ("get", f"{API}/admin/reception-drafts?store_id={store.id}"),
        ("get", f"{API}/admin/reception-drafts/1"),
        ("post", f"{API}/admin/reception-drafts/1/complete"),
        ("post", f"{API}/admin/reception-drafts/1/reject"),
    ):
        resp = getattr(pos, method)(path, **({"json": {}} if method == "post" else {}))
        assert resp.status_code in (401, 403, 404), f"{method} {path} -> {resp.status_code}"


# ---------------------------------------------------------------------------
# El administrador completa o rechaza.
# ---------------------------------------------------------------------------


def test_admin_sees_pending_first_with_how_long_it_waits(
    pos: TestClient, admin_client: TestClient, supplier: dict[str, Any], ingredient_seeded: Any, store: Store, clock: Any, db: Session,
    identify: Any, employees: dict[str, Any],
) -> None:
    from app.purchases.hooks import pending_drafts_count

    identify(pos, employees["cashier"])  # con el reloj de prueba ya puesto
    first = _create_draft(pos, supplier, ingredient_seeded.id)
    clock.advance(minutes=30)
    identify(pos, employees["cashier"])  # la persona activa vence por inactividad
    second = _create_draft(pos, supplier, ingredient_seeded.id, invoice_number="FE-501")
    clock.advance(minutes=95)

    assert pending_drafts_count(db, store.id) == 2
    resp = admin_client.get(f"{API}/admin/reception-drafts?store_id={store.id}&status=pending")
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert [r["id"] for r in rows] == [first["id"], second["id"]]  # la que más espera, arriba
    assert rows[0]["waiting_minutes"] == 125
    assert rows[1]["waiting_minutes"] == 95
    [line] = rows[0]["lines"]
    assert line["qty_base"] == "2000" and line["base_unit"] == "g"
    assert rows[0]["photo"] == first["photo"]


def test_completing_creates_reception_lot_and_payable_through_the_usual_path(
    pos: TestClient, admin_client: TestClient, supplier: dict[str, Any], ingredient_seeded: Any, store: Store, db: Session, employees: dict[str, Any]
) -> None:
    from app.inventory.models import StockMovement
    from app.purchases.hooks import pending_drafts_count

    draft = _create_draft(pos, supplier, ingredient_seeded.id)
    resp = admin_client.post(
        f"{API}/admin/reception-drafts/{draft['id']}/complete",
        json=_complete_payload(supplier["id"], ingredient_seeded.id),
        headers=_idem(),
    )
    assert resp.status_code == 201, resp.text
    reception = resp.json()
    assert reception["status"] == "confirmed"
    assert reception["photo"] == draft["photo"]
    # Quien recibió es el cajero que registró en el POS, no el administrador.
    assert reception["received_by_employee_id"] == employees["cashier"].id
    assert reception["payable_id"] is not None
    [line] = reception["lines"]
    assert line["stock_movement_id"] is not None
    assert line["lot_code"] == "L-7"

    assert _count(db, StockMovement, StockMovement.ingredient_id == ingredient_seeded.id) == 1
    assert pending_drafts_count(db, store.id) == 0

    after = admin_client.get(f"{API}/admin/reception-drafts/{draft['id']}").json()
    assert after["status"] == "completed"
    assert after["reception_id"] == reception["id"]
    assert after["waiting_minutes"] is None

    payables = admin_client.get(f"{API}/admin/payables?store_id={store.id}").json()
    payable = next(p for p in payables if p["id"] == reception["payable_id"])
    assert payable["amount"] == 29_000
    assert payable["balance"] == 29_000

    # Ya completada: otra vez es 409 y no crea otra recepción.
    again = admin_client.post(
        f"{API}/admin/reception-drafts/{draft['id']}/complete",
        json=_complete_payload(supplier["id"], ingredient_seeded.id),
        headers=_idem(),
    )
    assert again.status_code == 409, again.text
    assert again.json()["error"]["code"] == "DRAFT_NOT_PENDING"
    assert len(admin_client.get(f"{API}/admin/receptions?store_id={store.id}").json()) == 1


def test_cash_paid_in_the_pos_is_one_expense_and_the_payable_shows_it_paid(
    device_client: TestClient, open_shift: Any, admin_client: TestClient, supplier: dict[str, Any], ingredient_seeded: Any, store: Store, db: Session
) -> None:
    from app.purchases.models import Payment
    from app.shifts.models import CashMovement, CashMovementCause, CashMovementKind

    open_shift()
    draft = _create_draft(device_client, supplier, ingredient_seeded.id, cash_paid_amount=20_000)
    assert draft["cash_paid_amount"] == 20_000

    expense = db.execute(select(CashMovement)).scalar_one()
    assert expense.kind == CashMovementKind.EXPENSE
    assert expense.cause == CashMovementCause.SUPPLIER_PAYMENT
    assert expense.amount == 20_000

    resp = admin_client.post(
        f"{API}/admin/reception-drafts/{draft['id']}/complete",
        json=_complete_payload(supplier["id"], ingredient_seeded.id),
        headers=_idem(),
    )
    assert resp.status_code == 201, resp.text
    reception = resp.json()

    # Un solo egreso: completar no saca la plata del cajón otra vez.
    assert _count(db, CashMovement) == 1
    payment = db.execute(select(Payment)).scalar_one()
    assert payment.amount == 20_000
    assert payment.from_cash_drawer is True
    assert payment.cash_movement_id == expense.id
    assert payment.payable_id == reception["payable_id"]

    payables = admin_client.get(f"{API}/admin/payables?store_id={store.id}").json()
    payable = next(p for p in payables if p["id"] == reception["payable_id"])
    assert payable["amount"] == 29_000
    assert payable["balance"] == 9_000


def test_cash_paid_above_the_completed_total_is_refused_and_nothing_is_written(
    device_client: TestClient, open_shift: Any, admin_client: TestClient, supplier: dict[str, Any], ingredient_seeded: Any, db: Session
) -> None:
    from app.purchases.models import Payable, Reception

    open_shift()
    draft = _create_draft(device_client, supplier, ingredient_seeded.id, cash_paid_amount=50_000)
    resp = admin_client.post(
        f"{API}/admin/reception-drafts/{draft['id']}/complete",
        json=_complete_payload(supplier["id"], ingredient_seeded.id),
        headers=_idem(),
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "DRAFT_CASH_EXCEEDS_TOTAL"
    assert _count(db, Reception) == 0
    assert _count(db, Payable) == 0
    assert admin_client.get(f"{API}/admin/reception-drafts/{draft['id']}").json()["status"] == "pending"


def test_a_price_guard_on_completion_leaves_the_draft_pending(
    pos: TestClient, admin_client: TestClient, supplier: dict[str, Any], ingredient_seeded: Any, db: Session
) -> None:
    from app.purchases.models import Reception

    draft = _create_draft(pos, supplier, ingredient_seeded.id)
    payload = _complete_payload(supplier["id"], ingredient_seeded.id)
    payload["lines"][0]["purchase_unit_price"] = "160000"  # ~11× la referencia: parece precio de empaque
    resp = admin_client.post(f"{API}/admin/reception-drafts/{draft['id']}/complete", json=payload, headers=_idem())
    assert resp.status_code == 409, resp.text
    assert resp.json()["error"]["code"] == "PRICE_LOOKS_LIKE_PACKAGE"
    assert _count(db, Reception) == 0
    assert admin_client.get(f"{API}/admin/reception-drafts/{draft['id']}").json()["status"] == "pending"


def test_rejecting_keeps_the_reason_and_the_tablet_sees_it(
    pos: TestClient, admin_client: TestClient, supplier: dict[str, Any], ingredient_seeded: Any, store: Store, db: Session
) -> None:
    from app.purchases.hooks import pending_drafts_count

    draft = _create_draft(pos, supplier, ingredient_seeded.id)

    blank = admin_client.post(f"{API}/admin/reception-drafts/{draft['id']}/reject", json={"reason": "   "})
    assert blank.status_code == 400, blank.text
    assert admin_client.get(f"{API}/admin/reception-drafts/{draft['id']}").json()["status"] == "pending"

    resp = admin_client.post(f"{API}/admin/reception-drafts/{draft['id']}/reject", json={"reason": "Factura de otra sede"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "rejected"
    assert body["rejected_reason"] == "Factura de otra sede"
    assert body["rejected_by_employee_name"] == "Admin"
    assert pending_drafts_count(db, store.id) == 0

    [mine] = pos.get(f"{API}/reception-drafts").json()
    assert mine["status"] == "rejected"
    assert mine["rejected_reason"] == "Factura de otra sede"

    complete = admin_client.post(
        f"{API}/admin/reception-drafts/{draft['id']}/complete",
        json=_complete_payload(supplier["id"], ingredient_seeded.id),
        headers=_idem(),
    )
    assert complete.status_code == 409, complete.text


def test_a_draft_of_another_organization_is_404(
    admin_client: TestClient, db: Session, org_b: Any, store_b: Store
) -> None:
    from app.core import clock as clock_module
    from app.auth.models import Employee
    from app.purchases.models import ReceptionDraft, Supplier

    now = clock_module.now_utc()
    other_supplier = Supplier(
        organization_id=org_b.id, store_id=store_b.id, name="Ajeno", payment_term_days=0,
        invoices_required=False, active=True, created_at=now, updated_at=now,
    )
    person = Employee(
        organization_id=org_b.id, store_id=store_b.id, name="Otro", role="operator", pin_hash="x",
        can_charge=False, active=True, failed_pin_attempts=0, created_at=now, updated_at=now,
    )
    db.add_all([other_supplier, person])
    db.flush()
    draft = ReceptionDraft(
        organization_id=org_b.id, store_id=store_b.id, supplier_id=other_supplier.id, photo="c.jpg",
        created_by_employee_id=person.id, created_by_employee_name="Otro", created_at=now, business_date=now.date(),
    )
    db.add(draft)
    db.commit()
    assert admin_client.get(f"{API}/admin/reception-drafts/{draft.id}").status_code == 404
    assert admin_client.post(f"{API}/admin/reception-drafts/{draft.id}/reject", json={"reason": "x"}).status_code == 404


# ---------------------------------------------------------------------------
# Auditoría de tablet: la recepción arranca precargada.
# ---------------------------------------------------------------------------


def test_suggestions_preload_the_last_purchase_of_that_supplier_without_prices(
    pos: TestClient, admin_client: TestClient, supplier: dict[str, Any], ingredient_seeded: Any
) -> None:
    empty = pos.get(f"{API}/device/reception-suggestions", params={"supplier_id": supplier["id"]})
    assert empty.status_code == 200, empty.text
    assert empty.json()["source"] == "none"

    draft = _create_draft(pos, supplier, ingredient_seeded.id)
    done = admin_client.post(
        f"{API}/admin/reception-drafts/{draft['id']}/complete",
        json=_complete_payload(supplier["id"], ingredient_seeded.id),
        headers=_idem(),
    )
    assert done.status_code == 201, done.text

    body = pos.get(f"{API}/device/reception-suggestions", params={"supplier_id": supplier["id"]}).json()
    assert body["source"] == "last_purchase"
    [line] = body["last_purchase_lines"]
    assert (line["ingredient_id"], line["quantity"], line["purchase_unit"]) == (ingredient_seeded.id, "2", "kg")
    assert body["last_purchase_date"] is not None
    _assert_no_cost(body)


def test_suggestions_prefer_what_was_approved_in_requests(
    device_client: TestClient,
    open_shift: Any,
    admin_client: TestClient,
    supplier: dict[str, Any],
    ingredient_seeded: Any,
    set_feature: Any,
) -> None:
    set_feature("inventory.perpetual", True)
    open_shift()
    created = device_client.post(
        f"{API}/requests/supplies",
        json={"lines": [{"ingredient_id": ingredient_seeded.id, "qty": "3", "entry_unit": "kg"}]},
        headers=_idem(),
    )
    assert created.status_code == 201, created.text
    approved = admin_client.post(f"{API}/admin/requests/{created.json()['id']}/approve", json={}, headers=_idem())
    assert approved.status_code == 200, approved.text

    body = device_client.get(f"{API}/device/reception-suggestions", params={"supplier_id": supplier["id"]}).json()
    assert body["source"] == "request"
    assert body["request_ids"] == [created.json()["id"]]
    assert [(line["ingredient_id"], line["quantity"]) for line in body["request_lines"]] == [(ingredient_seeded.id, "3")]
    _assert_no_cost(body)


def test_suggestions_of_a_supplier_of_another_store_are_404(pos: TestClient, supplier: dict[str, Any]) -> None:
    resp = pos.get(f"{API}/device/reception-suggestions", params={"supplier_id": supplier["id"] + 999})
    assert resp.status_code == 404
