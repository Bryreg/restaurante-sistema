"""Merma en la unidad cómoda (`WasteIn.entry_unit`): el POS teclea «0,8» kg
de lomo y el servidor convierte a 800 g — nunca la pantalla. Sin
`entry_unit`, `qty` sigue siendo unidad base (compatibilidad)."""

from __future__ import annotations

from typing import Any, Callable
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.auth.models import Employee
from app.inventory import hooks
from app.inventory.models import Waste
from app.stores.models import Store


def _post(device_client: TestClient, **body: Any) -> Any:
    return device_client.post(
        "/api/v1/waste",
        json={"type": "breakage", "employee_pin": "2222", **body},
        headers={"Idempotency-Key": str(uuid4())},
    )


def test_device_ingredients_carry_the_comfortable_unit(
    device_client: TestClient, create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    create_ingredient(name="Lomo", base_unit="g", purchase_unit="kg", purchase_factor=1000)
    create_ingredient(name="Ron", base_unit="ml", purchase_unit="botella", purchase_factor=750)
    create_ingredient(name="Huevos", base_unit="unit", purchase_unit="panal", purchase_factor=30)
    rows = {r["name"]: r for r in device_client.get("/api/v1/device/ingredients").json()}
    assert (rows["Lomo"]["entry_mode"], rows["Lomo"]["entry_unit"]) == ("weight", "kg")
    assert (rows["Ron"]["entry_mode"], rows["Ron"]["entry_unit"]) == ("bottle", "botella")
    assert (rows["Huevos"]["entry_mode"], rows["Huevos"]["entry_unit"]) == ("unit", "unidad")


def test_waste_in_kg_is_converted_by_the_server(
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]],
    db: Session,
    store: Store,
) -> None:
    lomo = create_ingredient(name="Lomo", base_unit="g", purchase_unit="kg", purchase_factor=1000)
    identify(device_client, employees["operator"])

    resp = _post(device_client, ingredient_id=lomo["id"], qty="0,8", entry_unit="kg")
    assert resp.status_code == 201, resp.text
    assert resp.json()["qty"] == "800"  # la salida va en unidad base
    assert hooks.current_stock(db, store_id=store.id, ingredient_id=lomo["id"]) == -800_000


def test_waste_in_bottles_uses_the_purchase_factor(
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]],
    db: Session,
    store: Store,
) -> None:
    ron = create_ingredient(name="Ron", base_unit="ml", purchase_unit="botella", purchase_factor=750)
    identify(device_client, employees["operator"])

    resp = _post(device_client, ingredient_id=ron["id"], qty="1.2", entry_unit="botella")
    assert resp.status_code == 201, resp.text
    assert hooks.current_stock(db, store_id=store.id, ingredient_id=ron["id"]) == -900_000


def test_waste_without_entry_unit_stays_in_base_unit(
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]],
    db: Session,
    store: Store,
) -> None:
    lomo = create_ingredient(name="Lomo", base_unit="g", purchase_unit="kg", purchase_factor=1000)
    identify(device_client, employees["operator"])
    assert _post(device_client, ingredient_id=lomo["id"], qty="800").status_code == 201
    assert hooks.current_stock(db, store_id=store.id, ingredient_id=lomo["id"]) == -800_000


def test_a_stale_entry_unit_is_rejected_before_writing(
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]],
    db: Session,
    store: Store,
) -> None:
    lomo = create_ingredient(name="Lomo", base_unit="g", purchase_unit="kg", purchase_factor=1000)
    identify(device_client, employees["operator"])

    resp = _post(device_client, ingredient_id=lomo["id"], qty="0.8", entry_unit="botella")
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"
    assert db.query(Waste).count() == 0
    assert hooks.current_stock(db, store_id=store.id, ingredient_id=lomo["id"]) == 0
