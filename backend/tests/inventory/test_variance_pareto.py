"""Semáforo con signo y Pareto de varianza por insumo (informe de
visualización #9 y sistema mínimo §6; analista #12)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.inventory.models import StoreInventorySettings
from app.inventory.service import _signed_variance_level
from app.stores.models import Store

API = "/api/v1"


@pytest.fixture(autouse=True)
def _flags(set_feature: Callable[..., None]) -> None:
    for key in ("catalog.recipes", "inventory.perpetual", "inventory.counts", "inventory.variance"):
        set_feature(key, True)


def test_large_surplus_is_amber_never_red_and_large_shortage_is_red() -> None:
    settings = StoreInventorySettings(variance_yellow_threshold_bp=200, variance_red_threshold_bp=400)
    # 50 % de desvío sobre 100 de teórico: faltante → rojo; sobrante → ámbar.
    assert _signed_variance_level(pct_bp=5000, theoretical=100, variance_qty=50, settings=settings) == "red"
    assert _signed_variance_level(pct_bp=5000, theoretical=100, variance_qty=-50, settings=settings) == "yellow"
    # Por debajo del rojo el signo no cambia nada.
    assert _signed_variance_level(pct_bp=300, theoretical=100, variance_qty=-3, settings=settings) == "yellow"
    assert _signed_variance_level(pct_bp=100, theoretical=100, variance_qty=-1, settings=settings) == "green"


def _count(admin_client: TestClient, store: Store, lines: dict[int, str]) -> dict[str, Any]:
    opened = admin_client.post(f"{API}/admin/counts?store_id={store.id}", json={"scope": "full"}).json()
    admin_client.put(
        f"{API}/admin/counts/{opened['id']}/lines?store_id={store.id}",
        json={"lines": [{"ingredient_id": i, "qty_counted": q, "was_counted": True} for i, q in lines.items()]},
    )
    applied = admin_client.post(
        f"{API}/admin/counts/{opened['id']}/apply?store_id={store.id}",
        json={"authorizer_pin": "9999"},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert applied.status_code == 200, applied.text
    return opened


def test_variance_without_count_id_uses_the_latest_applied_count_and_ranks_a_pareto(
    admin_client: TestClient, store: Store, create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    empty = admin_client.get(f"{API}/admin/variance", params={"store_id": store.id})
    assert empty.status_code == 200, empty.text
    assert empty.json()["available"] is False
    assert empty.json()["count_id"] is None
    assert empty.json()["reason"]

    carne = create_ingredient(name="Carne", official_cost="10", min_stock="1")["id"]  # $10/g
    papa = create_ingredient(name="Papa", official_cost="1", min_stock="1")["id"]  # $1/g
    sal = create_ingredient(name="Sal", official_cost="1", min_stock="1")["id"]
    _count(admin_client, store, {carne: "100", papa: "100", sal: "50"})
    c2 = _count(admin_client, store, {carne: "60", papa: "300", sal: "50"})

    resp = admin_client.get(f"{API}/admin/variance", params={"store_id": store.id})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["count_id"] == c2["id"]
    assert body["latest_applied_count_id"] == c2["id"]
    by_id = {r["ingredient_id"]: r for r in body["rows"]}
    # Carne: faltan 40 g ($400) → rojo. Papa: sobran 200 g (−$200) → ámbar, nunca rojo.
    assert by_id[carne]["level"] == "red"
    assert by_id[papa]["level"] == "yellow"

    pareto = body["pareto"]
    assert [p["ingredient_id"] for p in pareto] == [carne, papa]  # la sal no tiene varianza
    assert pareto[0] | {} == {
        "ingredient_id": carne, "ingredient_name": "Carne", "variance_value": 400, "abs_value": 400,
        "direction": "shortage", "share_bp": 6667, "cumulative_bp": 6667, "level": "red",
    }
    assert (pareto[1]["variance_value"], pareto[1]["direction"], pareto[1]["share_bp"], pareto[1]["cumulative_bp"]) == (
        -200, "surplus", 3333, 10000,
    )
    assert body["total_abs_variance_value"] == 600
    assert (body["shortage_value"], body["surplus_value"], body["net_variance_value"]) == (400, -200, 200)
    assert body["unvalued_rows"] == 0
