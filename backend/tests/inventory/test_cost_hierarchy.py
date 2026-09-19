"""Los cinco escalones de `resolve_ingredient_cost` (SPEC-NEGOCIO §4.1):

    official -> weighted_average -> last_purchase -> estimated -> none

Un test por escalón, más el que cierra la decisión de arquitectura #2 (el
promedio se deriva desde el ÚLTIMO CONTEO COMPLETO, nunca desde siempre)."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable

from app.auth.deps import Actor
from app.auth.models import Employee
from app.core.quantity import parse_cost_micros
from app.inventory import hooks
from app.inventory.models import (
    CostSource,
    Ingredient,
    MovementCause,
    StockCount,
    StockCountLine,
    StockCountScope,
    StockCountStatus,
)
from app.stores.models import Store


def _actor(store: Store, employee: Employee) -> Actor:
    return Actor(
        kind="admin", organization_id=store.organization_id, store_id=store.id,
        employee_id=employee.id, employee_name=employee.name, role=employee.role,
    )


def _receive(
    db: Any, store: Store, employee: Employee, ingredient_id: int, *, qty_base: int, unit_cost: str, at: datetime
) -> None:
    cost_micros = parse_cost_micros(unit_cost)
    batch = hooks.create_stock_batch(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=qty_base, unit_cost_micros=cost_micros, cost_source=CostSource.OFFICIAL,
        expires_at=None, received_at=at, business_date=at.date(), source_type="test", source_id=at.toordinal(),
    )
    hooks.record_movement(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=qty_base, cause=MovementCause.PURCHASE, cost_micros=cost_micros, cost_source=CostSource.OFFICIAL,
        actor=_actor(store, employee), business_date=at.date(), at=at, ref_type="stock_batch", ref_id=batch.id,
    )


def _apply_full_count(db: Any, store: Store, employee: Employee, at: datetime) -> StockCount:
    """Conteo completo "limpio" (sin diferencias) aplicado en `at`, mismo
    patrón que `app.inventory.seed.seed_counts_and_purchase`: sirve para
    fijar `last_applied_full_count_at` sin depender de la ruta HTTP."""
    count = StockCount(
        organization_id=store.organization_id, store_id=store.id, scope=StockCountScope.FULL,
        status=StockCountStatus.APPLIED, opened_at=at, business_date=at.date(),
        opened_by_employee_id=employee.id, opened_by_employee_name=employee.name,
        applied_at=at, applied_by_employee_id=employee.id, applied_by_employee_name=employee.name,
    )
    db.add(count)
    db.flush()
    db.commit()
    return count


def test_step_1_official_cost_wins_even_with_purchases(
    db: Any, store: Store, employees: dict[str, Employee], create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    ingredient_id = create_ingredient(name="Costo oficial", official_cost="9.5", min_stock="100")["id"]
    now = datetime(2026, 3, 1, tzinfo=timezone.utc)
    _receive(db, store, employees["admin"], ingredient_id, qty_base=1000, unit_cost="50", at=now)

    ingredient = db.get(Ingredient, ingredient_id)
    cost_micros, source = hooks.resolve_ingredient_cost(db, ingredient)
    assert source == CostSource.OFFICIAL
    assert cost_micros == parse_cost_micros("9.5")  # el promedio (50) NO manda


def test_step_2_weighted_average_wins_without_official_cost(
    db: Any, store: Store, employees: dict[str, Employee], create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    ingredient_id = create_ingredient(name="Sin oficial", official_cost=None, min_stock="100")["id"]
    now = datetime(2026, 3, 1, tzinfo=timezone.utc)
    # Dos compras: 1000 @ $10 y 1000 @ $20 -> promedio ponderado $15.
    _receive(db, store, employees["admin"], ingredient_id, qty_base=1000, unit_cost="10", at=now)
    _receive(db, store, employees["admin"], ingredient_id, qty_base=1000, unit_cost="20", at=now + timedelta(hours=1))

    ingredient = db.get(Ingredient, ingredient_id)
    cost_micros, source = hooks.resolve_ingredient_cost(db, ingredient)
    assert source == CostSource.WEIGHTED_AVERAGE
    assert cost_micros == parse_cost_micros("15")


def test_step_3_last_purchase_wins_without_purchases_since_last_full_count(
    db: Any, store: Store, employees: dict[str, Employee], create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    ingredient_id = create_ingredient(name="Última compra", official_cost=None, min_stock="100")["id"]
    now = datetime(2026, 3, 1, tzinfo=timezone.utc)
    _receive(db, store, employees["admin"], ingredient_id, qty_base=1000, unit_cost="12", at=now)
    # El conteo completo se aplica DESPUÉS de la única compra -> el promedio
    # ponderado (que sólo mira compras DESDE el conteo) da `None`, y manda
    # la última compra (que sí mira toda la historia).
    _apply_full_count(db, store, employees["admin"], now + timedelta(days=1))

    ingredient = db.get(Ingredient, ingredient_id)
    assert hooks.weighted_average_cost_micros(db, store_id=store.id, ingredient_id=ingredient_id) is None
    cost_micros, source = hooks.resolve_ingredient_cost(db, ingredient)
    assert source == CostSource.LAST_PURCHASE
    assert cost_micros == parse_cost_micros("12")


def test_step_4_estimated_wins_without_any_purchase_ever(
    db: Any, store: Store, create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    ingredient_id = create_ingredient(
        name="Estimado sin compras", official_cost=None, estimated_cost="3.2", min_stock="100"
    )["id"]
    ingredient = db.get(Ingredient, ingredient_id)
    cost_micros, source = hooks.resolve_ingredient_cost(db, ingredient)
    assert source == CostSource.ESTIMATED
    assert cost_micros == parse_cost_micros("3.2")


def test_step_5_none_is_null_never_zero(db: Any, store: Store, create_ingredient: Callable[..., dict[str, Any]]) -> None:
    ingredient_id = create_ingredient(name="Sin nada", official_cost=None, estimated_cost=None, min_stock="100")["id"]
    ingredient = db.get(Ingredient, ingredient_id)
    cost_micros, source = hooks.resolve_ingredient_cost(db, ingredient)
    assert source == CostSource.NONE
    assert cost_micros is None  # nunca 0


def test_a_purchase_before_the_last_applied_full_count_does_not_move_the_average(
    db: Any, store: Store, employees: dict[str, Employee], create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    ingredient_id = create_ingredient(name="Compra vieja", official_cost=None, min_stock="100")["id"]
    now = datetime(2026, 3, 1, tzinfo=timezone.utc)

    _receive(db, store, employees["admin"], ingredient_id, qty_base=1000, unit_cost="8", at=now)
    _apply_full_count(db, store, employees["admin"], now + timedelta(days=1))
    # Compra NUEVA, después del conteo -- ésta sí tiene que contar.
    _receive(
        db, store, employees["admin"], ingredient_id, qty_base=1000, unit_cost="20", at=now + timedelta(days=2)
    )

    avg = hooks.weighted_average_cost_micros(db, store_id=store.id, ingredient_id=ingredient_id)
    assert avg == parse_cost_micros("20")  # la compra de $8, anterior al conteo, no entra al promedio


def test_weighted_average_uses_all_history_when_no_full_count_ever_applied(
    db: Any, store: Store, employees: dict[str, Employee], create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    ingredient_id = create_ingredient(name="Sin conteo todavía", official_cost=None, min_stock="100")["id"]
    now = datetime(2026, 3, 1, tzinfo=timezone.utc)
    _receive(db, store, employees["admin"], ingredient_id, qty_base=2000, unit_cost="5", at=now)

    assert hooks.last_applied_full_count_at(db, store_id=store.id) is None
    avg = hooks.weighted_average_cost_micros(db, store_id=store.id, ingredient_id=ingredient_id)
    assert avg == parse_cost_micros("5")
