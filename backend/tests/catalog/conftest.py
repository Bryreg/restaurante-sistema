"""Fixtures propias del dominio de carta (CONTRATO-INTERNO.md §3): no
redefine las compartidas de `tests/conftest.py`, sólo agrega las de acá.
"""

from __future__ import annotations

from typing import Any, Callable

import pytest
from fastapi.testclient import TestClient

from app.stores.models import Store


@pytest.fixture()
def category_id(admin_client: TestClient, store: Store) -> int:
    resp = admin_client.post(
        f"/api/v1/admin/categories?store_id={store.id}",
        json={
            "name": "Platos Fuertes",
            "sort_order": 1,
            "default_course": "main",
            "default_station": "hot_kitchen",
        },
    )
    assert resp.status_code == 200, resp.text
    return int(resp.json()["id"])


@pytest.fixture()
def create_product(
    admin_client: TestClient, store: Store, category_id: int
) -> Callable[..., dict[str, Any]]:
    def _create(
        *,
        name: str = "Bandeja paisa",
        dine_in: int = 38_000,
        takeout: int | None = None,
        delivery: int | None = None,
        platform: int | None = None,
        daily_count: int | None = None,
        category: int | None = None,
        tax_code: str | None = None,
        is_delivery_fee: bool = False,
        expect_status: int = 200,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "category_id": category if category is not None else category_id,
            "name": name,
            "prices": {"dine_in": dine_in, "takeout": takeout, "delivery": delivery, "platform": platform},
        }
        if daily_count is not None:
            payload["daily_count"] = daily_count
        if tax_code is not None:
            payload["tax_code"] = tax_code
        if is_delivery_fee:
            payload["is_delivery_fee"] = True
        resp = admin_client.post(f"/api/v1/admin/products?store_id={store.id}", json=payload)
        assert resp.status_code == expect_status, resp.text
        return resp.json()

    return _create


@pytest.fixture()
def create_combo(admin_client: TestClient, store: Store) -> Callable[..., dict[str, Any]]:
    def _create(
        *,
        name: str = "Corrientazo test",
        price: int = 15_000,
        active: bool = True,
        schedule: dict[str, Any] | None = None,
        groups: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        payload = {
            "name": name,
            "price": price,
            "active": active,
            "schedule": schedule or {"days": [0, 1, 2, 3, 4, 5], "from": "11:30", "to": "15:00"},
            "groups": groups or [],
        }
        resp = admin_client.post(f"/api/v1/admin/combos?store_id={store.id}", json=payload)
        assert resp.status_code == 200, resp.text
        return resp.json()

    return _create
