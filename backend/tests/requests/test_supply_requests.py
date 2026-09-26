"""Pedido de insumos: del POS a la bandeja y de la bandeja a Compras.

Aprobar **hace algo**: el pedido queda «aprobado · por comprar» y sus
renglones aparecen en `hooks.approved_supply_lines`, que es lo que lee Compras;
marcarlo comprado lo saca de esa lista. Nada de esto crea recepciones, pagos
ni movimientos de inventario.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.audit.models import AuditLog
from app.inventory.models import StockMovement
from app.requests import hooks
from app.requests.models import StaffRequest, StaffRequestLine
from tests.requests.conftest import API, find_secret_keys, idem


def _supply(device_client: Any, lines: list[dict[str, Any]], note: str | None = None) -> Any:
    return device_client.post(f"{API}/requests/supplies", json={"lines": lines, "note": note}, headers=idem())


def test_suggestions_list_below_minimum_without_costs(device_client, open_shift, make_ingredient) -> None:
    open_shift()
    papa = make_ingredient("Papa criolla", min_stock=5000)

    resp = device_client.get(f"{API}/requests/supply-suggestions")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["available"] is True
    row = next(r for r in body["rows"] if r["ingredient_id"] == papa.id)
    # Sin movimientos el stock es 0: falta el mínimo entero.
    assert row["current_stock"] == "0"
    assert row["min_stock"] == "5"
    # Faltan 5 g, pero nadie pide 5 g de papa: la sugerencia se redondea HACIA
    # ARRIBA a la unidad cómoda (medio kilo). Antes se publicaba «5» exacto; la
    # auditoría de tablet (58 toques para pedir dos insumos) pidió cantidades
    # que se puedan pedir, en kg y no en gramos con decimales.
    assert row["suggested_qty"] == "500"
    assert row["entry_unit"] == "kg"
    assert row["suggested_entry_qty"] == "0.5"
    assert row["negative"] is False
    assert find_secret_keys(body) == []


def test_full_supply_flow_approve_adjusted_then_bought(
    device_client, admin_client, open_shift, make_ingredient, store, db: Session
) -> None:
    open_shift()
    papa = make_ingredient("Papa criolla", min_stock=5000)
    sal = make_ingredient("Sal", min_stock=1)

    resp = _supply(
        device_client,
        [{"ingredient_id": papa.id, "qty": "5"}, {"ingredient_id": sal.id, "qty": "2.5"}],
        note="Para el fin de semana",
    )
    assert resp.status_code == 201, resp.text
    created = resp.json()
    assert created["kind"] == "supply"
    assert created["status"] == "pending"
    assert created["requested_by"]["name"] == "Cashier"
    lines = {line["ingredient_id"]: line for line in created["lines"]}
    assert lines[papa.id]["qty_requested"] == "5"
    assert lines[papa.id]["suggested_qty"] == "500"  # venía sugerido (redondeado a medio kilo)
    assert lines[sal.id]["qty_requested"] == "2.5"
    assert find_secret_keys(created) == []

    mine = device_client.get(f"{API}/requests/mine")
    assert mine.status_code == 200
    assert [r["id"] for r in mine.json()] == [created["id"]]
    assert hooks.pending_count(db, store.id) == 1

    pending = admin_client.get(f"{API}/admin/requests", params={"store_id": store.id, "status": "pending"})
    assert pending.status_code == 200, pending.text
    assert [r["id"] for r in pending.json()] == [created["id"]]

    papa_line = lines[papa.id]["id"]
    approved = admin_client.post(
        f"{API}/admin/requests/{created['id']}/approve",
        json={"lines": [{"line_id": papa_line, "qty": "8"}], "note": "Traigo de más"},
        headers=idem(),
    )
    assert approved.status_code == 200, approved.text
    body = approved.json()
    assert body["status"] == "approved"
    assert body["resolved_by"]["name"] == "Admin"
    assert body["resolution_note"] == "Traigo de más"
    by_ing = {line["ingredient_id"]: line for line in body["lines"]}
    assert by_ing[papa.id]["qty_approved"] == "8"
    assert by_ing[sal.id]["qty_approved"] == "2.5"  # sin ajuste: lo pedido
    assert hooks.pending_count(db, store.id) == 0

    # Lo que ve Compras.
    to_buy = hooks.approved_supply_lines(db, store.id)
    assert {(line.ingredient_id, line.qty_approved) for line in to_buy} == {(papa.id, 8000), (sal.id, 2500)}
    listed = admin_client.get(f"{API}/admin/requests/supplies", params={"store_id": store.id, "status": "approved"})
    assert listed.status_code == 200
    assert [r["id"] for r in listed.json()] == [created["id"]]

    # La tablet la sigue viendo mientras esté por comprar.
    assert [r["status"] for r in device_client.get(f"{API}/requests/mine").json()] == ["approved"]

    bought = admin_client.post(f"{API}/admin/requests/{created['id']}/mark-bought", json={}, headers=idem())
    assert bought.status_code == 200, bought.text
    assert bought.json()["status"] == "bought"
    assert bought.json()["closed_by"]["name"] == "Admin"
    assert hooks.approved_supply_lines(db, store.id) == []

    # Aprobar no movió inventario: eso lo hace la recepción de Compras.
    assert db.execute(select(func.count(StockMovement.id))).scalar_one() == 0
    actions = db.execute(
        select(AuditLog.action).where(AuditLog.entity == "staff_request").order_by(AuditLog.id)
    ).scalars().all()
    assert actions == ["create", "approve", "mark_bought"]


def test_a_line_approved_at_zero_is_not_bought_and_all_zero_is_rejected(
    device_client, admin_client, open_shift, make_ingredient, store, db: Session
) -> None:
    open_shift()
    papa = make_ingredient("Papa criolla")
    sal = make_ingredient("Sal")
    created = _supply(device_client, [{"ingredient_id": papa.id, "qty": "5"}, {"ingredient_id": sal.id, "qty": "1"}]).json()
    ids = {line["ingredient_id"]: line["id"] for line in created["lines"]}

    all_zero = admin_client.post(
        f"{API}/admin/requests/{created['id']}/approve",
        json={"lines": [{"line_id": ids[papa.id], "qty": "0"}, {"line_id": ids[sal.id], "qty": "0"}]},
        headers=idem(),
    )
    assert all_zero.status_code == 400
    assert all_zero.json()["error"]["code"] == "NOTHING_APPROVED"
    # Validar antes de escribir: el rechazo no dejó nada aplicado.
    db.expire_all()
    assert db.get(StaffRequest, created["id"]).status.value == "pending"  # type: ignore[union-attr]
    assert all(
        line.qty_approved is None
        for line in db.execute(select(StaffRequestLine)).scalars()
    )

    ok = admin_client.post(
        f"{API}/admin/requests/{created['id']}/approve",
        json={"lines": [{"line_id": ids[sal.id], "qty": "0"}]},
        headers=idem(),
    )
    assert ok.status_code == 200, ok.text
    assert [line.ingredient_id for line in hooks.approved_supply_lines(db, store.id)] == [papa.id]


def test_reject_needs_a_reason_and_is_final(
    device_client, admin_client, open_shift, make_ingredient, db: Session
) -> None:
    open_shift()
    papa = make_ingredient("Papa criolla")
    created = _supply(device_client, [{"ingredient_id": papa.id, "qty": "5"}]).json()

    no_reason = admin_client.post(f"{API}/admin/requests/{created['id']}/reject", json={"reason": "  "}, headers=idem())
    assert no_reason.status_code == 400
    assert no_reason.json()["error"]["code"] == "REASON_REQUIRED"

    rejected = admin_client.post(
        f"{API}/admin/requests/{created['id']}/reject", json={"reason": "Hay en la bodega"}, headers=idem()
    )
    assert rejected.status_code == 200, rejected.text
    assert rejected.json()["status"] == "rejected"
    assert rejected.json()["resolution_note"] == "Hay en la bodega"

    again = admin_client.post(f"{API}/admin/requests/{created['id']}/approve", json={}, headers=idem())
    assert again.status_code == 409
    assert again.json()["error"]["code"] == "REQUEST_STATUS_CONFLICT"
    bought = admin_client.post(f"{API}/admin/requests/{created['id']}/mark-bought", json={}, headers=idem())
    assert bought.status_code == 409
    # Nada se borra: sigue ahí, rechazada, con su renglón.
    assert db.execute(select(func.count(StaffRequestLine.id))).scalar_one() == 1


def test_an_invalid_line_rejects_the_whole_request_without_writing(
    device_client, open_shift, make_ingredient, db: Session
) -> None:
    open_shift()
    papa = make_ingredient("Papa criolla")

    cases = [
        [{"ingredient_id": papa.id, "qty": "5"}, {"ingredient_id": 999_999, "qty": "1"}],
        [{"ingredient_id": papa.id, "qty": "5"}, {"ingredient_id": papa.id, "qty": "1"}],
        [{"ingredient_id": papa.id, "qty": "0"}],
        [{"ingredient_id": papa.id, "qty": "cinco"}],
        [],
    ]
    for lines in cases:
        resp = _supply(device_client, lines)
        assert resp.status_code in (400, 404, 422), resp.text
    assert db.execute(select(func.count(StaffRequest.id))).scalar_one() == 0
    assert db.execute(select(func.count(StaffRequestLine.id))).scalar_one() == 0


def test_without_an_open_shift_nothing_is_requested(device_client, identify, employees, make_ingredient, db) -> None:
    papa = make_ingredient("Papa criolla")
    identify(device_client, employees["cashier"])
    resp = _supply(device_client, [{"ingredient_id": papa.id, "qty": "5"}])
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "NO_OPEN_SHIFT"
    assert db.execute(select(func.count(StaffRequest.id))).scalar_one() == 0


def test_supply_requests_need_perpetual_inventory(
    device_client, open_shift, make_ingredient, set_feature, db: Session
) -> None:
    open_shift()
    papa = make_ingredient("Papa criolla")
    set_feature("inventory.perpetual", False)

    suggestions = device_client.get(f"{API}/requests/supply-suggestions")
    assert suggestions.status_code == 200
    assert suggestions.json()["available"] is False
    assert suggestions.json()["reason"]
    assert suggestions.json()["rows"] == []

    resp = _supply(device_client, [{"ingredient_id": papa.id, "qty": "5"}])
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
    assert resp.json()["error"]["feature"] == "inventory.perpetual"


def test_idempotency_key_replays_without_duplicating(device_client, open_shift, make_ingredient, db: Session) -> None:
    open_shift()
    papa = make_ingredient("Papa criolla")
    headers = idem()
    payload = {"lines": [{"ingredient_id": papa.id, "qty": "5"}]}
    first = device_client.post(f"{API}/requests/supplies", json=payload, headers=headers)
    second = device_client.post(f"{API}/requests/supplies", json=payload, headers=headers)
    assert first.status_code == second.status_code == 201
    assert first.json()["id"] == second.json()["id"]
    assert db.execute(select(func.count(StaffRequest.id))).scalar_one() == 1

    no_key = device_client.post(f"{API}/requests/supplies", json=payload)
    assert no_key.status_code == 400
    assert no_key.json()["error"]["code"] == "IDEMPOTENCY_KEY_REQUIRED"


def test_mark_bought_hook_closes_the_request_for_purchases(
    device_client, admin_client, open_shift, make_ingredient, store, db: Session
) -> None:
    from app.core.errors import AppError

    open_shift()
    papa = make_ingredient("Papa criolla")
    created = _supply(device_client, [{"ingredient_id": papa.id, "qty": "5"}]).json()

    try:
        hooks.mark_supply_request_bought(db, store_id=store.id, request_id=created["id"], actor=None)
        raise AssertionError("un pedido pendiente no se marca comprado")
    except AppError as exc:
        assert exc.status == 409

    admin_client.post(f"{API}/admin/requests/{created['id']}/approve", json={}, headers=idem())
    db.expire_all()
    hooks.mark_supply_request_bought(db, store_id=store.id, request_id=created["id"], actor=None, note="Recepción 12")
    db.commit()
    assert db.get(StaffRequest, created["id"]).status.value == "bought"  # type: ignore[union-attr]
