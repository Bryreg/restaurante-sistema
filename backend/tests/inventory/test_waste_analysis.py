"""Tanda 5, i6: análisis de mermas del período.

`GET /admin/waste/analysis` — por motivo, por insumo y por persona, en plata
al costo congelado de cada merma. Las salidas explicadas (consumo interno,
traslado) no son pérdida; una merma sin costo no suma $0 a escondidas."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable
from uuid import uuid4

from fastapi.testclient import TestClient

from app.auth.models import Employee
from app.stores.models import Store

API = "/api/v1"


def _waste(client: TestClient, ingredient_id: int, qty: str, type_: str, pin: str, **extra: Any) -> None:
    resp = client.post(
        f"{API}/waste",
        json={"ingredient_id": ingredient_id, "qty": qty, "type": type_, "employee_pin": pin, **extra},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert resp.status_code == 201, resp.text


def _analysis(client: TestClient, store: Store, date_from: str = "2026-01-01", date_to: str = "2026-01-31") -> Any:
    return client.get(f"{API}/admin/waste/analysis?store_id={store.id}&from={date_from}&to={date_to}")


def test_waste_is_broken_down_by_reason_ingredient_and_person_at_cost(
    admin_client: TestClient,
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Employee],
    enable_inventory: Callable[[], None],
    create_ingredient: Callable[..., dict[str, Any]],
    clock: Any,
    store: Store,
) -> None:
    enable_inventory()
    clock.set(datetime(2026, 1, 15, 15, 0, tzinfo=timezone.utc))
    carne = create_ingredient(name="Carne", official_cost="30")  # $30 por g
    leche = create_ingredient(name="Leche", base_unit="ml", purchase_unit="L", official_cost="4")
    sin_costo = create_ingredient(name="Hierbas", official_cost=None)
    identify(device_client, employees["operator"])

    _waste(device_client, carne["id"], "100", "expired", "2222")  # $3.000, Operator
    _waste(device_client, carne["id"], "50", "kitchen_error", "3333")  # $1.500, Operator2
    _waste(device_client, leche["id"], "250", "breakage", "2222")  # $1.000, Operator
    _waste(device_client, sin_costo["id"], "10", "expired", "3333")  # sin costo
    # Salida explicada: no es pérdida.
    _waste(device_client, carne["id"], "200", "internal_use", "2222", consumer_name="dueño")

    resp = _analysis(admin_client, store)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["entries"] == 4
    assert body["uncosted_entries"] == 1
    assert body["cost"] == 5_500

    reasons = {r["type"]: r for r in body["by_reason"]}
    assert reasons["expired"]["cost"] == 3_000 and reasons["expired"]["uncosted_entries"] == 1
    assert reasons["kitchen_error"]["cost"] == 1_500
    assert reasons["internal_use"]["loss"] is False
    assert reasons["internal_use"]["share_bp"] is None
    # Primero las pérdidas, de la más cara a la más barata.
    assert [r["type"] for r in body["by_reason"]] == ["expired", "kitchen_error", "breakage", "internal_use"]

    items = {i["name"]: i for i in body["by_ingredient"]}
    assert items["Carne"]["cost"] == 4_500  # sin el consumo interno
    assert items["Carne"]["qty"] == "150"
    assert items["Carne"]["share_bp"] == 8182  # 4.500 / 5.500
    # Ninguna merma de hierbas tiene costo: null, no $0.
    assert items["Hierbas"]["cost"] is None
    assert items["Hierbas"]["share_bp"] is None

    people = {p["employee_name"]: p for p in body["by_person"]}
    assert people["Operator"]["cost"] == 4_000
    assert people["Operator2"]["cost"] == 1_500
    assert people["Operator2"]["uncosted_entries"] == 1


def test_only_the_period_counts_and_empty_is_a_real_zero(
    admin_client: TestClient,
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Employee],
    enable_inventory: Callable[[], None],
    create_ingredient: Callable[..., dict[str, Any]],
    clock: Any,
    store: Store,
) -> None:
    enable_inventory()
    clock.set(datetime(2026, 1, 15, 15, 0, tzinfo=timezone.utc))
    carne = create_ingredient(name="Carne", official_cost="30")
    identify(device_client, employees["operator"])
    _waste(device_client, carne["id"], "100", "expired", "2222")

    body = _analysis(admin_client, store, "2026-02-01", "2026-02-28").json()
    assert body["entries"] == 0
    assert body["cost"] == 0
    assert body["by_ingredient"] == []
    bad = _analysis(admin_client, store, "2026-02-28", "2026-02-01")
    assert bad.status_code == 400


def test_analysis_is_admin_only_and_behind_the_waste_flag(
    admin_client: TestClient,
    device_client: TestClient,
    enable_inventory: Callable[[], None],
    set_feature: Callable[..., None],
    store: Store,
) -> None:
    enable_inventory()
    assert _analysis(device_client, store).status_code in (401, 403)
    set_feature("inventory.waste", False)
    off = _analysis(admin_client, store)
    assert off.status_code == 400
    assert off.json()["error"]["code"] == "FEATURE_DISABLED"
    set_feature("inventory.waste", True)
    csv = admin_client.get(f"{API}/admin/waste/analysis?store_id={store.id}&from=2026-01-01&to=2026-01-31&format=csv")
    assert csv.status_code == 200
    assert "text/csv" in csv.headers["content-type"]
