"""Validaciones de `create_stock_batch` y persistencia de
`MovementCause.RECEPTION_REVERSAL` (el valor nuevo del enum -- "otro agente
depende de que ese valor exista": `app.purchases` lo usa para la reversa de
una recepción)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.auth.deps import Actor
from app.auth.models import Employee
from app.core.errors import AppError
from app.inventory import hooks
from app.inventory.models import CostSource, MovementCause, StockMovement
from app.stores.models import Store


def _actor(store: Store, employee: Employee) -> Actor:
    return Actor(
        kind="admin", organization_id=store.organization_id, store_id=store.id,
        employee_id=employee.id, employee_name=employee.name, role=employee.role,
    )


def test_create_stock_batch_rejects_zero_or_negative_qty(
    db: Any, store: Store, create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    ingredient_id = create_ingredient(name="Lote inválido", min_stock="10")["id"]
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    with pytest.raises(AppError):
        hooks.create_stock_batch(
            db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
            qty_base=0, unit_cost_micros=1_000_000, cost_source=CostSource.OFFICIAL,
            received_at=now, business_date=now.date(), source_type="test", source_id=1,
        )


def test_create_stock_batch_rejects_negative_cost(
    db: Any, store: Store, create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    ingredient_id = create_ingredient(name="Lote costo negativo", min_stock="10")["id"]
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    with pytest.raises(AppError):
        hooks.create_stock_batch(
            db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
            qty_base=1000, unit_cost_micros=-1, cost_source=CostSource.OFFICIAL,
            received_at=now, business_date=now.date(), source_type="test", source_id=1,
        )


def test_reception_reversal_cause_persists_and_round_trips(
    db: Any, store: Store, employees: dict[str, Employee], create_ingredient: Callable[..., dict[str, Any]]
) -> None:
    """`RECEPTION_REVERSAL` es el valor nuevo del enum en 2b. Como
    `sa.Enum(..., native_enum=False)` en este repo (SQLAlchemy 2.0, sin
    `create_constraint=True`) genera VARCHAR sin CHECK -- verificado contra
    `CreateTable(...).compile(...)` -- agregar el valor al enum de Python NO
    requiere ninguna migración de esquema; este test es la prueba de que
    persiste y se relee tal cual, en SQLite (el dialecto de los tests) y por
    extensión en el motor real."""
    ingredient_id = create_ingredient(name="Reversa persistida", min_stock="10")["id"]
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    movement = hooks.record_movement(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=-500, cause=MovementCause.RECEPTION_REVERSAL, cost_micros=1_000_000, cost_source=CostSource.OFFICIAL,
        actor=_actor(store, employees["admin"]), business_date=now.date(), at=now,
    )
    db.commit()
    db.expire_all()

    reloaded = db.get(StockMovement, movement.id)
    assert reloaded is not None
    assert reloaded.cause == MovementCause.RECEPTION_REVERSAL
    assert reloaded.cause.value == "reception_reversal"

    # Y por SQL crudo, sin pasar por el ORM -- lo que realmente quedó en disco.
    raw = db.execute(select(StockMovement.cause).where(StockMovement.id == movement.id)).scalar_one()
    assert raw == MovementCause.RECEPTION_REVERSAL


def test_reversed_reception_leaves_the_ledger_readable(
    db: Any, store: Store, admin_client: TestClient, employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]], set_feature: Callable[..., None],
) -> None:
    """RONDA 2, hallazgo H-0 (bloqueante): `MovementCauseLiteral` no
    declaraba `"reception_reversal"` aunque `MovementCause.RECEPTION_
    REVERSAL` existe (`models.py`) y `app.purchases.service` ya la produce
    al revertir una recepción -- construir `StockMovementOut` con ese valor
    reventaba la validación de Pydantic (`500`), y filtrar por
    `?cause=reception_reversal` reventaba la validación de FastAPI en la
    query (`422`) porque ese valor no estaba en el `Literal`. Este test deja
    el libro legible en los dos caminos: la lista completa (sin filtrar) NO
    revienta con una fila de esa causa adentro, y filtrar por esa causa
    responde `200` con esa fila -- no `422`, no `500`."""
    set_feature("inventory.perpetual", True)
    ingredient_id = create_ingredient(name="Reversa legible", min_stock="10")["id"]
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    hooks.record_movement(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=-500_000, cause=MovementCause.RECEPTION_REVERSAL, cost_micros=1_000_000, cost_source=CostSource.OFFICIAL,
        actor=_actor(store, employees["admin"]), business_date=now.date(), at=now,
    )
    db.commit()

    all_resp = admin_client.get(f"/api/v1/admin/ingredients/{ingredient_id}/movements?store_id={store.id}")
    assert all_resp.status_code == 200, all_resp.text
    causes_seen = {row["cause"] for row in all_resp.json()}
    assert "reception_reversal" in causes_seen

    filtered_resp = admin_client.get(
        f"/api/v1/admin/ingredients/{ingredient_id}/movements?store_id={store.id}&cause=reception_reversal"
    )
    assert filtered_resp.status_code == 200, filtered_resp.text
    filtered_rows = filtered_resp.json()
    assert len(filtered_rows) == 1
    assert filtered_rows[0]["cause"] == "reception_reversal"
    assert filtered_rows[0]["qty_base"] == "-500"


def test_weighted_average_and_last_purchase_return_none_without_any_batch(db: Any, store: Store) -> None:
    assert hooks.weighted_average_cost_micros(db, store_id=store.id, ingredient_id=999999) is None
    assert hooks.last_purchase_cost_micros(db, store_id=store.id, ingredient_id=999999) is None
