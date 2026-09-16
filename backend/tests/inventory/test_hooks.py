"""`app.inventory.hooks`: el contrato que llaman `recipes` y `orders`
(`features/fase-2-costo-inventario/spec.md`). Tests directos sobre las
funciones, sin pasar por HTTP -- son las firmas que otros dominios importan
tal cual."""

from __future__ import annotations

import random
from datetime import date, datetime, timezone

import pytest
from sqlalchemy.orm import Session

from app.auth.deps import Actor
from app.auth.models import Employee
from app.core.errors import AppError
from app.inventory import hooks
from app.inventory.models import BaseUnit, CostSource, Ingredient, MovementCause
from app.stores.models import Organization, Store

AT = datetime(2026, 3, 10, 15, 0, tzinfo=timezone.utc)
BUSINESS_DATE = date(2026, 3, 10)


def _actor(employee: Employee) -> Actor:
    return Actor(
        kind="device",
        organization_id=employee.organization_id,
        store_id=employee.store_id,
        employee_id=employee.id,
        employee_name=employee.name,
        role=employee.role,
    )


def _ingredient(
    db: Session,
    org: Organization,
    store: Store,
    *,
    name: str = "Insumo",
    min_stock: int = 1000,
    official_cost_micros: int | None = None,
    estimated_cost_micros: int | None = None,
    substitute_ingredient_id: int | None = None,
) -> Ingredient:
    from app.core import clock

    now = clock.now_utc()
    row = Ingredient(
        organization_id=org.id,
        store_id=store.id,
        name=name,
        category=None,
        base_unit=BaseUnit.G,
        purchase_unit="kg",
        purchase_factor=1000,
        yield_pct=100,
        official_cost_micros=official_cost_micros,
        estimated_cost_micros=estimated_cost_micros,
        min_stock=min_stock,
        lead_time_days=None,
        perishable=False,
        key_item=False,
        active=True,
        consumption_untracked=False,
        substitute_ingredient_id=substitute_ingredient_id,
        supplier_id=None,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.flush()
    return row


# ---------------------------------------------------------------------------
# record_movement: validaciones y la única escritura.
# ---------------------------------------------------------------------------


def test_record_movement_requires_exactly_one_target(
    db: Session, org: Organization, store: Store, employees: dict[str, Employee]
) -> None:
    ingredient = _ingredient(db, org, store)
    actor = _actor(employees["operator"])
    with pytest.raises(AppError):
        hooks.record_movement(
            db,
            organization_id=org.id,
            store_id=store.id,
            ingredient_id=None,
            preparation_id=None,
            qty_base=-100,
            cause=MovementCause.SALE,
            cost_micros=None,
            cost_source=CostSource.NONE,
            actor=actor,
            business_date=BUSINESS_DATE,
            at=AT,
        )
    with pytest.raises(AppError):
        hooks.record_movement(
            db,
            organization_id=org.id,
            store_id=store.id,
            ingredient_id=ingredient.id,
            preparation_id=1,
            qty_base=-100,
            cause=MovementCause.SALE,
            cost_micros=None,
            cost_source=CostSource.NONE,
            actor=actor,
            business_date=BUSINESS_DATE,
            at=AT,
        )


def test_record_movement_rejects_zero_qty(
    db: Session, org: Organization, store: Store, employees: dict[str, Employee]
) -> None:
    ingredient = _ingredient(db, org, store)
    with pytest.raises(AppError):
        hooks.record_movement(
            db,
            organization_id=org.id,
            store_id=store.id,
            ingredient_id=ingredient.id,
            qty_base=0,
            cause=MovementCause.SALE,
            cost_micros=None,
            cost_source=CostSource.NONE,
            actor=_actor(employees["operator"]),
            business_date=BUSINESS_DATE,
            at=AT,
        )


def test_record_movement_rejects_inconsistent_cost_source(
    db: Session, org: Organization, store: Store, employees: dict[str, Employee]
) -> None:
    ingredient = _ingredient(db, org, store)
    actor = _actor(employees["operator"])
    with pytest.raises(AppError):
        hooks.record_movement(
            db,
            organization_id=org.id,
            store_id=store.id,
            ingredient_id=ingredient.id,
            qty_base=-100,
            cause=MovementCause.SALE,
            cost_micros=5000,
            cost_source=CostSource.NONE,  # inconsistente: hay costo pero source=none
            actor=actor,
            business_date=BUSINESS_DATE,
            at=AT,
        )
    with pytest.raises(AppError):
        hooks.record_movement(
            db,
            organization_id=org.id,
            store_id=store.id,
            ingredient_id=ingredient.id,
            qty_base=-100,
            cause=MovementCause.SALE,
            cost_micros=None,
            cost_source=CostSource.OFFICIAL,  # inconsistente: source != none pero sin costo
            actor=actor,
            business_date=BUSINESS_DATE,
            at=AT,
        )


def test_record_movement_never_blocks_on_negative_stock(
    db: Session, org: Organization, store: Store, employees: dict[str, Employee]
) -> None:
    """Vender con stock en cero o negativo NO bloquea (SPEC-NEGOCIO §5.2)."""
    ingredient = _ingredient(db, org, store)
    actor = _actor(employees["operator"])
    for _ in range(3):
        hooks.record_movement(
            db,
            organization_id=org.id,
            store_id=store.id,
            ingredient_id=ingredient.id,
            qty_base=-5000,
            cause=MovementCause.SALE,
            cost_micros=None,
            cost_source=CostSource.NONE,
            actor=actor,
            business_date=BUSINESS_DATE,
            at=AT,
        )
    assert hooks.current_stock(db, store_id=store.id, ingredient_id=ingredient.id) == -15000


def test_record_movement_fuses_same_ref_into_one_row(
    db: Session, org: Organization, store: Store, employees: dict[str, Employee]
) -> None:
    """Consumos del mismo insumo en una comanda se fusionan en un movimiento
    (SPEC-NEGOCIO §5.3): dos líneas de receta distintas que llegan al mismo
    insumo, mismo `ref`, terminan en UNA sola fila con la suma."""
    from sqlalchemy import func, select

    from app.inventory.models import StockMovement

    ingredient = _ingredient(db, org, store)
    actor = _actor(employees["operator"])
    m1 = hooks.record_movement(
        db,
        organization_id=org.id,
        store_id=store.id,
        ingredient_id=ingredient.id,
        qty_base=-1000,
        cause=MovementCause.SALE,
        cost_micros=None,
        cost_source=CostSource.NONE,
        actor=actor,
        business_date=BUSINESS_DATE,
        at=AT,
        ref_type="order",
        ref_id=42,
    )
    m2 = hooks.record_movement(
        db,
        organization_id=org.id,
        store_id=store.id,
        ingredient_id=ingredient.id,
        qty_base=-500,
        cause=MovementCause.SALE,
        cost_micros=None,
        cost_source=CostSource.NONE,
        actor=actor,
        business_date=BUSINESS_DATE,
        at=AT,
        ref_type="order",
        ref_id=42,
    )
    assert m1.id == m2.id
    assert m2.qty_base == -1500

    count = db.execute(
        select(func.count()).select_from(StockMovement).where(
            StockMovement.ingredient_id == ingredient.id, StockMovement.ref_type == "order", StockMovement.ref_id == 42
        )
    ).scalar_one()
    assert count == 1


def test_record_movement_does_not_fuse_across_different_causes(
    db: Session, org: Organization, store: Store, employees: dict[str, Employee]
) -> None:
    """Una venta y su reversión ("vuelve") son causas distintas
    (`sale` vs `note_return`): nunca se fusionan aunque compartan `ref`."""
    ingredient = _ingredient(db, org, store)
    actor = _actor(employees["operator"])
    hooks.record_movement(
        db,
        organization_id=org.id,
        store_id=store.id,
        ingredient_id=ingredient.id,
        qty_base=-1000,
        cause=MovementCause.SALE,
        cost_micros=None,
        cost_source=CostSource.NONE,
        actor=actor,
        business_date=BUSINESS_DATE,
        at=AT,
        ref_type="order_item",
        ref_id=7,
    )
    hooks.record_movement(
        db,
        organization_id=org.id,
        store_id=store.id,
        ingredient_id=ingredient.id,
        qty_base=1000,
        cause=MovementCause.NOTE_RETURN,
        cost_micros=None,
        cost_source=CostSource.NONE,
        actor=actor,
        business_date=BUSINESS_DATE,
        at=AT,
        ref_type="order_item",
        ref_id=7,
    )
    # Espejo exacto: el saldo vuelve a 0, no queda ninguna fila neta rara.
    assert hooks.current_stock(db, store_id=store.id, ingredient_id=ingredient.id) == 0


def test_note_return_reversal_is_an_exact_mirror_over_random_cases(
    db: Session, org: Organization, store: Store, employees: dict[str, Employee]
) -> None:
    rng = random.Random(20260915)
    actor = _actor(employees["operator"])
    for i in range(200):
        ingredient = _ingredient(db, org, store, name=f"Mirror {i}")
        qty = rng.randint(1, 500_000)
        before = hooks.current_stock(db, store_id=store.id, ingredient_id=ingredient.id)
        hooks.record_movement(
            db,
            organization_id=org.id,
            store_id=store.id,
            ingredient_id=ingredient.id,
            qty_base=-qty,
            cause=MovementCause.SALE,
            cost_micros=None,
            cost_source=CostSource.NONE,
            actor=actor,
            business_date=BUSINESS_DATE,
            at=AT,
            ref_type="order_item",
            ref_id=i,
        )
        hooks.record_movement(
            db,
            organization_id=org.id,
            store_id=store.id,
            ingredient_id=ingredient.id,
            qty_base=qty,
            cause=MovementCause.NOTE_RETURN,
            cost_micros=None,
            cost_source=CostSource.NONE,
            actor=actor,
            business_date=BUSINESS_DATE,
            at=AT,
            ref_type="order_item_return",
            ref_id=i,
        )
        after = hooks.current_stock(db, store_id=store.id, ingredient_id=ingredient.id)
        assert after == before


def test_record_movement_requires_identified_actor(
    db: Session, org: Organization, store: Store
) -> None:
    ingredient = _ingredient(db, org, store)
    anonymous = Actor(
        kind="device", organization_id=org.id, store_id=store.id, employee_id=None, employee_name=None, role=None
    )
    with pytest.raises(AppError):
        hooks.record_movement(
            db,
            organization_id=org.id,
            store_id=store.id,
            ingredient_id=ingredient.id,
            qty_base=-100,
            cause=MovementCause.SALE,
            cost_micros=None,
            cost_source=CostSource.NONE,
            actor=anonymous,
            business_date=BUSINESS_DATE,
            at=AT,
        )


# ---------------------------------------------------------------------------
# resolve_ingredient_cost
# ---------------------------------------------------------------------------


def test_resolve_ingredient_cost_hierarchy(db: Session, org: Organization, store: Store) -> None:
    none_cost = _ingredient(db, org, store, name="Sin costo")
    assert hooks.resolve_ingredient_cost(db, none_cost) == (None, CostSource.NONE)

    estimated = _ingredient(db, org, store, name="Estimado", estimated_cost_micros=5_000_000)
    assert hooks.resolve_ingredient_cost(db, estimated) == (5_000_000, CostSource.ESTIMATED)

    official = _ingredient(
        db, org, store, name="Oficial", official_cost_micros=9_000_000, estimated_cost_micros=5_000_000
    )
    assert hooks.resolve_ingredient_cost(db, official) == (9_000_000, CostSource.OFFICIAL)


# ---------------------------------------------------------------------------
# low_stock_alerts vs negative_stock_alerts: alertas distintas.
# ---------------------------------------------------------------------------


def test_low_stock_and_negative_are_distinct_alerts(
    db: Session, org: Organization, store: Store, employees: dict[str, Employee]
) -> None:
    actor = _actor(employees["operator"])
    low = _ingredient(db, org, store, name="Bajo mínimo", min_stock=1000)
    negative = _ingredient(db, org, store, name="Negativo", min_stock=1000)
    healthy = _ingredient(db, org, store, name="Sano", min_stock=1000)

    # `low`: queda por debajo del mínimo pero NUNCA negativo.
    hooks.record_movement(
        db, organization_id=org.id, store_id=store.id, ingredient_id=low.id, qty_base=2000,
        cause=MovementCause.PRODUCTION_IN, cost_micros=None, cost_source=CostSource.NONE,
        actor=actor, business_date=BUSINESS_DATE, at=AT,
    )
    hooks.record_movement(
        db, organization_id=org.id, store_id=store.id, ingredient_id=low.id, qty_base=-1500,
        cause=MovementCause.SALE, cost_micros=None, cost_source=CostSource.NONE,
        actor=actor, business_date=BUSINESS_DATE, at=AT,
    )
    assert hooks.current_stock(db, store_id=store.id, ingredient_id=low.id) == 500  # > 0, < 1000

    # `negative`: queda bajo cero.
    hooks.record_movement(
        db, organization_id=org.id, store_id=store.id, ingredient_id=negative.id, qty_base=-500,
        cause=MovementCause.SALE, cost_micros=None, cost_source=CostSource.NONE,
        actor=actor, business_date=BUSINESS_DATE, at=AT,
    )
    assert hooks.current_stock(db, store_id=store.id, ingredient_id=negative.id) == -500

    # `healthy`: por encima del mínimo, nunca negativo.
    hooks.record_movement(
        db, organization_id=org.id, store_id=store.id, ingredient_id=healthy.id, qty_base=5000,
        cause=MovementCause.PRODUCTION_IN, cost_micros=None, cost_source=CostSource.NONE,
        actor=actor, business_date=BUSINESS_DATE, at=AT,
    )

    low_ids = {a["ingredient_id"] for a in hooks.low_stock_alerts(db, store_id=store.id)}
    negative_ids = {a["ingredient_id"] for a in hooks.negative_stock_alerts(db, store_id=store.id)}

    assert low.id in low_ids
    assert negative.id in low_ids  # negativo también está bajo mínimo
    assert healthy.id not in low_ids

    assert negative.id in negative_ids
    assert low.id not in negative_ids  # bajo mínimo pero no negativo: NO es la misma alerta
    assert healthy.id not in negative_ids

    negative_alert = next(a for a in hooks.negative_stock_alerts(db, store_id=store.id) if a["ingredient_id"] == negative.id)
    assert negative_alert["probable_cause"] == "sale"
    assert negative_alert["negative_since"] is not None


# ---------------------------------------------------------------------------
# resolve_consumption_target: un solo camino de consumo, con cascada.
# ---------------------------------------------------------------------------


def test_resolve_consumption_target_without_substitute_consumes_all_from_ingredient(
    db: Session, org: Organization, store: Store
) -> None:
    ingredient = _ingredient(db, org, store)
    result = hooks.resolve_consumption_target(db, ingredient, 1500)
    assert result == [(ingredient, 1500)]


def test_resolve_consumption_target_zero_or_negative_qty_returns_empty(
    db: Session, org: Organization, store: Store
) -> None:
    ingredient = _ingredient(db, org, store)
    assert hooks.resolve_consumption_target(db, ingredient, 0) == []
    assert hooks.resolve_consumption_target(db, ingredient, -10) == []


def test_resolve_consumption_target_stays_on_primary_when_stock_covers_it(
    db: Session, org: Organization, store: Store, employees: dict[str, Employee]
) -> None:
    substitute = _ingredient(db, org, store, name="Deslactosada")
    primary = _ingredient(db, org, store, name="Entera", substitute_ingredient_id=substitute.id)
    actor = _actor(employees["operator"])
    hooks.record_movement(
        db, organization_id=org.id, store_id=store.id, ingredient_id=primary.id, qty_base=10_000,
        cause=MovementCause.PRODUCTION_IN, cost_micros=None, cost_source=CostSource.NONE,
        actor=actor, business_date=BUSINESS_DATE, at=AT,
    )
    result = hooks.resolve_consumption_target(db, primary, 3000)
    assert result == [(primary, 3000)]


def test_resolve_consumption_target_cascades_to_substitute_when_short(
    db: Session, org: Organization, store: Store, employees: dict[str, Employee]
) -> None:
    """Caso exacto de la referencia: leche entera se agota, cae a la
    deslactosada -- un solo camino, nunca dos escrituras independientes."""
    substitute = _ingredient(db, org, store, name="Deslactosada")
    primary = _ingredient(db, org, store, name="Entera", substitute_ingredient_id=substitute.id)
    actor = _actor(employees["operator"])
    hooks.record_movement(
        db, organization_id=org.id, store_id=store.id, ingredient_id=primary.id, qty_base=1000,
        cause=MovementCause.PRODUCTION_IN, cost_micros=None, cost_source=CostSource.NONE,
        actor=actor, business_date=BUSINESS_DATE, at=AT,
    )
    hooks.record_movement(
        db, organization_id=org.id, store_id=store.id, ingredient_id=substitute.id, qty_base=10_000,
        cause=MovementCause.PRODUCTION_IN, cost_micros=None, cost_source=CostSource.NONE,
        actor=actor, business_date=BUSINESS_DATE, at=AT,
    )

    result = hooks.resolve_consumption_target(db, primary, 4000)
    assert result == [(primary, 1000), (substitute, 3000)]
    assert sum(qty for _, qty in result) == 4000


def test_resolve_consumption_target_final_link_absorbs_remainder_and_can_go_negative(
    db: Session, org: Organization, store: Store
) -> None:
    """Sin más stock en ningún eslabón de la cadena, todo el sobrante cae en
    el último insumo -- que sí puede quedar negativo (vender no bloquea)."""
    substitute = _ingredient(db, org, store, name="Deslactosada")
    primary = _ingredient(db, org, store, name="Entera", substitute_ingredient_id=substitute.id)

    result = hooks.resolve_consumption_target(db, primary, 4000)
    assert result == [(substitute, 4000)]


def test_resolve_consumption_target_breaks_cycles_without_losing_quantity(
    db: Session, org: Organization, store: Store
) -> None:
    a = _ingredient(db, org, store, name="A")
    b = _ingredient(db, org, store, name="B", substitute_ingredient_id=a.id)
    a.substitute_ingredient_id = b.id
    db.flush()

    result = hooks.resolve_consumption_target(db, a, 2500)
    assert sum(qty for _, qty in result) == 2500
