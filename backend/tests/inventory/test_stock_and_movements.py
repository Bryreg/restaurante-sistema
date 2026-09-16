"""`GET /admin/inventory/stock`, `GET /admin/ingredients/{id}/movements` y
`POST /admin/inventory/adjustments`: los tres detrás de `inventory.perpetual`,
probados encendida y apagada."""

from __future__ import annotations

from typing import Any, Callable
from uuid import uuid4

from fastapi.testclient import TestClient

from app.stores.models import Store


def test_stock_endpoint_requires_inventory_perpetual_flag(
    admin_client: TestClient, store: Store, set_feature: Callable[..., None]
) -> None:
    set_feature("inventory.perpetual", False)
    resp = admin_client.get(f"/api/v1/admin/inventory/stock?store_id={store.id}")
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"


def test_stock_endpoint_works_when_flag_enabled(
    admin_client: TestClient, store: Store, set_feature: Callable[..., None], create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    set_feature("inventory.perpetual", True)
    create_ingredient(name="Con stock endpoint")
    resp = admin_client.get(f"/api/v1/admin/inventory/stock?store_id={store.id}")
    assert resp.status_code == 200, resp.text
    names = [row["name"] for row in resp.json()]
    assert "Con stock endpoint" in names


def test_stock_endpoint_below_min_and_negative_filters(
    admin_client: TestClient,
    store: Store,
    create_ingredient: Callable[..., dict[str, Any]],
) -> None:
    healthy = create_ingredient(name="Sano", min_stock="100")
    negative = create_ingredient(name="Con deuda", min_stock="100")

    # `healthy` recibe stock por encima de su mínimo; `negative` queda en
    # stock negativo -- ambos vía ajuste manual (el único camino admin para
    # mover el libro directamente en este territorio).
    resp_healthy = admin_client.post(
        f"/api/v1/admin/inventory/adjustments?store_id={store.id}",
        json={
            "ingredient_id": healthy["id"],
            "qty_delta": "500",
            "reason": "conteo inicial",
            "authorizer_pin": "9999",
        },
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert resp_healthy.status_code == 201, resp_healthy.text

    resp = admin_client.post(
        f"/api/v1/admin/inventory/adjustments?store_id={store.id}",
        json={
            "ingredient_id": negative["id"],
            "qty_delta": "-50",
            "reason": "conteo inicial",
            "authorizer_pin": "9999",
        },
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert resp.status_code == 201, resp.text

    resp_negative_only = admin_client.get(f"/api/v1/admin/inventory/stock?store_id={store.id}&negative=true")
    ids = {row["ingredient_id"] for row in resp_negative_only.json()}
    assert negative["id"] in ids
    assert healthy["id"] not in ids

    resp_below_min = admin_client.get(f"/api/v1/admin/inventory/stock?store_id={store.id}&below_min=true")
    ids_below = {row["ingredient_id"] for row in resp_below_min.json()}
    assert negative["id"] in ids_below  # negativo también está bajo mínimo
    assert healthy["id"] not in ids_below  # sano: ni bajo mínimo ni negativo


def test_stock_endpoint_critical_only_filter(
    admin_client: TestClient, store: Store, create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    create_ingredient(name="Crítico", key_item=True)
    create_ingredient(name="No crítico", key_item=False)

    resp = admin_client.get(f"/api/v1/admin/inventory/stock?store_id={store.id}&critical_only=true")
    names = {row["name"] for row in resp.json()}
    assert "Crítico" in names
    assert "No crítico" not in names


def test_movements_endpoint_requires_inventory_perpetual_flag(
    admin_client: TestClient,
    store: Store,
    set_feature: Callable[..., None],
    create_ingredient: Callable[..., dict[str, Any]],
) -> None:
    ingredient = create_ingredient()
    set_feature("inventory.perpetual", False)
    resp = admin_client.get(f"/api/v1/admin/ingredients/{ingredient['id']}/movements")
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"


def test_movements_endpoint_lists_manual_adjustment_and_filters_by_cause(
    admin_client: TestClient, store: Store, create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    ingredient = create_ingredient()
    admin_client.post(
        f"/api/v1/admin/inventory/adjustments?store_id={store.id}",
        json={
            "ingredient_id": ingredient["id"],
            "qty_delta": "10",
            "reason": "ajuste de prueba",
            "authorizer_pin": "9999",
        },
        headers={"Idempotency-Key": str(uuid4())},
    )

    resp = admin_client.get(f"/api/v1/admin/ingredients/{ingredient['id']}/movements")
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["cause"] == "manual_adjustment"
    assert rows[0]["qty_base"] == "10"

    filtered_out = admin_client.get(f"/api/v1/admin/ingredients/{ingredient['id']}/movements?cause=sale")
    assert filtered_out.json() == []

    filtered_in = admin_client.get(f"/api/v1/admin/ingredients/{ingredient['id']}/movements?cause=manual_adjustment")
    assert len(filtered_in.json()) == 1


def test_movements_endpoint_rejects_bad_date(
    admin_client: TestClient, create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    ingredient = create_ingredient()
    resp = admin_client.get(f"/api/v1/admin/ingredients/{ingredient['id']}/movements?from=not-a-date")
    assert resp.status_code == 400


def test_adjustment_requires_inventory_perpetual_flag(
    admin_client: TestClient, store: Store, set_feature: Callable[..., None], create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    ingredient = create_ingredient()
    set_feature("inventory.perpetual", False)
    resp = admin_client.post(
        f"/api/v1/admin/inventory/adjustments?store_id={store.id}",
        json={"ingredient_id": ingredient["id"], "qty_delta": "10", "reason": "x", "authorizer_pin": "9999"},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"


def test_adjustment_requires_valid_admin_pin(
    admin_client: TestClient, store: Store, create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    ingredient = create_ingredient()
    resp = admin_client.post(
        f"/api/v1/admin/inventory/adjustments?store_id={store.id}",
        json={"ingredient_id": ingredient["id"], "qty_delta": "10", "reason": "x", "authorizer_pin": "0000"},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "AUTHORIZATION_INVALID"


def test_adjustment_zero_delta_rejected(
    admin_client: TestClient, store: Store, create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    ingredient = create_ingredient()
    resp = admin_client.post(
        f"/api/v1/admin/inventory/adjustments?store_id={store.id}",
        json={"ingredient_id": ingredient["id"], "qty_delta": "0", "reason": "x", "authorizer_pin": "9999"},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"


def test_adjustment_requires_idempotency_key(
    admin_client: TestClient, store: Store, create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    ingredient = create_ingredient()
    resp = admin_client.post(
        f"/api/v1/admin/inventory/adjustments?store_id={store.id}",
        json={"ingredient_id": ingredient["id"], "qty_delta": "10", "reason": "x", "authorizer_pin": "9999"},
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "IDEMPOTENCY_KEY_REQUIRED"


def test_adjustment_replays_with_same_idempotency_key_without_duplicating(
    admin_client: TestClient, store: Store, create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    ingredient = create_ingredient()
    key = str(uuid4())
    payload = {"ingredient_id": ingredient["id"], "qty_delta": "10", "reason": "x", "authorizer_pin": "9999"}

    first = admin_client.post(
        f"/api/v1/admin/inventory/adjustments?store_id={store.id}", json=payload, headers={"Idempotency-Key": key}
    )
    second = admin_client.post(
        f"/api/v1/admin/inventory/adjustments?store_id={store.id}", json=payload, headers={"Idempotency-Key": key}
    )
    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json() == second.json()

    movements = admin_client.get(f"/api/v1/admin/ingredients/{ingredient['id']}/movements").json()
    assert len(movements) == 1  # no se duplicó el movimiento
