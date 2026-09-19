"""Varianza, food cost real y salud del control (SPEC-NEGOCIO §5.4;
`features/fase-2-costo-inventario/spec.md § Variance, food cost and control
health`). La identidad `inicial + entradas - final = uso real` se prueba con
un caso ARMADO A MANO (no generado), y el semáforo se prueba cambiando el
umbral y viendo cambiar el color."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Callable
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.auth.deps import Actor
from app.auth.models import Employee
from app.core.quantity import parse_cost_micros
from app.inventory import hooks, service
from app.inventory.models import CostSource, MovementCause
from app.stores.models import Store

ADMIN_PIN = "9999"


def _actor(store: Store, employee: Employee) -> Actor:
    return Actor(
        kind="admin", organization_id=store.organization_id, store_id=store.id,
        employee_id=employee.id, employee_name=employee.name, role=employee.role,
    )


def _enable(set_feature: Callable[..., None]) -> None:
    set_feature("catalog.recipes", True)
    set_feature("inventory.perpetual", True)
    set_feature("inventory.counts", True)
    set_feature("inventory.variance", True)


@pytest.fixture()
def variance_ready(set_feature: Callable[..., None]) -> None:
    _enable(set_feature)


def _apply_full_count(
    admin_client: TestClient, store: Store, ingredient_id: int, qty_counted: str
) -> dict[str, Any]:
    opened = admin_client.post(f"/api/v1/admin/counts?store_id={store.id}", json={"scope": "full"}).json()
    admin_client.put(
        f"/api/v1/admin/counts/{opened['id']}/lines?store_id={store.id}",
        json={"lines": [{"ingredient_id": ingredient_id, "qty_counted": qty_counted, "was_counted": True}]},
    )
    applied = admin_client.post(
        f"/api/v1/admin/counts/{opened['id']}/apply?store_id={store.id}",
        json={"authorizer_pin": ADMIN_PIN},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert applied.status_code == 200, applied.text
    return opened


# ---------------------------------------------------------------------------
# La identidad cierra, a mano: inicial + entradas - final = uso real, contra
# el uso teórico (ventas + producción), en cantidad Y en pesos.
# ---------------------------------------------------------------------------


def test_variance_identity_closes_with_a_hand_built_case(
    db: Any, store: Store, admin_client: TestClient, employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]], variance_ready: None, clock: Any,
) -> None:
    ingredient_id = create_ingredient(name="Arroz varianza", official_cost="4", min_stock="10")["id"]
    admin = employees["admin"]
    day = datetime(2026, 5, 1, tzinfo=timezone.utc)

    # Conteo 1: inicial = 100 kg.
    clock.set(day)
    count1 = _apply_full_count(admin_client, store, ingredient_id, "100")

    # Entradas: una compra de 20 kg.
    clock.set(day + timedelta(hours=1))
    hooks.record_movement(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=20_000, cause=MovementCause.PURCHASE, cost_micros=parse_cost_micros("4"),
        cost_source=CostSource.OFFICIAL, actor=_actor(store, admin), business_date=day.date(), at=clock.now(),
    )
    # Uso teórico (ventas): 25 kg.
    clock.set(day + timedelta(hours=2))
    hooks.record_movement(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=-25_000, cause=MovementCause.SALE, cost_micros=parse_cost_micros("4"),
        cost_source=CostSource.OFFICIAL, actor=_actor(store, admin), business_date=day.date(), at=clock.now(),
    )
    db.commit()

    # Conteo 2: final = 92 kg (uso REAL = 100 + 20 - 92 = 28 kg; teórico = 25
    # kg -> varianza = 28 - 25 = 3 kg de más consumidos que lo esperado).
    clock.set(day + timedelta(hours=3))
    count2 = _apply_full_count(admin_client, store, ingredient_id, "92")

    resp = admin_client.get(f"/api/v1/admin/variance?store_id={store.id}&count_id={count2['id']}")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["available"] is True
    assert body["opening_count_id"] == count1["id"]
    row = next(r for r in body["rows"] if r["ingredient_id"] == ingredient_id)

    assert row["opening_qty"] == "100"
    assert row["inflow_qty"] == "20"
    assert row["closing_qty"] == "92"
    assert row["real_usage_qty"] == "28"
    assert row["theoretical_usage_qty"] == "25"
    assert row["variance_qty"] == "3"
    assert row["variance_value"] == 12  # 3 kg * $4/kg = $12
    assert row["cost_source"] == "official"


def test_variance_without_a_previous_applied_count_is_not_available_with_a_reason(
    store: Store, admin_client: TestClient, create_ingredient: Callable[..., dict[str, Any]], variance_ready: None
) -> None:
    ingredient_id = create_ingredient(name="Sin conteo anterior", min_stock="10")["id"]
    count = _apply_full_count(admin_client, store, ingredient_id, "10")
    resp = admin_client.get(f"/api/v1/admin/variance?store_id={store.id}&count_id={count['id']}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["available"] is False
    assert body["reason"]
    assert body["rows"] == []


# ---------------------------------------------------------------------------
# Semáforo desde configuración de sede, nunca hardcodeado: cambiar el umbral
# cambia el color.
# ---------------------------------------------------------------------------


def test_variance_semaphore_color_changes_with_the_configured_threshold(
    db: Any, store: Store, admin_client: TestClient, employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]], variance_ready: None, clock: Any,
) -> None:
    ingredient_id = create_ingredient(name="Semáforo", official_cost="1", min_stock="10")["id"]
    admin = employees["admin"]
    day = datetime(2026, 5, 1, tzinfo=timezone.utc)
    clock.set(day)
    count1 = _apply_full_count(admin_client, store, ingredient_id, "100")

    # Uso teórico: 10 (ventas). Uso real: 100 - 85 = 15 -> varianza = 5,
    # 5/10 = 50% = 5000 bp.
    clock.set(day + timedelta(hours=1))
    hooks.record_movement(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=-10_000, cause=MovementCause.SALE, cost_micros=parse_cost_micros("1"), cost_source=CostSource.OFFICIAL,
        actor=_actor(store, admin), business_date=day.date(), at=clock.now(),
    )
    db.commit()
    clock.set(day + timedelta(hours=2))
    count2 = _apply_full_count(admin_client, store, ingredient_id, "85")

    # Default: amarillo (2%) / rojo (4%) -- 50% es rojo con cualquier default razonable.
    default_resp = admin_client.get(f"/api/v1/admin/variance?store_id={store.id}&count_id={count2['id']}")
    row = next(r for r in default_resp.json()["rows"] if r["ingredient_id"] == ingredient_id)
    assert row["level"] == "red"

    # Subir el umbral rojo muy por encima del 50% -> el mismo caso pasa a verde.
    put_resp = admin_client.put(
        f"/api/v1/admin/stores/{store.id}/inventory-settings",
        json={"variance_yellow_threshold_bp": 8000, "variance_red_threshold_bp": 9000},
    )
    assert put_resp.status_code == 200

    after_resp = admin_client.get(f"/api/v1/admin/variance?store_id={store.id}&count_id={count2['id']}")
    row_after = next(r for r in after_resp.json()["rows"] if r["ingredient_id"] == ingredient_id)
    assert row_after["level"] == "green"
    assert row_after["variance_pct_bp"] == row["variance_pct_bp"]  # el número no cambió, sólo el color


# ---------------------------------------------------------------------------
# RONDA 2, hallazgo H-5: `theoretical == 0` (ninguna venta ni producción en
# la ventana) deja `variance_pct_bp` indefinido, pero no puede pintarse
# siempre verde sin mirar el signo de `variance_qty`.
# ---------------------------------------------------------------------------


def test_variance_semaphore_is_red_when_stock_is_missing_with_zero_theoretical_usage(
    db: Any, store: Store, admin_client: TestClient, employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]], variance_ready: None, clock: Any,
) -> None:
    """400 unidades faltantes sin una sola venta en el período salen en
    rojo, no en verde, y `variance_pct_bp` sigue siendo `null` (el
    porcentaje es matemáticamente indefinido con `theoretical == 0` -- no se
    inventa un `100 %`). Antes de este hallazgo, `theoretical == 0` daba
    siempre verde sin mirar `variance_qty` en absoluto."""
    ingredient_id = create_ingredient(name="Fuga sin ventas", official_cost="2", min_stock="10")["id"]
    day = datetime(2026, 7, 1, tzinfo=timezone.utc)

    clock.set(day)
    _apply_full_count(admin_client, store, ingredient_id, "400")
    # Sin compras, sin ventas, sin producción en el medio -- ni una sola
    # causa que explique la baja: uso teórico = 0, pero el stock físico
    # desapareció igual.
    clock.set(day + timedelta(hours=1))
    count2 = _apply_full_count(admin_client, store, ingredient_id, "0")

    resp = admin_client.get(f"/api/v1/admin/variance?store_id={store.id}&count_id={count2['id']}")
    assert resp.status_code == 200, resp.text
    row = next(r for r in resp.json()["rows"] if r["ingredient_id"] == ingredient_id)

    assert row["theoretical_usage_qty"] == "0"
    assert row["real_usage_qty"] == "400"
    assert row["variance_qty"] == "400"
    assert row["variance_pct_bp"] is None, "el porcentaje sigue indefinido -- nunca un 100% inventado"
    assert row["level"] == "red", "400 unidades faltantes sin una sola venta tienen que salir en rojo, no verde"


def test_inventory_settings_defaults_and_validation(
    store: Store, admin_client: TestClient, variance_ready: None
) -> None:
    resp = admin_client.get(f"/api/v1/admin/stores/{store.id}/inventory-settings")
    assert resp.status_code == 200
    body = resp.json()
    assert body["variance_yellow_threshold_bp"] == 200
    assert body["variance_red_threshold_bp"] == 400

    bad = admin_client.put(
        f"/api/v1/admin/stores/{store.id}/inventory-settings",
        json={"variance_yellow_threshold_bp": 500, "variance_red_threshold_bp": 100},
    )
    assert bad.status_code == 400


# ---------------------------------------------------------------------------
# Food cost real: sólo entre dos conteos completos consecutivos; `null` con
# motivo sin ellos, jamás `0`.
# ---------------------------------------------------------------------------


def test_food_cost_is_null_with_a_reason_without_two_full_counts(
    store: Store, admin_client: TestClient, variance_ready: None
) -> None:
    resp = admin_client.get(f"/api/v1/admin/food-cost?store_id={store.id}&from=2026-01-01&to=2026-12-31")
    assert resp.status_code == 200
    body = resp.json()
    assert body["available"] is False
    assert body["pct_bp"] is None
    assert body["reason"]


def test_food_cost_is_computed_between_two_consecutive_full_counts(
    db: Any, store: Store, admin_client: TestClient, employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]], variance_ready: None, clock: Any,
) -> None:
    ingredient_id = create_ingredient(name="Food cost insumo", official_cost="10", min_stock="10")["id"]
    admin = employees["admin"]
    day = datetime(2026, 6, 1, tzinfo=timezone.utc)

    clock.set(day)
    count1 = _apply_full_count(admin_client, store, ingredient_id, "50")  # inicial: 50 kg @ $10 = $500
    clock.set(day + timedelta(hours=1))
    hooks.record_movement(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=10_000, cause=MovementCause.PURCHASE, cost_micros=parse_cost_micros("10"), cost_source=CostSource.OFFICIAL,
        actor=_actor(store, admin), business_date=day.date(), at=clock.now(),
    )
    db.commit()
    clock.set(day + timedelta(hours=2))
    count2 = _apply_full_count(admin_client, store, ingredient_id, "40")  # final: 40 kg @ $10 = $400

    resp = admin_client.get(f"/api/v1/admin/food-cost?store_id={store.id}&from=2020-01-01&to=2030-01-01")
    assert resp.status_code == 200
    body = resp.json()
    # Los DOS conteos completos consecutivos existen y se valorizan bien
    # ((500 + 100 - 400) = $200 de costo de insumo consumido) — eso es lo
    # que este test prueba. Pero sin una venta fiscal real registrada en el
    # período, `net_sales` es 0, y dividir por ventas en 0 es exactamente el
    # otro caso `null con motivo` que la spec pide (nunca `0` disfrazado de
    # porcentaje): `available=False` acá es CORRECTO, no un fallback.
    assert body["opening_count_id"] == count1["id"]
    assert body["closing_count_id"] == count2["id"]
    assert body["opening_value"] == 500
    assert body["purchases_value"] == 100
    assert body["closing_value"] == 400
    assert body["net_sales"] == 0
    assert body["pct_bp"] is None
    assert body["available"] is False
    assert "venta" in body["reason"].lower()


# ---------------------------------------------------------------------------
# Salud del control: > 14 días sin conteo completo -> inventario no
# confiable, y el food cost real no se publica.
# ---------------------------------------------------------------------------


def test_control_health_flags_unreliable_past_14_days_without_a_full_count(
    db: Any, store: Store, admin_client: TestClient, employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]], variance_ready: None, clock: Any,
) -> None:
    ingredient_id = create_ingredient(name="Salud del control", min_stock="10")["id"]

    old_at = clock.now() - timedelta(days=20)
    from app.inventory.models import StockCount, StockCountScope, StockCountStatus

    old_count = StockCount(
        organization_id=store.organization_id, store_id=store.id, scope=StockCountScope.FULL,
        status=StockCountStatus.APPLIED, opened_at=old_at, business_date=old_at.date(),
        opened_by_employee_id=employees["admin"].id, opened_by_employee_name=employees["admin"].name,
        applied_at=old_at, applied_by_employee_id=employees["admin"].id, applied_by_employee_name=employees["admin"].name,
    )
    db.add(old_count)
    db.commit()

    health = admin_client.get(f"/api/v1/admin/control-health?store_id={store.id}")
    assert health.status_code == 200
    body = health.json()
    assert body["days_since_full_count"] == 20
    assert body["inventory_unreliable"] is True

    food_cost = admin_client.get(f"/api/v1/admin/food-cost?store_id={store.id}&from=2020-01-01&to=2030-01-01")
    fc_body = food_cost.json()
    assert fc_body["available"] is False
    assert "no confiable" in fc_body["reason"].lower() or "14" in fc_body["reason"]
    assert fc_body["pct_bp"] is None


def test_food_cost_percentage_rounds_half_up_in_basis_points() -> None:
    """Aritmética pura del `pct_bp` (la misma fórmula que usa
    `service.food_cost_report`, aislada de la base): `food_cost_pesos * 10000
    ÷ net_sales`, redondeo half-up, sin `float`. $250 de costo sobre $1.000
    de ventas netas = 25,00 % = 2500 bp exacto; $1 de costo sobre $3 de
    ventas = 33,333...% -> 3333 bp (trunca hacia el más cercano, no hacia
    arriba mecánicamente)."""
    food_cost_pesos, net_sales = 250, 1000
    pct_bp = (abs(food_cost_pesos) * 10000 + net_sales // 2) // net_sales
    assert pct_bp == 2500

    food_cost_pesos, net_sales = 1, 3
    pct_bp = (abs(food_cost_pesos) * 10000 + net_sales // 2) // net_sales
    assert pct_bp == 3333


def test_control_health_with_no_full_count_ever_is_unreliable(
    store: Store, admin_client: TestClient, variance_ready: None
) -> None:
    resp = admin_client.get(f"/api/v1/admin/control-health?store_id={store.id}")
    body = resp.json()
    assert body["days_since_full_count"] is None
    assert body["last_full_count_at"] is None
    assert body["inventory_unreliable"] is True


# ---------------------------------------------------------------------------
# Flags.
# ---------------------------------------------------------------------------


def test_variance_requires_the_flag_and_respects_dependency_on_counts(
    admin_client: TestClient, store: Store, set_feature: Callable[..., None]
) -> None:
    set_feature("inventory.perpetual", True)
    set_feature("inventory.counts", True)
    set_feature("inventory.variance", False)
    resp = admin_client.get(f"/api/v1/admin/food-cost?store_id={store.id}&from=2026-01-01&to=2026-01-31")
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
