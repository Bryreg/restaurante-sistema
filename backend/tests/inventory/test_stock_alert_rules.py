"""El motor de `ingredient_below_min` e `ingredient_negative` (hallazgo u8).

Las dos reglas se podían configurar en Notificaciones pero nadie las
evaluaba. Ahora `record_movement` las evalúa después de cada movimiento de
un insumo: un aviso por insumo mientras la condición siga (sin spam), se
resuelve solo cuando el insumo se recupera, y con `inventory.perpetual`
apagada no hace nada."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.deps import Actor
from app.auth.models import Employee
from app.inventory import hooks
from app.inventory.models import CostSource, MovementCause
from app.notifications.models import Notification, NotificationRule
from app.stores.models import Store

AT = datetime(2026, 3, 1, 15, 0, tzinfo=timezone.utc)


def _actor(store: Store, employee: Employee) -> Actor:
    return Actor(
        kind="admin", organization_id=store.organization_id, store_id=store.id,
        employee_id=employee.id, employee_name=employee.name, role=employee.role,
    )


def _move(db: Session, store: Store, employee: Employee, ingredient_id: int, qty_base: int) -> None:
    cause = MovementCause.PURCHASE if qty_base > 0 else MovementCause.MANUAL_ADJUSTMENT
    hooks.record_movement(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=qty_base, cause=cause, cost_micros=None, cost_source=CostSource.NONE,
        actor=_actor(store, employee), business_date=AT.date(), at=AT,
    )
    db.commit()


def _alerts(db: Session, store: Store, type_: str) -> list[Notification]:
    return list(
        db.execute(
            select(Notification)
            .where(Notification.store_id == store.id, Notification.type == type_)
            .order_by(Notification.id)
        ).scalars()
    )


def test_below_min_fires_once_while_it_stays_below_and_resolves_on_recovery(
    db: Session, store: Store, employees: dict[str, Employee], enable_inventory: Callable[[], None],
    create_ingredient: Callable[..., dict[str, Any]],
) -> None:
    enable_inventory()
    admin = employees["admin"]
    # min_stock "1000" = 1000 g (1 kg).
    ingredient_id = create_ingredient(name="Arroz", min_stock="1000")["id"]

    _move(db, store, admin, ingredient_id, 2_000_000)  # 2 kg: sobre el mínimo
    assert _alerts(db, store, "ingredient_below_min") == []

    _move(db, store, admin, ingredient_id, -1_500_000)  # 0,5 kg: bajo el mínimo
    first = _alerts(db, store, "ingredient_below_min")
    assert len(first) == 1
    assert first[0].payload == {"ingredient_id": ingredient_id, "qty_base": 500_000, "min_stock": 1_000_000}
    assert "Arroz" in first[0].body and "0,5 kg" in first[0].body
    assert first[0].resolved_at is None

    # Sigue bajo el mínimo: más salidas no repiten el aviso.
    _move(db, store, admin, ingredient_id, -100_000)
    _move(db, store, admin, ingredient_id, -100_000)
    assert len(_alerts(db, store, "ingredient_below_min")) == 1

    # Se repone: el aviso se resuelve solo, firmado por el sistema.
    _move(db, store, admin, ingredient_id, 5_000_000)
    db.expire_all()
    rows = _alerts(db, store, "ingredient_below_min")
    assert len(rows) == 1
    assert rows[0].resolved_at is not None
    assert rows[0].resolved_by_name == "Sistema"

    # Vuelve a caer: sale un aviso nuevo.
    _move(db, store, admin, ingredient_id, -5_000_000)
    rows = _alerts(db, store, "ingredient_below_min")
    assert len(rows) == 2
    assert rows[1].resolved_at is None


def test_negative_is_its_own_alert_and_resolves_when_back_to_zero(
    db: Session, store: Store, employees: dict[str, Employee], enable_inventory: Callable[[], None],
    create_ingredient: Callable[..., dict[str, Any]],
) -> None:
    enable_inventory()
    admin = employees["admin"]
    ingredient_id = create_ingredient(name="Queso", min_stock="1000")["id"]

    _move(db, store, admin, ingredient_id, -400_000)
    negatives = _alerts(db, store, "ingredient_negative")
    assert len(negatives) == 1
    assert negatives[0].payload == {"ingredient_id": ingredient_id, "qty_base": -400_000}
    # Negativo también es bajo el mínimo: son dos alertas distintas.
    assert len(_alerts(db, store, "ingredient_below_min")) == 1

    _move(db, store, admin, ingredient_id, -100_000)
    assert len(_alerts(db, store, "ingredient_negative")) == 1

    # Vuelve a cero: deja de ser negativo, sigue bajo el mínimo.
    _move(db, store, admin, ingredient_id, 500_000)
    db.expire_all()
    assert _alerts(db, store, "ingredient_negative")[0].resolved_at is not None
    assert _alerts(db, store, "ingredient_below_min")[0].resolved_at is None


def test_feature_off_evaluates_nothing(
    db: Session, store: Store, employees: dict[str, Employee], enable_inventory: Callable[[], None],
    set_feature: Callable[..., None], create_ingredient: Callable[..., dict[str, Any]],
) -> None:
    enable_inventory()
    ingredient_id = create_ingredient(name="Aceite", min_stock="1000")["id"]
    set_feature("inventory.perpetual", False)

    _move(db, store, employees["admin"], ingredient_id, -400_000)
    assert _alerts(db, store, "ingredient_below_min") == []
    assert _alerts(db, store, "ingredient_negative") == []


def test_disabled_rule_does_not_fire(
    db: Session, store: Store, employees: dict[str, Employee], enable_inventory: Callable[[], None],
    create_ingredient: Callable[..., dict[str, Any]],
) -> None:
    enable_inventory()
    db.add(
        NotificationRule(
            organization_id=store.organization_id, store_id=store.id, type="ingredient_negative",
            enabled=False, level="warning",
        )
    )
    db.commit()
    ingredient_id = create_ingredient(name="Leche", min_stock="1000")["id"]

    _move(db, store, employees["admin"], ingredient_id, -400_000)
    assert _alerts(db, store, "ingredient_negative") == []
    # La otra regla sigue encendida.
    assert len(_alerts(db, store, "ingredient_below_min")) == 1


def test_raising_the_minimum_fires_and_deactivating_resolves(
    db: Session, admin_client: Any, store: Store, employees: dict[str, Employee],
    enable_inventory: Callable[[], None], create_ingredient: Callable[..., dict[str, Any]],
) -> None:
    """El mínimo cambia la respuesta sin que se mueva el stock: subirlo por
    encima de lo que hay dispara el aviso, y dar de baja el insumo lo
    resuelve (un insumo dado de baja no pide reponer)."""
    enable_inventory()
    ingredient_id = create_ingredient(name="Tomate", min_stock="1000")["id"]
    _move(db, store, employees["admin"], ingredient_id, 2_000_000)
    assert _alerts(db, store, "ingredient_below_min") == []

    resp = admin_client.patch(f"/api/v1/admin/ingredients/{ingredient_id}", json={"min_stock": "5000"})
    assert resp.status_code == 200, resp.text
    db.expire_all()
    assert len(_alerts(db, store, "ingredient_below_min")) == 1

    resp = admin_client.patch(f"/api/v1/admin/ingredients/{ingredient_id}", json={"active": False})
    assert resp.status_code == 200, resp.text
    db.expire_all()
    assert _alerts(db, store, "ingredient_below_min")[0].resolved_at is not None
