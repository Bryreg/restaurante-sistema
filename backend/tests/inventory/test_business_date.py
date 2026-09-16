"""Fecha operativa de negocio: un movimiento a las 00:30 UTC (antes de la
hora de corte de la sede, `cutoff_hour=6` en el fixture `store`) sella con el
día operativo ANTERIOR, nunca con la fecha calendario de UTC."""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any, Callable
from uuid import uuid4

from fastapi.testclient import TestClient

from app.stores.models import Store


def test_adjustment_at_00_30_bogota_seals_previous_business_day(
    admin_client: TestClient,
    store: Store,
    create_ingredient: Callable[..., dict[str, Any]],
    clock: Any,
) -> None:
    # Bogotá es UTC-5 sin horario de verano: 00:30 hora de Bogotá el día 10
    # es 05:30 UTC del mismo día 10. `cutoff_hour=6`: la hora local (00:30)
    # es ANTERIOR al corte (06:00), así que el día operativo es el 9, no el 10.
    ingredient = create_ingredient()
    clock.set(datetime(2026, 3, 10, 5, 30, tzinfo=timezone.utc))

    resp = admin_client.post(
        f"/api/v1/admin/inventory/adjustments?store_id={store.id}",
        json={"ingredient_id": ingredient["id"], "qty_delta": "10", "reason": "x", "authorizer_pin": "9999"},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert resp.status_code == 201, resp.text

    movements = admin_client.get(f"/api/v1/admin/ingredients/{ingredient['id']}/movements").json()
    assert len(movements) == 1
    assert movements[0]["business_date"] == date(2026, 3, 9).isoformat()


def test_adjustment_after_cutoff_seals_same_calendar_day(
    admin_client: TestClient,
    store: Store,
    create_ingredient: Callable[..., dict[str, Any]],
    clock: Any,
) -> None:
    ingredient = create_ingredient()
    # 10:00 Bogotá (15:00 UTC) es DESPUÉS del corte (06:00): día operativo
    # coincide con la fecha calendario local.
    clock.set(datetime(2026, 3, 10, 15, 0, tzinfo=timezone.utc))

    resp = admin_client.post(
        f"/api/v1/admin/inventory/adjustments?store_id={store.id}",
        json={"ingredient_id": ingredient["id"], "qty_delta": "10", "reason": "x", "authorizer_pin": "9999"},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert resp.status_code == 201, resp.text

    movements = admin_client.get(f"/api/v1/admin/ingredients/{ingredient['id']}/movements").json()
    assert movements[0]["business_date"] == date(2026, 3, 10).isoformat()
