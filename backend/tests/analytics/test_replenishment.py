"""`GET /admin/replenishment` — reposición sugerida y mínimo propuesto por
consumo × lead time del proveedor (`features/fase-3-dinero-control/spec.md
§ 2` tabla T4)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from fastapi.testclient import TestClient

from app.auth.deps import Actor
from app.auth.models import Employee
from app.core import tz as tz_module
from app.inventory import hooks
from app.inventory.models import CostSource, MovementCause
from app.stores.models import Store


def _actor(store: Store, employee: Employee) -> Actor:
    return Actor(
        kind="admin", organization_id=store.organization_id, store_id=store.id,
        employee_id=employee.id, employee_name=employee.name, role=employee.role,
    )


def _business_date(store: Store, at: datetime) -> Any:
    """Nunca `at.date()` (deriva "hoy" en UTC, el error nº1 de
    `docs/CONTEXTO-AGENTES.md §14`): la misma puerta que usa el servidor,
    `app.core.tz.business_date_for`, con el `cutoff_hour` real de la sede."""
    return tz_module.business_date_for(at, store.cutoff_hour)


def test_replenishment_requires_its_dependencies_before_the_store_gate(
    admin_client: TestClient, store: Store, set_feature: Callable[..., None]
) -> None:
    set_feature("catalog.recipes", True)
    set_feature("inventory.perpetual", False)
    set_feature("purchases", True)
    set_feature("inventory.replenishment", True)
    resp = admin_client.get("/api/v1/admin/replenishment", params={"store_id": store.id})
    assert resp.status_code == 400
    body = resp.json()
    assert body["error"]["code"] == "FEATURE_DISABLED"
    assert body["error"]["feature"] == "inventory.perpetual"


def test_replenishment_without_ingredients_is_unavailable_with_a_reason(
    admin_client: TestClient, store: Store, enable_analytics: Callable[[], None]
) -> None:
    enable_analytics()
    resp = admin_client.get("/api/v1/admin/replenishment", params={"store_id": store.id})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["available"] is False
    assert body["reason"]
    assert body["rows"] == []


def test_replenishment_suggests_qty_and_min_from_consumption_times_lead_time(
    db: Any,
    admin_client: TestClient,
    store: Store,
    employees: dict[str, Employee],
    clock: Any,
    enable_analytics: Callable[[], None],
    create_ingredient: Callable[..., dict[str, Any]],
) -> None:
    enable_analytics()
    admin = employees["admin"]
    # min_stock = 500 g, lead_time = 4 días.
    ing = create_ingredient(name="Insumo reposición", min_stock="500", lead_time_days=4)
    day = datetime(2026, 6, 1, tzinfo=timezone.utc)

    # Stock inicial 1.000 g.
    clock.set(day)
    hooks.record_movement(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ing["id"],
        qty_base=1_000_000, cause=MovementCause.PURCHASE, cost_micros=1_000_000, cost_source=CostSource.OFFICIAL,
        actor=_actor(store, admin), business_date=_business_date(store, clock.now()), at=clock.now(),
    )
    # Consumo: 300 g/día durante 10 días (dentro de la ventana de 30 días).
    for i in range(10):
        clock.set(day + timedelta(days=i, hours=1))
        hooks.record_movement(
            db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ing["id"],
            qty_base=-300_000, cause=MovementCause.SALE, cost_micros=1_000_000, cost_source=CostSource.OFFICIAL,
            actor=_actor(store, admin), business_date=_business_date(store, clock.now()), at=clock.now(),
        )
    db.commit()

    resp = admin_client.get("/api/v1/admin/replenishment", params={"store_id": store.id})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["available"] is True
    row = next(r for r in body["rows"] if r["ingredient_id"] == ing["id"])
    # Consumo total: 3.000 g (300 g × 10 días). Informe #17: se divide por
    # los días REALES con historial (el primer movimiento del insumo fue
    # hace 10 días de negocio, hoy incluido), no por 30 fijos: 300 g/día.
    assert row["history_days"] == 10
    assert row["avg_daily_consumption"] == "300"
    assert row["median_daily_consumption"] == "300"
    # Mínimo propuesto: 300 g/día × 4 días de lead time = 1.200 g.
    assert row["suggested_min"] == "1200"
    assert row["lead_time_days"] == 4
    # Stock actual: 1.000 - 3.000 = -2.000 g (negativo: se permite vender
    # aunque el sistema diga que no hay, SPEC-NEGOCIO §5.2). min_stock=500
    # -> reponer 500 - (-2000) = 2500 g para volver al mínimo configurado.
    assert row["current_stock"] == "-2000"
    assert row["suggested_qty"] == "2500"
    assert row["reason"] is None


def test_replenishment_without_lead_time_publishes_null_min_with_a_reason(
    db: Any,
    admin_client: TestClient,
    store: Store,
    employees: dict[str, Employee],
    clock: Any,
    enable_analytics: Callable[[], None],
    create_ingredient: Callable[..., dict[str, Any]],
) -> None:
    enable_analytics()
    admin = employees["admin"]
    ing = create_ingredient(name="Sin lead time", min_stock="10", lead_time_days=None)
    day = datetime(2026, 6, 1, tzinfo=timezone.utc)
    clock.set(day)
    hooks.record_movement(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ing["id"],
        qty_base=-1_000, cause=MovementCause.SALE, cost_micros=1_000_000, cost_source=CostSource.OFFICIAL,
        actor=_actor(store, admin), business_date=_business_date(store, clock.now()), at=clock.now(),
    )
    db.commit()

    resp = admin_client.get("/api/v1/admin/replenishment", params={"store_id": store.id})
    body = resp.json()
    row = next(r for r in body["rows"] if r["ingredient_id"] == ing["id"])
    assert row["suggested_min"] is None, "nunca 0 mudo: sin lead_time_days no hay con qué calcular el mínimo propuesto"
    assert row["reason"]
    assert row["avg_daily_consumption"] is not None  # el consumo SÍ se pudo calcular


def test_replenishment_flags_consumption_untracked_ingredients(
    admin_client: TestClient, store: Store, enable_analytics: Callable[[], None], create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    enable_analytics()
    resp = admin_client.post(
        f"/api/v1/admin/ingredients?store_id={store.id}",
        json={
            "name": "Sal", "category": "Otros", "base_unit": "g", "purchase_unit": "kg", "purchase_factor": 1000,
            "yield_pct": 100, "official_cost": "0.01", "estimated_cost": None, "min_stock": "1000",
            "key_item": False, "consumption_untracked": True, "substitute_ingredient_id": None, "active": True,
            "lead_time_days": 3,
        },
    )
    assert resp.status_code == 201, resp.text
    ing_id = resp.json()["id"]

    body = admin_client.get("/api/v1/admin/replenishment", params={"store_id": store.id}).json()
    row = next(r for r in body["rows"] if r["ingredient_id"] == ing_id)
    assert row["avg_daily_consumption"] is None
    assert row["suggested_min"] is None
    assert "consumption_untracked" in row["reason"]
    # `suggested_qty` sigue siendo un número real (no depende del consumo,
    # sólo de `min_stock` vs `current_stock`), nunca `null`.
    assert row["suggested_qty"] == "1000"


def test_replenishment_median_ignores_a_spike_and_counts_idle_days_as_zero(
    db: Any,
    admin_client: TestClient,
    store: Store,
    employees: dict[str, Employee],
    clock: Any,
    enable_analytics: Callable[[], None],
    create_ingredient: Callable[..., dict[str, Any]],
) -> None:
    """5 días de historia: 100, 100, 0 (sin uso), 100 y un pico de 1.000 g.
    Promedio 1.300 ÷ 5 = 260 g; mediana de [0, 100, 100, 100, 1.000] = 100 g."""
    enable_analytics()
    admin = employees["admin"]
    ing = create_ingredient(name="Insumo con pico", min_stock="10", lead_time_days=2)
    day = datetime(2026, 7, 1, 17, tzinfo=timezone.utc)
    for i, grams in enumerate([100, 100, 0, 100, 1000]):
        clock.set(day + timedelta(days=i))
        if grams:
            hooks.record_movement(
                db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ing["id"],
                qty_base=-grams * 1000, cause=MovementCause.SALE, cost_micros=1_000_000,
                cost_source=CostSource.OFFICIAL, actor=_actor(store, admin),
                business_date=_business_date(store, clock.now()), at=clock.now(),
            )
    db.commit()

    body = admin_client.get("/api/v1/admin/replenishment", params={"store_id": store.id}).json()
    row = next(r for r in body["rows"] if r["ingredient_id"] == ing["id"])
    assert row["history_days"] == 5
    assert row["avg_daily_consumption"] == "260"
    assert row["median_daily_consumption"] == "100"
    assert row["suggested_min"] == "520"  # promedio × 2 días de plazo
