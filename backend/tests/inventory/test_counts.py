"""Conteos a ciegas (SPEC-NEGOCIO §5.4; `features/fase-2-costo-inventario/
spec.md § Counts`). **El test que más importa de la misión** vive acá:
`test_apply_count_uses_stock_at_the_count_instant_not_at_apply_time_...`
-- un conteo de las 13:07 aplicado a las 15:42, con movimientos en el medio,
no puede inventar un faltante."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any, Callable
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.auth.deps import Actor
from app.auth.models import Employee
from app.core import clock as clock_module
from app.core.quantity import parse_qty_base
from app.inventory import hooks
from app.inventory.models import CostSource, MovementCause
from app.stores.models import Store

ADMIN_PIN = "9999"  # `tests/conftest.py::KNOWN_PINS["Admin"]`


def _actor(store: Store, employee: Employee) -> Actor:
    return Actor(
        kind="admin", organization_id=store.organization_id, store_id=store.id,
        employee_id=employee.id, employee_name=employee.name, role=employee.role,
    )


def _enable(set_feature: Callable[..., None]) -> None:
    set_feature("catalog.recipes", True)
    set_feature("inventory.perpetual", True)
    set_feature("inventory.counts", True)


@pytest.fixture()
def counts_ready(set_feature: Callable[..., None]) -> None:
    _enable(set_feature)


def _open_count(admin_client: TestClient, store: Store, scope: str = "full") -> dict[str, Any]:
    resp = admin_client.post(f"/api/v1/admin/counts?store_id={store.id}", json={"scope": scope})
    assert resp.status_code == 201, resp.text
    return resp.json()


# ---------------------------------------------------------------------------
# A CIEGAS: ninguna respuesta del flujo de captura contiene el stock
# teórico, por ningún camino. Se recorre el JSON entero buscando el valor.
# ---------------------------------------------------------------------------


def test_count_capture_flow_never_leaks_theoretical_stock(
    db: Any, store: Store, admin_client: TestClient, employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]], counts_ready: None,
) -> None:
    ingredient_id = create_ingredient(name="Ciego", min_stock="100")["id"]
    now = datetime(2026, 4, 1, tzinfo=timezone.utc)
    hooks.record_movement(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=54_321, cause=MovementCause.PURCHASE, cost_micros=1_000_000, cost_source=CostSource.OFFICIAL,
        actor=_actor(store, employees["admin"]), business_date=now.date(), at=now,
    )
    db.commit()
    theoretical_stock = hooks.current_stock(db, store_id=store.id, ingredient_id=ingredient_id)
    assert theoretical_stock == 54_321  # el número que NO puede aparecer

    opened = _open_count(admin_client, store, scope="full")
    detail = admin_client.get(f"/api/v1/admin/counts/{opened['id']}?store_id={store.id}")
    assert detail.status_code == 200

    lines_resp = admin_client.put(
        f"/api/v1/admin/counts/{opened['id']}/lines?store_id={store.id}",
        json={"lines": [{"ingredient_id": ingredient_id, "qty_counted": "50", "was_counted": True}]},
    )
    assert lines_resp.status_code == 200

    for payload in (opened, detail.json(), lines_resp.json()):
        raw = json.dumps(payload)
        assert "54321" not in raw and "54.321" not in raw


# ---------------------------------------------------------------------------
# No existe "todo coincide": ningún atajo marca todos los renglones de una
# vez; un guardado parcial se dice explícitamente en la respuesta.
# ---------------------------------------------------------------------------


def test_no_shortcut_marks_every_line_at_once(
    store: Store, admin_client: TestClient, create_ingredient: Callable[..., dict[str, Any]], counts_ready: None
) -> None:
    ids = [create_ingredient(name=f"Todo coincide {i}", min_stock="10")["id"] for i in range(3)]
    opened = _open_count(admin_client, store, scope="full")

    # Sólo UNO de los tres renglones -- guardado explícitamente parcial.
    resp = admin_client.put(
        f"/api/v1/admin/counts/{opened['id']}/lines?store_id={store.id}",
        json={"lines": [{"ingredient_id": ids[0], "qty_counted": "1", "was_counted": True}]},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["partial"] is True
    assert body["lines_counted"] == 1
    assert body["lines_total"] >= 3
    counted_flags = {line["ingredient_id"]: line["was_counted"] for line in body["lines"]}
    assert counted_flags[ids[0]] is True
    assert counted_flags[ids[1]] is False
    assert counted_flags[ids[2]] is False


def test_a_draft_never_overwrites_an_already_confirmed_value(
    store: Store, admin_client: TestClient, create_ingredient: Callable[..., dict[str, Any]], counts_ready: None
) -> None:
    ingredient_id = create_ingredient(name="Confirmado", min_stock="10")["id"]
    opened = _open_count(admin_client, store, scope="full")

    confirmed = admin_client.put(
        f"/api/v1/admin/counts/{opened['id']}/lines?store_id={store.id}",
        json={"lines": [{"ingredient_id": ingredient_id, "qty_counted": "7", "was_counted": True}]},
    )
    assert confirmed.status_code == 200

    draft = admin_client.put(
        f"/api/v1/admin/counts/{opened['id']}/lines?store_id={store.id}",
        json={"lines": [{"ingredient_id": ingredient_id, "qty_counted": "2", "was_counted": False}]},
    )
    assert draft.status_code == 200
    line = next(l for l in draft.json()["lines"] if l["ingredient_id"] == ingredient_id)
    assert line["qty_counted"] == "7"  # el borrador (2) no pisó el confirmado (7)
    assert line["was_counted"] is True


# ---------------------------------------------------------------------------
# El test que más importa de la misión: aplicar usa `contado + (entradas -
# salidas desde el INSTANTE DEL CONTEO)`, nunca desde el instante de aplicar.
# ---------------------------------------------------------------------------


def test_apply_count_uses_stock_at_the_count_instant_not_at_apply_time_so_it_never_invents_a_shortfall(
    db: Any, store: Store, admin_client: TestClient, employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]], counts_ready: None, clock: Any,
) -> None:
    """El caso escrito a mano, con instantes explícitos (no generado): un
    conteo tomado a las 13:07 se aplica recién a las 15:42. Entre medio hay
    UNA venta de 2 kg. Si el sistema comparara contra el stock de las
    15:42 (que ya bajó por la venta) en vez de contra el de las 13:07,
    "descubriría" un faltante de 2 kg que nunca existió -- exactamente "el
    caso que mandó a buscar un robo que no existe"."""
    ingredient_id = create_ingredient(name="Pollo 13:07", min_stock="100")["id"]

    day = datetime(2026, 4, 10, tzinfo=timezone.utc)
    clock.set(day.replace(hour=6, minute=0))
    # Stock inicial: 10 kg comprados a las 06:00.
    hooks.record_movement(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=10_000, cause=MovementCause.PURCHASE, cost_micros=1_000_000, cost_source=CostSource.OFFICIAL,
        actor=_actor(store, employees["admin"]), business_date=day.date(), at=clock.now(),
    )
    db.commit()

    # 13:07: se abre el conteo. En este instante, el libro dice 10 kg.
    clock.set(day.replace(hour=13, minute=7))
    opened = _open_count(admin_client, store, scope="full")
    assert hooks.current_stock(db, store_id=store.id, ingredient_id=ingredient_id) == 10_000

    # El conteo físico encuentra EXACTAMENTE 10 kg -- sin diferencia real.
    lines_resp = admin_client.put(
        f"/api/v1/admin/counts/{opened['id']}/lines?store_id={store.id}",
        json={"lines": [{"ingredient_id": ingredient_id, "qty_counted": "10", "was_counted": True}]},
    )
    assert lines_resp.status_code == 200

    # Entre las 13:07 y las 15:42 el restaurante vende 2 kg -- un movimiento
    # real, correcto, que YA está en el libro.
    clock.set(day.replace(hour=14, minute=0))
    hooks.record_movement(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=-2_000, cause=MovementCause.SALE, cost_micros=1_000_000, cost_source=CostSource.OFFICIAL,
        actor=_actor(store, employees["admin"]), business_date=day.date(), at=clock.now(),
    )
    db.commit()
    assert hooks.current_stock(db, store_id=store.id, ingredient_id=ingredient_id) == 8_000  # el libro, AHORA

    # 15:42: se aplica. Si comparara contra 8 kg (el stock de AHORA) en vez
    # de contra 10 kg (el stock de las 13:07), "descubriría" un faltante de
    # 2 kg que en realidad es la venta que ya está contabilizada aparte.
    clock.set(day.replace(hour=15, minute=42))
    apply_resp = admin_client.post(
        f"/api/v1/admin/counts/{opened['id']}/apply?store_id={store.id}",
        json={"authorizer_pin": ADMIN_PIN},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert apply_resp.status_code == 200, apply_resp.text
    body = apply_resp.json()
    line = body["lines"][0]
    assert line["adjustment"] == "0"  # CERO -- no hay faltante que inventar
    assert line["stock_before"] == "8"  # el libro ANTES de aplicar (post-venta)
    assert line["stock_after"] == "8"  # sigue en 8: la venta de las 14:00 sigue valiendo

    final_stock = hooks.current_stock(db, store_id=store.id, ingredient_id=ingredient_id)
    assert final_stock == 8_000  # nunca 10_000 -- eso habría revertido la venta real de las 14:00


def test_apply_count_with_a_real_shortfall_writes_exactly_that_shortfall(
    db: Any, store: Store, admin_client: TestClient, employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]], counts_ready: None, clock: Any,
) -> None:
    ingredient_id = create_ingredient(name="Res con faltante", min_stock="100")["id"]
    day = datetime(2026, 4, 11, tzinfo=timezone.utc)
    clock.set(day.replace(hour=9, minute=0))
    hooks.record_movement(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=5_000, cause=MovementCause.PURCHASE, cost_micros=1_000_000, cost_source=CostSource.OFFICIAL,
        actor=_actor(store, employees["admin"]), business_date=day.date(), at=clock.now(),
    )
    db.commit()

    opened = _open_count(admin_client, store, scope="full")
    # El libro dice 5 kg; el conteo físico encuentra sólo 4,5 kg -- un
    # faltante REAL de 0,5 kg.
    admin_client.put(
        f"/api/v1/admin/counts/{opened['id']}/lines?store_id={store.id}",
        json={"lines": [{"ingredient_id": ingredient_id, "qty_counted": "4.5", "was_counted": True}]},
    )

    apply_resp = admin_client.post(
        f"/api/v1/admin/counts/{opened['id']}/apply?store_id={store.id}",
        json={"authorizer_pin": ADMIN_PIN},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert apply_resp.status_code == 200
    line = apply_resp.json()["lines"][0]
    assert line["adjustment"] == "-0.5"
    assert line["stock_after"] == "4.5"

    movement_stmt_stock = hooks.current_stock(db, store_id=store.id, ingredient_id=ingredient_id)
    assert movement_stmt_stock == 4_500


def test_applying_the_same_count_twice_returns_409_and_does_not_duplicate_the_adjustment(
    db: Any, store: Store, admin_client: TestClient, employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]], counts_ready: None,
) -> None:
    ingredient_id = create_ingredient(name="Doble aplicar", min_stock="10")["id"]
    opened = _open_count(admin_client, store, scope="full")
    admin_client.put(
        f"/api/v1/admin/counts/{opened['id']}/lines?store_id={store.id}",
        json={"lines": [{"ingredient_id": ingredient_id, "qty_counted": "3", "was_counted": True}]},
    )

    first = admin_client.post(
        f"/api/v1/admin/counts/{opened['id']}/apply?store_id={store.id}",
        json={"authorizer_pin": ADMIN_PIN},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert first.status_code == 200

    # Reintento con OTRA Idempotency-Key (no un replay): la guarda de negocio
    # tiene que cortar igual.
    second = admin_client.post(
        f"/api/v1/admin/counts/{opened['id']}/apply?store_id={store.id}",
        json={"authorizer_pin": ADMIN_PIN},
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "COUNT_ALREADY_APPLIED"

    stock = hooks.current_stock(db, store_id=store.id, ingredient_id=ingredient_id)
    assert stock == 3_000  # el ajuste no se duplicó


def test_editing_lines_after_applied_is_rejected(
    store: Store, admin_client: TestClient, create_ingredient: Callable[..., dict[str, Any]], counts_ready: None
) -> None:
    ingredient_id = create_ingredient(name="Editar tras aplicar", min_stock="10")["id"]
    opened = _open_count(admin_client, store, scope="full")
    admin_client.put(
        f"/api/v1/admin/counts/{opened['id']}/lines?store_id={store.id}",
        json={"lines": [{"ingredient_id": ingredient_id, "qty_counted": "1", "was_counted": True}]},
    )
    admin_client.post(
        f"/api/v1/admin/counts/{opened['id']}/apply?store_id={store.id}",
        json={"authorizer_pin": ADMIN_PIN},
        headers={"Idempotency-Key": str(uuid4())},
    )
    resp = admin_client.put(
        f"/api/v1/admin/counts/{opened['id']}/lines?store_id={store.id}",
        json={"lines": [{"ingredient_id": ingredient_id, "qty_counted": "9", "was_counted": True}]},
    )
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "COUNT_ALREADY_APPLIED"


# ---------------------------------------------------------------------------
# Un número JSON crudo se rechaza -- `parse_qty_base` ya lo defiende.
# ---------------------------------------------------------------------------


def test_qty_counted_rejects_a_raw_json_number(
    store: Store, admin_client: TestClient, create_ingredient: Callable[..., dict[str, Any]], counts_ready: None
) -> None:
    ingredient_id = create_ingredient(name="Número crudo", min_stock="10")["id"]
    opened = _open_count(admin_client, store, scope="full")
    resp = admin_client.put(
        f"/api/v1/admin/counts/{opened['id']}/lines?store_id={store.id}",
        json={"lines": [{"ingredient_id": ingredient_id, "qty_counted": 5, "was_counted": True}]},
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# El conteo de críticos toma `key_item = True`; el completo, todos los activos.
# ---------------------------------------------------------------------------


def test_key_items_scope_only_includes_critical_ingredients(
    store: Store, admin_client: TestClient, create_ingredient: Callable[..., dict[str, Any]], counts_ready: None
) -> None:
    critical_id = create_ingredient(name="Crítico", key_item=True, min_stock="10")["id"]
    normal_id = create_ingredient(name="No crítico", key_item=False, min_stock="10")["id"]

    key_items_count = _open_count(admin_client, store, scope="key_items")
    ids_in_scope = {line["ingredient_id"] for line in key_items_count["lines"]}
    assert critical_id in ids_in_scope
    assert normal_id not in ids_in_scope

    full_count = _open_count(admin_client, store, scope="full")
    full_ids = {line["ingredient_id"] for line in full_count["lines"]}
    assert critical_id in full_ids
    assert normal_id in full_ids


# ---------------------------------------------------------------------------
# "La referencia en pantalla es el conteo anterior" -- y nada más.
# ---------------------------------------------------------------------------


def test_previous_count_reference_is_the_last_confirmed_value(
    store: Store, admin_client: TestClient, create_ingredient: Callable[..., dict[str, Any]], counts_ready: None
) -> None:
    ingredient_id = create_ingredient(name="Con referencia", min_stock="10")["id"]

    first = _open_count(admin_client, store, scope="full")
    admin_client.put(
        f"/api/v1/admin/counts/{first['id']}/lines?store_id={store.id}",
        json={"lines": [{"ingredient_id": ingredient_id, "qty_counted": "6", "was_counted": True}]},
    )
    admin_client.post(
        f"/api/v1/admin/counts/{first['id']}/apply?store_id={store.id}",
        json={"authorizer_pin": ADMIN_PIN},
        headers={"Idempotency-Key": str(uuid4())},
    )

    second = _open_count(admin_client, store, scope="full")
    line = next(l for l in second["lines"] if l["ingredient_id"] == ingredient_id)
    assert line["previous_qty_counted"] == "6"
    assert line["qty_counted"] is None  # a ciegas: no arranca con un valor


# ---------------------------------------------------------------------------
# Flags: `inventory.counts` requiere `inventory.perpetual`.
# ---------------------------------------------------------------------------


def test_counts_route_requires_the_flag(admin_client: TestClient, store: Store, set_feature: Callable[..., None]) -> None:
    set_feature("inventory.perpetual", True)
    set_feature("inventory.counts", False)
    resp = admin_client.post(f"/api/v1/admin/counts?store_id={store.id}", json={"scope": "full"})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"

    set_feature("inventory.counts", True)
    resp = admin_client.post(f"/api/v1/admin/counts?store_id={store.id}", json={"scope": "full"})
    assert resp.status_code == 201
