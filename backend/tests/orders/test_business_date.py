"""`business_date_for_sale`: la fecha operativa de la venta (SPEC-NEGOCIO
§3.1) sigue la hora de corte de la sede, nunca se deriva de UTC directo."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi.testclient import TestClient


def test_sale_at_0030_falls_on_shift_business_day(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, clock: Any, store: Any) -> None:
    # Corte 06:00 (default de `store`): un turno abierto el 15 sigue siendo
    # "día operativo 15" a la 00:30 del 16 (madrugada del mismo servicio).
    clock.set(datetime(2026, 1, 15, 20, 0, tzinfo=timezone.utc))  # 15:00 Bogotá
    shift = open_shift()

    clock.advance(hours=5, minutes=30)  # ~00:30 Bogotá del día 16
    # Identificarse DESPUÉS de mover el reloj: la ventana deslizante de la
    # persona (`EMPLOYEE_SESSION_MINUTES`) es corta y no debe expirar antes
    # de crear la comanda.
    identify(device_client, employees["operator"])
    order = new_order().json()
    assert order["business_date"] == "2026-01-15"
    assert order["shift_id"] == shift["id"]


def test_sale_past_cutoff_on_stale_shift_seals_with_today(device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, clock: Any, store: Any) -> None:
    clock.set(datetime(2026, 1, 15, 15, 0, tzinfo=timezone.utc))  # 10:00 Bogotá del 15
    open_shift()

    # Turno abandonado: pasa la hora de corte (06:00) del día SIGUIENTE (16).
    clock.advance(days=2)  # ~10:00 Bogotá del 17: ya pasó el corte del 16
    identify(device_client, employees["operator"])
    order = new_order().json()
    assert order["business_date"] == "2026-01-17"


def test_platform_order_at_0030_seals_with_the_shift_business_day(
    device_client: TestClient, identify: Any, employees: Any, open_shift: Any, new_order: Any, clock: Any, store: Any, platform: Any,
) -> None:
    """Pedido 2c, checklist de la spec: "un pedido de plataforma cargado a
    las 00:30 queda sellado con el día del turno". `business_date_for_sale`
    (`app.orders.service`) no mira el canal — este test lo confirma desde el
    lado del canal nuevo, mismo escenario que
    `test_sale_at_0030_falls_on_shift_business_day` arriba."""
    clock.set(datetime(2026, 1, 15, 20, 0, tzinfo=timezone.utc))  # 15:00 Bogotá
    shift = open_shift()

    clock.advance(hours=5, minutes=30)  # ~00:30 Bogotá del día 16
    identify(device_client, employees["operator"])
    order = new_order(channel="platform", platform={"platform_id": platform.id, "external_id": "RAPPI-0030"}).json()
    assert order["business_date"] == "2026-01-15"
    assert order["shift_id"] == shift["id"]
