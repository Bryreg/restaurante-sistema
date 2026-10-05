"""Inventario › Línea de tiempo (`app.inventory.timeline`): la curva del
saldo, el tiempo bajo el mínimo y en cero, la plata que salió por causa y
cada conteo contra lo que el libro tenía en ese instante."""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any, Callable

from fastapi.testclient import TestClient

from app.auth.deps import Actor
from app.auth.models import Employee
from app.core.quantity import parse_qty_base
from app.inventory import hooks
from app.inventory.models import CostSource, MovementCause
from app.stores.models import Store

# Día operativo 14 de enero (corte 06:00 Bogotá = 11:00 UTC).
DAY = date(2026, 1, 14)
URL = "/api/v1/admin/inventory/timeline"


def _actor(store: Store, employee: Employee) -> Actor:
    return Actor(
        kind="admin", organization_id=store.organization_id, store_id=store.id,
        employee_id=employee.id, employee_name=employee.name, role=employee.role,
    )


def _move(
    db: Any, store: Store, employee: Employee, ingredient_id: int, qty: str, cause: MovementCause,
    at: datetime, *, cost: int | None = 10_000_000,
) -> None:
    hooks.record_movement(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=parse_qty_base(qty), cause=cause, cost_micros=cost,
        cost_source=CostSource.OFFICIAL if cost is not None else CostSource.NONE,
        actor=_actor(store, employee), business_date=at.date(), at=at,
    )


def _utc(day: int, hour: int) -> datetime:
    return datetime(2026, 1, day, hour, tzinfo=timezone.utc)


def _setup(
    db: Any, store: Store, employees: dict[str, Employee], create_ingredient: Callable[..., dict[str, Any]],
    clock: Any,
) -> int:
    clock.set(_utc(13, 12))  # el insumo existe desde antes del rango
    iid = int(create_ingredient(name="Pollo", min_stock="1000", official_cost="10")["id"])
    clock.set(_utc(15, 12))
    admin = employees["admin"]
    _move(db, store, admin, iid, "2000", MovementCause.PURCHASE, _utc(13, 15))  # antes del rango
    _move(db, store, admin, iid, "-1500", MovementCause.SALE, _utc(14, 12))  # 500: bajo el mínimo
    _move(db, store, admin, iid, "-600", MovementCause.WASTE, _utc(14, 18))  # -100: en cero
    _move(db, store, admin, iid, "3000", MovementCause.PURCHASE, _utc(14, 20))  # 2900
    db.commit()
    return iid


def test_timeline_curve_durations_and_money(
    db: Any, store: Store, admin_client: TestClient, employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]], set_feature: Callable[..., None], clock: Any,
) -> None:
    set_feature("inventory.perpetual", True)
    iid = _setup(db, store, employees, create_ingredient, clock)

    resp = admin_client.get(f"{URL}?store_id={store.id}&from={DAY}&to={DAY}")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["start_at"].startswith("2026-01-14T11:00")
    assert body["end_at"].startswith("2026-01-15T11:00")
    row = next(r for r in body["rows"] if r["ingredient_id"] == iid)

    # Arrancó + movimientos = queda, con la misma lectura que la curva.
    assert (row["start_qty"], row["in_qty"], row["out_qty"], row["end_qty"]) == ("2000", "3000", "-2100", "2900")
    assert [p["qty"] for p in row["points"]] == ["500", "-100", "2900"]

    # Bajo el mínimo de 12:00 a 20:00; en cero de 18:00 a 20:00 — exacto.
    assert row["seconds_below_min"] == 8 * 3600
    assert row["seconds_at_zero"] == 2 * 3600
    assert row["first_zero_at"].startswith("2026-01-14T18:00")

    # La plata que salió: venta y merma al costo de cada movimiento ($10/g).
    assert row["value_out"] == 21_000
    assert row["value_out_partial"] is False
    assert [a["qty"] for a in row["arrivals"]] == ["3000"]

    summary = body["summary"]
    assert summary["value_out"] == 21_000
    assert {c["cause"]: c["value"] for c in summary["value_out_by_cause"]} == {"sale": 15_000, "waste": 6_000}
    assert summary["below_min"] == 1 and summary["hit_zero"] == 1 and summary["negative_now"] == 0

    # Una sola fila para la ficha.
    one = admin_client.get(f"{URL}?store_id={store.id}&from={DAY}&to={DAY}&ingredient_id={iid}").json()
    assert [r["ingredient_id"] for r in one["rows"]] == [iid]


