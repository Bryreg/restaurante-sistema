"""Contar preparaciones (0038): una preparación en modo lote entra al conteo
completo (y al de críticos si es crítica), se captura a ciegas, al aplicar se
ajusta contra su libro en el instante del conteo, y la línea de tiempo la
dibuja con su conteo."""

from __future__ import annotations

from typing import Any, Callable
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

API = "/api/v1"
ADMIN_PIN = "9999"


def _prep(admin_client: TestClient, store_id: int, **overrides: Any) -> dict[str, Any]:
    payload = {"name": "Salsa de la casa", "mode": "batch", "standard_yield_qty": "1000",
               "standard_yield_unit": "g", "lines": []}
    payload.update(overrides)
    resp = admin_client.post(f"{API}/admin/preparations", params={"store_id": store_id}, json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_a_batch_preparation_is_counted_applied_and_drawn(
    db: Session, store: Any, admin_client: TestClient, device_client: TestClient, identify: Any,
    employees: dict[str, Any], make_ingredient: Any, set_feature: Callable[..., None],
) -> None:
    for key in ("catalog.recipes", "catalog.preps", "inventory.perpetual", "inventory.counts"):
        set_feature(key, True)
    ing = make_ingredient("Tomate (salsa)")
    prep = _prep(admin_client, store.id, lines=[{"ingredient_id": ing.id, "qty": "500", "unit": "g"}], key_item=True)
    exploded = _prep(admin_client, store.id, name="Aliño explotado", mode="exploded",
                     lines=[{"ingredient_id": ing.id, "qty": "10", "unit": "g"}])
    assert prep["key_item"] is True

    identify(device_client, employees["cashier"])
    produced = device_client.post(
        f"{API}/preparations/{prep['id']}/produce",
        json={"qty_expected": "1000", "qty_real": "1000", "employee_pin": "1111"},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert produced.status_code == 201, produced.text

    opened = admin_client.post(f"{API}/admin/counts?store_id={store.id}", json={"scope": "key_items"}).json()
    detail = admin_client.get(f"{API}/admin/counts/{opened['id']}?store_id={store.id}").json()
    prep_lines = [l for l in detail["lines"] if l["preparation_id"] is not None]
    # Sólo la de modo lote: la explotada no tiene stock que contar.
    assert [l["preparation_id"] for l in prep_lines] == [prep["id"]]
    assert exploded["id"] not in [l["preparation_id"] for l in detail["lines"]]
    # A ciegas: el renglón no trae el stock del libro.
    assert prep_lines[0]["qty_counted"] is None
    assert "1000" not in str(prep_lines[0]) and "1000.0" not in str(prep_lines[0])

    saved = admin_client.put(
        f"{API}/admin/counts/{opened['id']}/lines?store_id={store.id}",
        json={"lines": [{"preparation_id": prep["id"], "qty_counted": "850", "was_counted": True}]},
    )
    assert saved.status_code == 200, saved.text

    applied = admin_client.post(
        f"{API}/admin/counts/{opened['id']}/apply?store_id={store.id}",
        json={"authorizer_pin": ADMIN_PIN}, headers={"Idempotency-Key": str(uuid4())},
    )
    assert applied.status_code == 200, applied.text
    line = next(l for l in applied.json()["lines"] if l["preparation_id"] == prep["id"])
    assert (line["stock_before"], line["adjustment"], line["stock_after"]) == ("1000", "-150", "850")

    from app.inventory.models import MovementCause, StockMovement

    adj = db.execute(
        select(StockMovement).where(
            StockMovement.preparation_id == prep["id"], StockMovement.cause == MovementCause.COUNT_ADJUSTMENT
        )
    ).scalars().all()
    assert [m.qty_base for m in adj] == [-150_000]
    # Al costo del lote (500 g de tomate a $10 = $5.000 por 1000 g).
    assert adj[0].cost_micros is not None

    timeline = admin_client.get(f"{API}/admin/inventory/timeline?store_id={store.id}").json()
    row = next(r for r in timeline["rows"] if r.get("preparation_id") == prep["id"])
    assert row["kind"] == "preparation"
    assert row["end_qty"] == "850"
    assert [c["diff"] for c in row["counts"]] == ["-150"]


def test_without_preps_feature_a_count_is_ingredients_only(
    db: Session, store: Any, admin_client: TestClient, make_ingredient: Any, set_feature: Callable[..., None],
) -> None:
    for key in ("catalog.recipes", "catalog.preps", "inventory.perpetual", "inventory.counts"):
        set_feature(key, True)
    make_ingredient("Harina")
    _prep(admin_client, store.id, name="Masa")
    set_feature("catalog.preps", False)

    opened = admin_client.post(f"{API}/admin/counts?store_id={store.id}", json={"scope": "full"}).json()
    detail = admin_client.get(f"{API}/admin/counts/{opened['id']}?store_id={store.id}").json()
    assert all(l["preparation_id"] is None for l in detail["lines"])
