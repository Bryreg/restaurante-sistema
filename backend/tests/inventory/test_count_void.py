"""Anular un conteo con reversa (`POST /admin/counts/{id}/void`): nada se
borra; cada ajuste que el conteo escribió recibe su movimiento contrario y el
conteo deja de contar como conteo."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.auth.deps import Actor
from app.auth.models import Employee
from app.core.quantity import parse_qty_base
from app.inventory import hooks
from app.inventory.models import CostSource, MovementCause, StockMovement
from app.stores.models import Store

ADMIN_PIN = "9999"  # `tests/conftest.py::KNOWN_PINS["Admin"]`


def _actor(store: Store, employee: Employee) -> Actor:
    return Actor(
        kind="admin", organization_id=store.organization_id, store_id=store.id,
        employee_id=employee.id, employee_name=employee.name, role=employee.role,
    )


def _applied_count(
    db: Any, store: Store, admin_client: TestClient, employees: dict[str, Employee], iid: int, counted: str
) -> int:
    at = datetime(2026, 1, 14, 15, tzinfo=timezone.utc)
    hooks.record_movement(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=iid,
        qty_base=parse_qty_base("1000"), cause=MovementCause.PURCHASE, cost_micros=10_000_000,
        cost_source=CostSource.OFFICIAL, actor=_actor(store, employees["admin"]), business_date=at.date(), at=at,
    )
    db.commit()
    opened = admin_client.post(f"/api/v1/admin/counts?store_id={store.id}", json={"scope": "full"}).json()
    lines = admin_client.put(
        f"/api/v1/admin/counts/{opened['id']}/lines?store_id={store.id}",
        json={"lines": [{"ingredient_id": iid, "qty_counted": counted, "was_counted": True}]},
    )
    assert lines.status_code == 200, lines.text
    applied = admin_client.post(
        f"/api/v1/admin/counts/{opened['id']}/apply?store_id={store.id}",
        json={"authorizer_pin": ADMIN_PIN}, headers={"Idempotency-Key": str(uuid4())},
    )
    assert applied.status_code == 200, applied.text
    return int(opened["id"])


def _void(admin_client: TestClient, store: Store, count_id: int, **body: Any) -> Any:
    payload = {"reason": "Conteo cargado dos veces por la demo", "authorizer_pin": ADMIN_PIN, **body}
    return admin_client.post(
        f"/api/v1/admin/counts/{count_id}/void?store_id={store.id}",
        json=payload, headers={"Idempotency-Key": str(uuid4())},
    )


def test_void_reverses_the_adjustments_and_keeps_the_trail(
    db: Any, store: Store, admin_client: TestClient, employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]], set_feature: Callable[..., None], clock: Any,
) -> None:
    for key in ("catalog.recipes", "inventory.perpetual", "inventory.counts"):
        set_feature(key, True)
    iid = int(create_ingredient(name="Aceite", base_unit="ml", purchase_unit="l", min_stock="100")["id"])
    count_id = _applied_count(db, store, admin_client, employees, iid, counted="800")
    assert hooks.current_stock(db, store_id=store.id, ingredient_id=iid) == parse_qty_base("800")

    resp = _void(admin_client, store, count_id)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "voided"
    assert body["void_reason"] == "Conteo cargado dos veces por la demo"
    assert body["voided_by_employee_name"]

    # El saldo vuelve a lo que el libro decía sin el conteo, y nada se borró:
    # el ajuste y su reversa están los dos.
    db.expire_all()
    assert hooks.current_stock(db, store_id=store.id, ingredient_id=iid) == parse_qty_base("1000")
    refs = sorted(
        (m.ref_type, m.qty_base)
        for m in db.execute(select(StockMovement).where(StockMovement.ingredient_id == iid)).scalars()
        if m.cause == MovementCause.COUNT_ADJUSTMENT
    )
    assert refs == [("stock_count", -parse_qty_base("200")), ("stock_count_void", parse_qty_base("200"))]

    # Ya no es «el último conteo completo aplicado».
    assert hooks.last_applied_full_count_at(db, store_id=store.id) is None

    # Ni se anula dos veces ni se vuelve a aplicar.
    assert _void(admin_client, store, count_id).status_code == 409
    again = admin_client.post(
        f"/api/v1/admin/counts/{count_id}/apply?store_id={store.id}",
        json={"authorizer_pin": ADMIN_PIN}, headers={"Idempotency-Key": str(uuid4())},
    )
    assert again.status_code == 409

    # La línea de tiempo no lo dibuja.
    timeline = admin_client.get(f"/api/v1/admin/inventory/timeline?store_id={store.id}&from=2026-01-14&to=2026-01-15")
    row = next(r for r in timeline.json()["rows"] if r["ingredient_id"] == iid)
    assert row["counts"] == []


def test_void_needs_a_reason_and_the_admin_pin(
    db: Any, store: Store, admin_client: TestClient, employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]], set_feature: Callable[..., None], clock: Any,
) -> None:
    for key in ("catalog.recipes", "inventory.perpetual", "inventory.counts"):
        set_feature(key, True)
    iid = int(create_ingredient(name="Sal", min_stock="100")["id"])
    count_id = _applied_count(db, store, admin_client, employees, iid, counted="900")

    assert _void(admin_client, store, count_id, reason="  no ").status_code == 400
    assert _void(admin_client, store, count_id, authorizer_pin="0000").status_code in (400, 401, 403)
    db.expire_all()
    assert hooks.current_stock(db, store_id=store.id, ingredient_id=iid) == parse_qty_base("900")
