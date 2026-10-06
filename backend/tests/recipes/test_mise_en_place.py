"""Mise en place con nivel par (0040): qué producir hoy y en cuántas tandas,
contra lo que hay y lo que se viene usando."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Callable
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

API = "/api/v1"


def _prep(admin_client: TestClient, store_id: int, **overrides: Any) -> dict[str, Any]:
    payload = {"name": "Caldo", "mode": "batch", "standard_yield_qty": "1000", "standard_yield_unit": "g", "lines": []}
    payload.update(overrides)
    resp = admin_client.post(f"{API}/admin/preparations", params={"store_id": store_id}, json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_mise_en_place_says_what_to_produce_and_how_many_batches(
    db: Session, store: Any, admin_client: TestClient, device_client: TestClient, identify: Any,
    employees: dict[str, Any], make_ingredient: Any, set_feature: Callable[..., None],
) -> None:
    for key in ("catalog.recipes", "catalog.preps", "inventory.perpetual"):
        set_feature(key, True)
    ing = make_ingredient("Hueso (mise)")
    caldo = _prep(admin_client, store.id, par_qty="3000", lines=[{"ingredient_id": ing.id, "qty": "500", "unit": "g"}])
    sin_par = _prep(admin_client, store.id, name="Sofrito", lines=[{"ingredient_id": ing.id, "qty": "100", "unit": "g"}])
    assert caldo["par_qty"] == "3000"

    identify(device_client, employees["cashier"])
    for prep in (caldo, sin_par):
        r = device_client.post(
            f"{API}/preparations/{prep['id']}/produce",
            json={"qty_expected": "1000", "qty_real": "1000", "employee_pin": "1111"},
            headers={"Idempotency-Key": str(uuid4())},
        )
        assert r.status_code == 201, r.text

    # 700 g de caldo usados ayer (dentro de la ventana de 14 días cerrados).
    from app.auth.deps import Actor
    from app.core import clock, tz
    from app.inventory import hooks
    from app.inventory.models import CostSource, MovementCause

    yesterday = tz.today_business_date(store.cutoff_hour) - timedelta(days=1)
    at = datetime.combine(yesterday, datetime.min.time(), tzinfo=timezone.utc) + timedelta(hours=18)
    admin = employees["admin"]
    actor = Actor(kind="admin", organization_id=store.organization_id, store_id=store.id,
                  employee_id=admin.id, employee_name=admin.name, role=admin.role)
    for prep_id, qty in ((caldo["id"], -700_000), (sin_par["id"], -280_000)):
        hooks.record_movement(
            db, organization_id=store.organization_id, store_id=store.id, preparation_id=prep_id,
            qty_base=qty, cause=MovementCause.SALE, cost_micros=None, cost_source=CostSource.NONE,
            actor=actor, business_date=yesterday, at=min(at, clock.now_utc()),
        )
    db.commit()

    body = admin_client.get(f"{API}/admin/mise-en-place", params={"store_id": store.id}).json()
    rows = {r["name"]: r for r in body["rows"]}
    c = rows["Caldo"]
    # Hay 1000 − 700 = 300 g; el par es 3000: faltan 2700 g = 3 tandas de 1000 g.
    assert (c["stock"], c["par"], c["to_produce"], c["batches"], c["status"]) == ("300", "3000", "2700", 3, "producir")
    assert c["avg_daily_use"] == "50"  # 700 g en 14 días
    s = rows["Sofrito"]
    assert s["status"] == "sin_par" and s["to_produce"] is None
    assert s["suggested_par"] == "24"  # 20 g/día + 20 %
    assert body["to_produce_count"] == 1
    assert body["rows"][0]["name"] == "Caldo"  # lo que hay que producir, primero

    # La tablet de cocina ve la misma lista, sin costos.
    device = device_client.get(f"{API}/mise-en-place")
    assert device.status_code == 200, device.text
    assert "cost" not in device.text
