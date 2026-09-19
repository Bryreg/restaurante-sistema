"""Lotes y vencimientos (SPEC-NEGOCIO §5.7; `features/fase-2-costo-inventario/
spec.md § Lots and expiry`). El FEFO se prueba en dos capas: `hooks.
consume_lots_fefo` directo (el contrato vinculante que `purchases`/`orders`/
`recipes` disparan indirectamente vía `record_movement`) y `record_movement`
en sí (la integración -- decisión de arquitectura #3: el FEFO vive DENTRO de
`record_movement`, no en cada llamador)."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable

import pytest
from fastapi.testclient import TestClient

from app.auth.deps import Actor
from app.auth.models import Employee
from app.core.errors import AppError
from app.inventory import hooks, service
from app.inventory.models import CostSource, MovementCause
from app.stores.models import Store


def _actor(store: Store, employee: Employee) -> Actor:
    return Actor(
        kind="admin",
        organization_id=store.organization_id,
        store_id=store.id,
        employee_id=employee.id,
        employee_name=employee.name,
        role=employee.role,
    )


# ---------------------------------------------------------------------------
# FEFO declarado: vencimiento primero, recepción para desempatar, sin
# vencimiento al final. Test con TRES lotes (pedido explícito de la misión).
# ---------------------------------------------------------------------------


def test_fefo_consumes_nearest_expiry_first_then_received_first_then_no_expiry_last(
    db: Any, store: Store, employees: dict[str, Employee], create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    ingredient_id = create_ingredient(name="Tomate FEFO", min_stock="100")["id"]
    base_at = datetime(2026, 2, 1, 12, 0, tzinfo=timezone.utc)

    # A: vence el 10, recibido PRIMERO de los tres.
    batch_a = hooks.create_stock_batch(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=1000, unit_cost_micros=1_000_000, cost_source=CostSource.OFFICIAL,
        expires_at=date(2026, 2, 10), received_at=base_at, business_date=base_at.date(),
        source_type="test", source_id=1,
    )
    # B: vence el 5 -- ANTES que A -- pero se recibe DESPUÉS. FEFO manda
    # vencimiento por sobre orden de recepción: B tiene que salir primero.
    batch_b = hooks.create_stock_batch(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=1000, unit_cost_micros=1_000_000, cost_source=CostSource.OFFICIAL,
        expires_at=date(2026, 2, 5), received_at=base_at + timedelta(hours=2), business_date=base_at.date(),
        source_type="test", source_id=2,
    )
    # C: SIN vencimiento, recibido antes que los otros dos -- tiene que
    # consumirse ÚLTIMO igual: "nunca vence" no es "va primero".
    batch_c = hooks.create_stock_batch(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=1000, unit_cost_micros=1_000_000, cost_source=CostSource.OFFICIAL,
        expires_at=None, received_at=base_at - timedelta(hours=2), business_date=base_at.date(),
        source_type="test", source_id=3,
    )
    db.commit()

    taken = hooks.consume_lots_fefo(db, store_id=store.id, ingredient_id=ingredient_id, qty_base=2500)

    assert [b.id for b, _ in taken] == [batch_b.id, batch_a.id, batch_c.id]
    assert [q for _, q in taken] == [1000, 1000, 500]
    db.refresh(batch_a)
    db.refresh(batch_b)
    db.refresh(batch_c)
    assert batch_b.qty_remaining == 0
    assert batch_a.qty_remaining == 0
    assert batch_c.qty_remaining == 500


def test_fefo_tie_at_equal_expiry_breaks_by_received_first(
    db: Any, store: Store, create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    ingredient_id = create_ingredient(name="Queso FEFO empate", min_stock="100")["id"]
    same_day = date(2026, 3, 1)
    base_at = datetime(2026, 2, 20, 8, 0, tzinfo=timezone.utc)

    later = hooks.create_stock_batch(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=500, unit_cost_micros=1_000_000, cost_source=CostSource.OFFICIAL,
        expires_at=same_day, received_at=base_at + timedelta(hours=5), business_date=base_at.date(),
        source_type="test", source_id=10,
    )
    earlier = hooks.create_stock_batch(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=500, unit_cost_micros=1_000_000, cost_source=CostSource.OFFICIAL,
        expires_at=same_day, received_at=base_at, business_date=base_at.date(),
        source_type="test", source_id=11,
    )
    db.commit()

    taken = hooks.consume_lots_fefo(db, store_id=store.id, ingredient_id=ingredient_id, qty_base=600)
    assert [b.id for b, _ in taken] == [earlier.id, later.id]


def test_consume_lots_fefo_never_blocks_when_not_enough_stock(
    db: Any, store: Store, create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    ingredient_id = create_ingredient(name="Cebolla FEFO corto", min_stock="100")["id"]
    now = datetime(2026, 2, 1, tzinfo=timezone.utc)
    batch = hooks.create_stock_batch(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=300, unit_cost_micros=1_000_000, cost_source=CostSource.OFFICIAL,
        expires_at=None, received_at=now, business_date=now.date(), source_type="test", source_id=20,
    )
    db.commit()

    taken = hooks.consume_lots_fefo(db, store_id=store.id, ingredient_id=ingredient_id, qty_base=1000)
    assert taken == [(batch, 300)]
    db.refresh(batch)
    assert batch.qty_remaining == 0


def test_consume_lots_fefo_with_no_batches_returns_empty_and_does_not_raise(db: Any, store: Store) -> None:
    assert hooks.consume_lots_fefo(db, store_id=store.id, ingredient_id=999999, qty_base=100) == []


def test_consume_lots_fefo_zero_or_negative_qty_returns_empty(db: Any, store: Store) -> None:
    assert hooks.consume_lots_fefo(db, store_id=store.id, ingredient_id=1, qty_base=0) == []
    assert hooks.consume_lots_fefo(db, store_id=store.id, ingredient_id=1, qty_base=-5) == []


# ---------------------------------------------------------------------------
# El FEFO vive DENTRO de `record_movement` (decisión de arquitectura #3):
# una salida cualquiera (acá, simulada con `cause=SALE`) descuenta de los
# lotes sin que quien llama a `record_movement` sepa nada de lotes.
# ---------------------------------------------------------------------------


def test_record_movement_triggers_fefo_when_lots_feature_is_on(
    db: Any, store: Store, employees: dict[str, Employee], create_ingredient: Callable[..., dict[str, Any]],
    set_feature: Callable[..., None],
) -> None:
    set_feature("inventory.perpetual", True)
    set_feature("inventory.lots", True)
    ingredient_id = create_ingredient(name="Res FEFO integración", min_stock="100")["id"]
    now = datetime(2026, 4, 1, tzinfo=timezone.utc)
    batch = hooks.create_stock_batch(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=2000, unit_cost_micros=1_000_000, cost_source=CostSource.OFFICIAL,
        expires_at=None, received_at=now, business_date=now.date(), source_type="test", source_id=30,
    )
    db.commit()

    actor = _actor(store, employees["admin"])
    hooks.record_movement(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=-500, cause=MovementCause.SALE, cost_micros=1_000_000, cost_source=CostSource.OFFICIAL,
        actor=actor, business_date=now.date(), at=now,
    )
    db.refresh(batch)
    assert batch.qty_remaining == 1500


def test_record_movement_does_not_touch_lots_when_flag_is_off(
    db: Any, store: Store, employees: dict[str, Employee], create_ingredient: Callable[..., dict[str, Any]],
    set_feature: Callable[..., None],
) -> None:
    set_feature("inventory.perpetual", True)
    set_feature("inventory.lots", False)
    ingredient_id = create_ingredient(name="Res FEFO apagado", min_stock="100")["id"]
    now = datetime(2026, 4, 1, tzinfo=timezone.utc)
    batch = hooks.create_stock_batch(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=2000, unit_cost_micros=1_000_000, cost_source=CostSource.OFFICIAL,
        expires_at=None, received_at=now, business_date=now.date(), source_type="test", source_id=31,
    )
    db.commit()

    actor = _actor(store, employees["admin"])
    hooks.record_movement(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=-500, cause=MovementCause.SALE, cost_micros=1_000_000, cost_source=CostSource.OFFICIAL,
        actor=actor, business_date=now.date(), at=now,
    )
    db.refresh(batch)
    assert batch.qty_remaining == 2000  # sin la flag, el lote no se toca


def test_reception_reversal_never_triggers_fefo_on_a_different_batch(
    db: Any, store: Store, employees: dict[str, Employee], create_ingredient: Callable[..., dict[str, Any]],
    set_feature: Callable[..., None],
) -> None:
    """El caso declarado en el docstring de `record_movement`: revertir una
    recepción escribe un movimiento `cause=RECEPTION_REVERSAL` negativo, pero
    NO puede disparar FEFO -- si lo hiciera, consumiría de un lote *distinto*
    del que se está anulando."""
    set_feature("inventory.perpetual", True)
    set_feature("inventory.lots", True)
    ingredient_id = create_ingredient(name="Pescado FEFO reversa", min_stock="100")["id"]
    now = datetime(2026, 5, 1, tzinfo=timezone.utc)

    reversed_batch = hooks.create_stock_batch(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=1000, unit_cost_micros=1_000_000, cost_source=CostSource.OFFICIAL,
        expires_at=None, received_at=now, business_date=now.date(), source_type="test", source_id=40,
    )
    other_batch = hooks.create_stock_batch(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=1000, unit_cost_micros=1_000_000, cost_source=CostSource.OFFICIAL,
        expires_at=date(2026, 5, 10), received_at=now + timedelta(hours=1), business_date=now.date(),
        source_type="test", source_id=41,
    )
    db.commit()

    hooks.reverse_stock_batch(db, batch_id=reversed_batch.id)

    actor = _actor(store, employees["admin"])
    hooks.record_movement(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=-1000, cause=MovementCause.RECEPTION_REVERSAL, cost_micros=1_000_000, cost_source=CostSource.OFFICIAL,
        actor=actor, business_date=now.date(), at=now,
    )
    db.refresh(other_batch)
    assert other_batch.qty_remaining == 1000  # intacto: la reversa no tocó un lote ajeno


# ---------------------------------------------------------------------------
# `reverse_stock_batch`: `409 LOT_CONSUMED` si ya se tocó, idempotente si ya
# estaba revertido.
# ---------------------------------------------------------------------------


def test_reverse_stock_batch_raises_lot_consumed_if_partially_consumed(
    db: Any, store: Store, create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    ingredient_id = create_ingredient(name="Papa reversa", min_stock="100")["id"]
    now = datetime(2026, 6, 1, tzinfo=timezone.utc)
    batch = hooks.create_stock_batch(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=1000, unit_cost_micros=1_000_000, cost_source=CostSource.OFFICIAL,
        expires_at=None, received_at=now, business_date=now.date(), source_type="test", source_id=50,
    )
    db.commit()
    hooks.consume_lots_fefo(db, store_id=store.id, ingredient_id=ingredient_id, qty_base=1)
    db.commit()

    with pytest.raises(AppError) as exc_info:
        hooks.reverse_stock_batch(db, batch_id=batch.id)
    assert exc_info.value.code == "LOT_CONSUMED"
    assert exc_info.value.status == 409


def test_reverse_stock_batch_is_idempotent(db: Any, store: Store, create_ingredient: Callable[..., dict[str, Any]]) -> None:
    ingredient_id = create_ingredient(name="Zanahoria reversa", min_stock="100")["id"]
    now = datetime(2026, 6, 1, tzinfo=timezone.utc)
    batch = hooks.create_stock_batch(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=1000, unit_cost_micros=1_000_000, cost_source=CostSource.OFFICIAL,
        expires_at=None, received_at=now, business_date=now.date(), source_type="test", source_id=51,
    )
    db.commit()
    hooks.reverse_stock_batch(db, batch_id=batch.id)
    hooks.reverse_stock_batch(db, batch_id=batch.id)  # no debe romper ni volver a validar
    db.refresh(batch)
    assert batch.qty_remaining == 0
    assert batch.reversed_at is not None


# ---------------------------------------------------------------------------
# Un lote vencido NO se da de baja solo (SPEC-NEGOCIO §5.7): sigue con
# stock, alerta "vencido con stock", hasta que una persona registre la
# merma. Test que comprueba que el stock NO se movió solo.
# ---------------------------------------------------------------------------


def test_expired_lot_keeps_its_stock_until_someone_registers_waste(
    db: Any, store: Store, employees: dict[str, Employee], create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    ingredient_id = create_ingredient(name="Yogur vencido", min_stock="100")["id"]
    now = datetime(2026, 7, 15, tzinfo=timezone.utc)
    yesterday = (now - timedelta(days=1)).date()
    received_at = now - timedelta(days=20)
    batch = hooks.create_stock_batch(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=1000, unit_cost_micros=2_000_000, cost_source=CostSource.OFFICIAL,
        expires_at=yesterday, received_at=received_at, business_date=received_at.date(),
        source_type="test", source_id=60,
    )
    # El libro (el otro lado de la recepción) también entra: `create_stock_batch`
    # no lo escribe por su cuenta -- son dos escrituras separadas (ver
    # docstring de la función).
    hooks.record_movement(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=1000, cause=MovementCause.PURCHASE, cost_micros=2_000_000, cost_source=CostSource.OFFICIAL,
        actor=_actor(store, employees["admin"]), business_date=received_at.date(), at=received_at,
        ref_type="stock_batch", ref_id=batch.id,
    )
    db.commit()

    rows = service.list_lots(db, store=store, status="expired")
    assert any(b.id == batch.id for b, _ in rows)

    stock = hooks.current_stock(db, store_id=store.id, ingredient_id=ingredient_id)
    assert stock == 1000  # nadie lo dio de baja solo
    db.refresh(batch)
    assert batch.qty_remaining == 1000


def test_lot_without_expiry_is_never_expiring_nor_expired(
    db: Any, store: Store, create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    ingredient_id = create_ingredient(name="Arroz sin vencer", min_stock="100")["id"]
    now = datetime(2026, 7, 15, tzinfo=timezone.utc)
    batch = hooks.create_stock_batch(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=1000, unit_cost_micros=2_000_000, cost_source=CostSource.OFFICIAL,
        expires_at=None, received_at=now - timedelta(days=400), business_date=(now - timedelta(days=400)).date(),
        source_type="test", source_id=61,
    )
    db.commit()

    status = service.lot_status(batch, today=date(2026, 7, 15))
    assert status == "active"


# ---------------------------------------------------------------------------
# `GET /admin/lots`: la flag `inventory.lots` la protege, con `400
# FEATURE_DISABLED`.
# ---------------------------------------------------------------------------


def test_get_lots_requires_the_flag(
    admin_client: TestClient, store: Store, set_feature: Callable[..., None]
) -> None:
    set_feature("inventory.perpetual", True)
    set_feature("inventory.lots", False)
    resp = admin_client.get(f"/api/v1/admin/lots?store_id={store.id}")
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"

    set_feature("inventory.lots", True)
    resp = admin_client.get(f"/api/v1/admin/lots?store_id={store.id}")
    assert resp.status_code == 200
