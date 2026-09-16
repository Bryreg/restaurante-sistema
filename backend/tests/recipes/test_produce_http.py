"""Producción rápida por HTTP (`POST /preparations/{id}/produce`, ruta de
dispositivo) y cambio de modo (`PATCH /admin/preparations/{id}/mode`):
`Idempotency-Key`, `409` en carrera, `400 PREP_NOT_BATCH`, alerta de
varianza > 15 %, y cierre de lotes abiertos con PIN de administrador.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

API = "/api/v1"


def _create_preparation(admin_client: TestClient, store_id: int, **overrides: Any) -> dict[str, Any]:
    payload = {
        "name": "Preparación HTTP",
        "mode": "batch",
        "standard_yield_qty": "1000",
        "standard_yield_unit": "g",
        "lines": [],
    }
    payload.update(overrides)
    resp = admin_client.post(f"{API}/admin/preparations", params={"store_id": store_id}, json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_produce_with_same_idempotency_key_does_not_duplicate(
    db: Session, store: Any, admin_client: TestClient, device_client: TestClient, identify: Any,
    employees: dict[str, Any], make_ingredient: Any,
) -> None:
    ing = make_ingredient("Insumo (idempotencia)")
    prep = _create_preparation(
        admin_client, store.id, name="Prep idempotente",
        lines=[{"ingredient_id": ing.id, "qty": "500", "unit": "g"}],
    )
    identify(device_client, employees["cashier"])  # PIN "1111"
    key = str(uuid4())
    body = {"qty_expected": "1000", "qty_real": "1000", "employee_pin": "1111"}

    first = device_client.post(f"{API}/preparations/{prep['id']}/produce", json=body, headers={"Idempotency-Key": key})
    assert first.status_code == 201, first.text
    second = device_client.post(f"{API}/preparations/{prep['id']}/produce", json=body, headers={"Idempotency-Key": key})
    assert second.status_code == 201
    assert second.json()["id"] == first.json()["id"]  # mismo lote, no uno nuevo

    batches = admin_client.get(f"{API}/admin/preparations/{prep['id']}/batches")
    assert batches.status_code == 200
    assert len(batches.json()) == 1


def test_produce_on_exploded_preparation_is_400_prep_not_batch(
    db: Session, store: Any, admin_client: TestClient, device_client: TestClient, identify: Any,
    employees: dict[str, Any], make_ingredient: Any,
) -> None:
    ing = make_ingredient("Insumo (exploded no produce)")
    prep = _create_preparation(
        admin_client, store.id, name="Prep exploded (no produce)", mode="exploded",
        lines=[{"ingredient_id": ing.id, "qty": "500", "unit": "g"}],
    )
    identify(device_client, employees["cashier"])
    resp = device_client.post(
        f"{API}/preparations/{prep['id']}/produce",
        json={"qty_expected": "1000", "qty_real": "1000", "employee_pin": "1111"},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "PREP_NOT_BATCH"


def test_produce_variance_over_15_percent_is_flagged(
    db: Session, store: Any, admin_client: TestClient, device_client: TestClient, identify: Any,
    employees: dict[str, Any], make_ingredient: Any,
) -> None:
    ing = make_ingredient("Insumo (varianza)")
    prep = _create_preparation(
        admin_client, store.id, name="Prep con varianza",
        lines=[{"ingredient_id": ing.id, "qty": "500", "unit": "g"}],
    )
    identify(device_client, employees["cashier"])
    resp = device_client.post(
        f"{API}/preparations/{prep['id']}/produce",
        json={"qty_expected": "1000", "qty_real": "800", "employee_pin": "1111"},  # 20 % menos
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["variance_alert"] is True
    assert "cost" not in " ".join(body.keys()).lower()
    assert "margin" not in " ".join(body.keys()).lower()


def test_mode_switch_closes_open_batches_and_requires_authorizer_pin(
    db: Session, store: Any, admin_client: TestClient, device_client: TestClient, identify: Any,
    employees: dict[str, Any], make_ingredient: Any,
) -> None:
    ing = make_ingredient("Insumo (cierre de lotes)")
    prep = _create_preparation(
        admin_client, store.id, name="Prep a cerrar",
        lines=[{"ingredient_id": ing.id, "qty": "500", "unit": "g"}],
    )
    identify(device_client, employees["cashier"])
    produced = device_client.post(
        f"{API}/preparations/{prep['id']}/produce",
        json={"qty_expected": "1000", "qty_real": "1000", "employee_pin": "1111"},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert produced.status_code == 201, produced.text

    without_pin = admin_client.patch(f"{API}/admin/preparations/{prep['id']}/mode", json={"mode": "exploded"})
    assert without_pin.status_code == 400
    assert without_pin.json()["error"]["code"] == "AUTHORIZATION_REQUIRED"

    switched = admin_client.patch(
        f"{API}/admin/preparations/{prep['id']}/mode", json={"mode": "exploded", "authorizer_pin": "9999"}
    )
    assert switched.status_code == 200, switched.text
    assert switched.json()["mode"] == "exploded"

    batches = admin_client.get(f"{API}/admin/preparations/{prep['id']}/batches").json()
    assert len(batches) == 1
    assert batches[0]["closed_at"] is not None
    assert batches[0]["closed_reason"] is not None

    # El intento de producir de nuevo ya no tiene sentido: es "exploded".
    again = device_client.post(
        f"{API}/preparations/{prep['id']}/produce",
        json={"qty_expected": "1000", "qty_real": "1000", "employee_pin": "1111"},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert again.status_code == 400
    assert again.json()["error"]["code"] == "PREP_NOT_BATCH"


def test_feature_disabled_blocks_preparations_endpoints(
    db: Session, store: Any, admin_client: TestClient, set_feature: Any
) -> None:
    set_feature("catalog.preps", False)
    resp = admin_client.get(f"{API}/admin/preparations", params={"store_id": store.id})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"

    set_feature("catalog.preps", True)
    ok = admin_client.get(f"{API}/admin/preparations", params={"store_id": store.id})
    assert ok.status_code == 200