def test_a_count_is_compared_with_the_book_at_its_instant(
    db: Any, store: Store, admin_client: TestClient, employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]], set_feature: Callable[..., None], clock: Any,
) -> None:
    set_feature("catalog.recipes", True)
    set_feature("inventory.perpetual", True)
    set_feature("inventory.counts", True)
    iid = _setup(db, store, employees, create_ingredient, clock)

    # Se cuenta a las 15:00, cuando el libro tenía 500 g: alguien vio 400.
    clock.set(_utc(14, 15))
    opened = admin_client.post(f"/api/v1/admin/counts?store_id={store.id}", json={"scope": "full"})
    assert opened.status_code == 201, opened.text
    lines = admin_client.put(
        f"/api/v1/admin/counts/{opened.json()['id']}/lines?store_id={store.id}",
        json={"lines": [{"ingredient_id": iid, "qty_counted": "400", "was_counted": True}]},
    )
    assert lines.status_code == 200, lines.text
    clock.set(_utc(15, 12))

    row = next(
        r for r in admin_client.get(f"{URL}?store_id={store.id}&from={DAY}&to={DAY}").json()["rows"]
        if r["ingredient_id"] == iid
    )
    [count] = row["counts"]
    assert (count["kind"], count["counted"], count["expected"], count["diff"]) == ("full", "400", "500", "-100")
    assert count["diff_value"] == -1_000


def test_a_count_adjustment_is_not_money_that_left(
    db: Any, store: Store, admin_client: TestClient, employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]], set_feature: Callable[..., None], clock: Any,
) -> None:
    set_feature("inventory.perpetual", True)
    clock.set(_utc(13, 12))
    iid = int(create_ingredient(name="Arroz", min_stock="100", official_cost="10")["id"])
    clock.set(_utc(15, 12))
    admin = employees["admin"]
    _move(db, store, admin, iid, "1000", MovementCause.PURCHASE, _utc(14, 12))
    _move(db, store, admin, iid, "-200", MovementCause.COUNT_ADJUSTMENT, _utc(14, 13))
    _move(db, store, admin, iid, "-100", MovementCause.SALE, _utc(14, 14), cost=None)
    db.commit()

    body = admin_client.get(f"{URL}?store_id={store.id}&from={DAY}&to={DAY}").json()
    row = next(r for r in body["rows"] if r["ingredient_id"] == iid)
    assert row["count_adjustment_qty"] == "-200"
    assert row["value_count_adjustment"] == -2_000
    # Lo único que salió no tenía costo: no se inventa $ 0.
    assert row["out_qty"] == "-100"
    assert row["value_out"] is None
    assert body["summary"]["value_count_shortage"] == -2_000
    assert body["summary"]["value_out_partial"] is True


def test_timeline_validations(
    store: Store, admin_client: TestClient, set_feature: Callable[..., None], clock: Any,
) -> None:
    set_feature("inventory.perpetual", False)
    off = admin_client.get(f"{URL}?store_id={store.id}")
    assert off.status_code == 400
    assert off.json()["error"]["code"] == "FEATURE_DISABLED"

    set_feature("inventory.perpetual", True)
    too_long = admin_client.get(f"{URL}?store_id={store.id}&from=2025-10-01&to=2026-01-14")
    assert too_long.status_code == 400
    missing = admin_client.get(f"{URL}?store_id={store.id}&ingredient_id=999999")
    assert missing.status_code == 404


def test_no_time_in_zero_before_the_ingredient_existed(
    db: Any, store: Store, admin_client: TestClient, employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]], set_feature: Callable[..., None], clock: Any,
) -> None:
    set_feature("inventory.perpetual", True)
    # Se crea a las 16:00 del día del rango y le entra mercancía a las 18:00.
    clock.set(_utc(14, 16))
    iid = int(create_ingredient(name="Nuevo", min_stock="100", official_cost="10")["id"])
    _move(db, store, employees["admin"], iid, "500", MovementCause.PURCHASE, _utc(14, 18))
    db.commit()
    clock.set(_utc(15, 12))

    row = next(
        r for r in admin_client.get(f"{URL}?store_id={store.id}&from={DAY}&to={DAY}").json()["rows"]
        if r["ingredient_id"] == iid
    )
    # En cero de 16:00 a 18:00, no desde las 11:00 en que arrancó el día.
    assert row["seconds_at_zero"] == 2 * 3600
    assert row["first_zero_at"].startswith("2026-01-14T16:00")
