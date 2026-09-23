"""El KPI de mermas ÷ compras (SPEC-NEGOCIO §5.5). Deuda cerrada en 2b
(`outputs-2a/ENTREGA.md § 5`, O-6): `WasteKpiOut.ratio` deja de ser `float`
y deja de ser siempre `null` -- ahora se llena con compras que salen del
LIBRO (`cause=purchase`), nunca importando `purchases`."""

from __future__ import annotations

import typing
from datetime import datetime, timezone
from typing import Any, Callable
from uuid import uuid4

from fastapi.testclient import TestClient

from app.auth.deps import Actor
from app.auth.models import Employee
from app.core import tz
from app.inventory import schemas
from app.inventory.models import CostSource, MovementCause
from app.inventory import hooks
from app.stores.models import Store


def _actor(store: Store, employee: Employee) -> Actor:
    return Actor(
        kind="admin", organization_id=store.organization_id, store_id=store.id,
        employee_id=employee.id, employee_name=employee.name, role=employee.role,
    )


def test_waste_kpi_ratio_is_never_declared_as_float() -> None:
    annotation = schemas.WasteKpiOut.model_fields["ratio"].annotation
    args = set(typing.get_args(annotation))
    assert float not in args
    assert annotation is not float
    assert args == {int, type(None)} or annotation is int


def test_waste_kpi_is_null_with_a_reason_without_purchases_in_the_week(
    db: Any, store: Store, admin_client: TestClient, employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]], set_feature: Callable[..., None],
) -> None:
    set_feature("inventory.perpetual", True)
    set_feature("inventory.waste", True)
    ingredient_id = create_ingredient(name="Merma sin compras", official_cost="4", min_stock="10")["id"]
    now = datetime(2026, 5, 5, tzinfo=timezone.utc)
    hooks.record_movement(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=-1_000, cause=MovementCause.WASTE, cost_micros=4_000_000, cost_source=CostSource.OFFICIAL,
        actor=_actor(store, employees["admin"]), business_date=now.date(), at=now,
    )
    db.commit()

    resp = admin_client.get(f"/api/v1/admin/waste?store_id={store.id}")
    assert resp.status_code == 200
    kpi = resp.json()["weekly_kpi"]
    assert kpi["ratio"] is None
    assert kpi["label"]


def test_waste_kpi_stops_being_null_once_there_are_purchases_in_the_week(
    db: Any, store: Store, admin_client: TestClient, device_client: TestClient, employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]], set_feature: Callable[..., None], clock: Any,
    identify: Callable[..., Any],
) -> None:
    set_feature("inventory.perpetual", True)
    set_feature("inventory.waste", True)
    ingredient_id = create_ingredient(name="Merma con compras", official_cost="4", min_stock="10")["id"]
    now = datetime(2026, 5, 5, 12, tzinfo=timezone.utc)
    clock.set(now)
    admin = employees["admin"]
    # Misma fecha de negocio que va a usar el router (`GET /admin/waste`
    # deriva "hoy" con `tz.today_business_date`) -- mediodía UTC para que no
    # quede a un lado del corte de las 06:00 locales de Bogotá.
    business_date = tz.today_business_date(store.cutoff_hour)

    # Compra de $1.000 (100 unidades a $10), que sale del LIBRO.
    hooks.record_movement(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=100_000, cause=MovementCause.PURCHASE, cost_micros=10_000_000, cost_source=CostSource.OFFICIAL,
        actor=_actor(store, admin), business_date=business_date, at=now,
    )
    db.commit()

    identify(device_client, employees["operator"])

    # Merma de $40 (10 unidades a $4, el costo oficial del insumo), por la
    # ruta real de dispositivo -- `Waste`, no un `StockMovement` a mano.
    waste_resp = device_client.post(
        "/api/v1/waste",
        json={"ingredient_id": ingredient_id, "qty": "10", "type": "breakage", "employee_pin": "9999"},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert waste_resp.status_code == 201, waste_resp.text

    resp = admin_client.get(f"/api/v1/admin/waste?store_id={store.id}")
    assert resp.status_code == 200
    kpi = resp.json()["weekly_kpi"]
    # $40 / $1.000 = 4 % = 400 puntos básicos.
    assert kpi["ratio"] == 400
    assert isinstance(kpi["ratio"], int)
    # Informe de visualización, #14: el texto sale en es-CO («4,0 %», coma
    # decimal y espacio fino), nunca «4.00 %» con punto inglés.
    assert kpi["label"] == "4,0 % de las compras de la semana"


def test_waste_kpi_label_uses_colombian_percent_format() -> None:
    from app.core.percent import format_pct_bp

    assert format_pct_bp(1234) == "12,3 %"
    assert format_pct_bp(1250) == "12,5 %"
    assert format_pct_bp(5) == "0,1 %"
    assert format_pct_bp(123456) == "1.234,6 %"
