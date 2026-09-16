"""`GET/POST/PATCH/DELETE /admin/ingredients`. `Ingredient` es dato maestro
sin flag propia (decisión declarada en `app/inventory/router.py`): estos
tests no tocan ningún feature flag."""

from __future__ import annotations

from typing import Any, Callable

from fastapi.testclient import TestClient

from app.inventory.models import Ingredient
from app.stores.models import Store


def test_min_stock_required_rejects_zero(admin_client: TestClient, store: Store) -> None:
    resp = admin_client.post(
        f"/api/v1/admin/ingredients?store_id={store.id}",
        json={
            "name": "Sal",
            "base_unit": "g",
            "purchase_unit": "kg",
            "purchase_factor": 1000,
            "min_stock": "0",
        },
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "MIN_STOCK_REQUIRED"


def test_min_stock_required_rejects_negative(admin_client: TestClient, store: Store) -> None:
    resp = admin_client.post(
        f"/api/v1/admin/ingredients?store_id={store.id}",
        json={
            "name": "Sal",
            "base_unit": "g",
            "purchase_unit": "kg",
            "purchase_factor": 1000,
            "min_stock": "-5",
        },
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "MIN_STOCK_REQUIRED"


def test_min_stock_positive_is_accepted(
    admin_client: TestClient, create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    created = create_ingredient(min_stock="500")
    assert created["min_stock"] == "500"


def test_create_rejects_python_float_quantity(admin_client: TestClient, store: Store) -> None:
    # El body JSON manda `min_stock` como número, no como string: pydantic
    # tiene que rechazarlo antes de que llegue a `parse_qty_base`.
    resp = admin_client.post(
        f"/api/v1/admin/ingredients?store_id={store.id}",
        json={
            "name": "Sal",
            "base_unit": "g",
            "purchase_unit": "kg",
            "purchase_factor": 1000,
            "min_stock": 5.0,
        },
    )
    assert resp.status_code == 400, resp.text


def test_cost_is_null_with_source_none_when_no_cost_set(
    admin_client: TestClient, create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    created = create_ingredient(official_cost=None, estimated_cost=None)
    assert created["cost"] is None
    assert created["cost_source"] == "none"
    assert created["official_cost"] is None
    assert created["estimated_cost"] is None


def test_official_cost_wins_over_estimated(
    admin_client: TestClient, create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    created = create_ingredient(official_cost="18000", estimated_cost="99999")
    assert created["cost"] == "18000"
    assert created["cost_source"] == "official"


def test_estimated_cost_used_when_no_official(
    admin_client: TestClient, create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    created = create_ingredient(official_cost=None, estimated_cost="500")
    assert created["cost"] == "500"
    assert created["cost_source"] == "estimated"


def test_logical_delete_deactivates_never_removes_row(
    admin_client: TestClient, db: Any, create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    created = create_ingredient()
    resp = admin_client.delete(f"/api/v1/admin/ingredients/{created['id']}")
    assert resp.status_code == 200, resp.text
    assert resp.json()["active"] is False

    row = db.get(Ingredient, created["id"])
    assert row is not None  # nunca se borra la fila
    assert row.active is False


def test_deactivated_ingredient_not_listed_by_default(
    admin_client: TestClient, store: Store, create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    created = create_ingredient(name="Descontinuado")
    admin_client.delete(f"/api/v1/admin/ingredients/{created['id']}")

    resp = admin_client.get(f"/api/v1/admin/ingredients?store_id={store.id}")
    names = [i["name"] for i in resp.json()]
    assert "Descontinuado" not in names

    resp_all = admin_client.get(f"/api/v1/admin/ingredients?store_id={store.id}&active_only=false")
    names_all = [i["name"] for i in resp_all.json()]
    assert "Descontinuado" in names_all


def test_update_clears_official_cost_explicitly(
    admin_client: TestClient, create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    created = create_ingredient(official_cost="10000")
    resp = admin_client.patch(
        f"/api/v1/admin/ingredients/{created['id']}", json={"clear_official_cost": True}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["official_cost"] is None
    assert body["cost_source"] == "none"


def test_substitute_cannot_reference_itself(
    admin_client: TestClient, create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    created = create_ingredient()
    resp = admin_client.patch(
        f"/api/v1/admin/ingredients/{created['id']}",
        json={"substitute_ingredient_id": created["id"]},
    )
    assert resp.status_code == 400, resp.text


def test_substitute_must_exist(admin_client: TestClient, create_ingredient: Callable[..., dict[str, Any]]) -> None:
    created = create_ingredient()
    resp = admin_client.patch(
        f"/api/v1/admin/ingredients/{created['id']}",
        json={"substitute_ingredient_id": 999_999},
    )
    assert resp.status_code == 404, resp.text


def test_substitute_chain_round_trips_through_the_api(
    admin_client: TestClient, create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    lactose_free = create_ingredient(name="Leche deslactosada")
    whole_milk = create_ingredient(name="Leche entera")
    resp = admin_client.patch(
        f"/api/v1/admin/ingredients/{whole_milk['id']}",
        json={"substitute_ingredient_id": lactose_free["id"]},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["substitute_ingredient_id"] == lactose_free["id"]


def test_nonexistent_ingredient_returns_404(admin_client: TestClient) -> None:
    resp = admin_client.patch("/api/v1/admin/ingredients/999999", json={"name": "x"})
    assert resp.status_code == 404
