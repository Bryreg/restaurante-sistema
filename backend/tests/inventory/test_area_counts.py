"""Conteo corto por área (`inventory.shift_counts`, `app/inventory/area_counts.py`).

Lo que el dueño decidió y estos tests fijan:
- cada persona ve SÓLO la lista de su área;
- el conteo es a ciegas: ni la lista ni la respuesta de la tablet traen stock,
  conteo anterior, diferencia ni costo;
- faltante de la noche (cierre anterior → apertura) y del turno (apertura →
  cierre) contra lo esperado según el libro, con ventas, merma y recepción en
  el medio;
- el umbral de la sede decide qué se marca;
- el recuento sorpresa vuelve a Hoy con su diferencia contra el sistema;
- la función apagada corta con `FEATURE_DISABLED`, y los permisos.

Las ventas y la recepción se escriben con `hooks.record_movement`, que es el
único asiento del libro (la misma excepción declarada que usa la varianza en
`test_variance_food_cost.py`); la merma entra por su puerta HTTP.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.deps import Actor
from app.auth.models import Employee
from app.core.quantity import parse_cost_micros
from app.inventory import hooks
from app.inventory.models import AreaCount, CostSource, MovementCause
from app.stores.models import Store

API = "/api/v1"


def _h() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


@pytest.fixture()
def shift_counts_on(set_feature: Callable[..., None]) -> None:
    set_feature("catalog.recipes", True)
    set_feature("inventory.perpetual", True)
    set_feature("inventory.waste", True)
    set_feature("inventory.shift_counts", True)


def _deep_keys(node: Any) -> set[str]:
    keys: set[str] = set()
    if isinstance(node, dict):
        for k, v in node.items():
            keys.add(k)
            keys |= _deep_keys(v)
    elif isinstance(node, list):
        for v in node:
            keys |= _deep_keys(v)
    return keys


def _area(admin_client: TestClient, store: Store, name: str) -> dict[str, Any]:
    resp = admin_client.post(f"{API}/admin/count-areas?store_id={store.id}", json={"name": name})
    assert resp.status_code == 201, resp.text
    return resp.json()


def _items(admin_client: TestClient, store: Store, area_id: int, ids: list[int]) -> Any:
    return admin_client.put(
        f"{API}/admin/count-areas/{area_id}/items?store_id={store.id}", json={"ingredient_ids": ids}
    )


def _assign(admin_client: TestClient, store: Store, employee: Employee, area_id: int | None) -> None:
    resp = admin_client.put(
        f"{API}/admin/count-area-members?store_id={store.id}", json={"employee_id": employee.id, "area_id": area_id}
    )
    assert resp.status_code == 200, resp.text


@pytest.fixture()
def bar_and_kitchen(
    admin_client: TestClient,
    store: Store,
    employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]],
    shift_counts_on: None,
) -> dict[str, Any]:
    """Bar (ron por botella de 750 ml) y Cocina (carne por peso, huevos por
    unidad). El operador es del bar; el operador 2, de cocina."""
    ron = create_ingredient(name="Ron", base_unit="ml", purchase_unit="botella", purchase_factor=750, official_cost="60")
    carne = create_ingredient(name="Carne", base_unit="g", purchase_unit="kg", purchase_factor=1000, official_cost="30")
    huevos = create_ingredient(name="Huevos", base_unit="unit", purchase_unit="panal", purchase_factor=30, official_cost="500")
    bar = _area(admin_client, store, "Bar")
    cocina = _area(admin_client, store, "Cocina")
    assert _items(admin_client, store, bar["id"], [ron["id"]]).status_code == 200
    assert _items(admin_client, store, cocina["id"], [carne["id"], huevos["id"]]).status_code == 200
    _assign(admin_client, store, employees["operator"], bar["id"])
    _assign(admin_client, store, employees["operator2"], cocina["id"])
    return {"ron": ron, "carne": carne, "huevos": huevos, "bar": bar, "cocina": cocina}


def _board(device_client: TestClient) -> dict[str, Any]:
    resp = device_client.get(f"{API}/device/area-count")
    assert resp.status_code == 200, resp.text
    return resp.json()


def _count(device_client: TestClient, moment: str, lines: list[tuple[int, str]]) -> Any:
    return device_client.post(
        f"{API}/device/area-counts",
        json={"moment": moment, "lines": [{"ingredient_id": i, "qty": q} for i, q in lines]},
        headers=_h(),
    )


def _actor(store: Store, employee: Employee) -> Actor:
    return Actor(
        kind="admin", organization_id=store.organization_id, store_id=store.id,
        employee_id=employee.id, employee_name=employee.name, role=employee.role,
    )


def _move(db: Session, store: Store, employee: Employee, clock: Any, ingredient_id: int, qty: int, cause: MovementCause) -> None:
    hooks.record_movement(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=qty, cause=cause, cost_micros=parse_cost_micros("30"), cost_source=CostSource.OFFICIAL,
        actor=_actor(store, employee), business_date=clock.now().date(), at=clock.now(),
    )
    db.commit()


# ---------------------------------------------------------------------------
# La lista por área, a ciegas.
# ---------------------------------------------------------------------------


def test_each_person_sees_only_the_list_of_their_area(
    device_client: TestClient, identify: Callable[..., Any], employees: dict[str, Employee], bar_and_kitchen: dict[str, Any]
) -> None:
    identify(device_client, employees["operator"])
    bar = _board(device_client)
    assert bar["area_name"] == "Bar"
    assert [i["name"] for i in bar["items"]] == ["Ron"]
    assert bar["items"][0]["entry_mode"] == "bottle"
    assert bar["items"][0]["entry_unit"] == "botella"

    identify(device_client, employees["operator2"])
    cocina = _board(device_client)
    assert cocina["area_name"] == "Cocina"
    assert {i["name"]: i["entry_mode"] for i in cocina["items"]} == {"Carne": "weight", "Huevos": "unit"}

    identify(device_client, employees["operator3"])
    nadie = _board(device_client)
    assert nadie["area_id"] is None and nadie["items"] == []
    assert "Inventario" in nadie["reason"]


def test_the_count_is_blind_no_stock_no_previous_no_cost_on_the_tablet(
    device_client: TestClient, identify: Callable[..., Any], employees: dict[str, Employee], bar_and_kitchen: dict[str, Any]
) -> None:
    ron = bar_and_kitchen["ron"]["id"]
    identify(device_client, employees["operator"])
    assert _count(device_client, "closing", [(ron, "3")]).status_code == 201
    board = _board(device_client)
    resp = _count(device_client, "opening", [(ron, "2.3")])
    assert resp.status_code == 201, resp.text
    prohibidas = {"stock", "qty_base", "expected_qty", "reference_qty", "shortage_qty", "shortage_value", "counted_qty"}
    for body in (board, resp.json()):
        keys = _deep_keys(body)
        assert not {k for k in keys if "cost" in k or "margin" in k}, keys
        assert not keys & prohibidas, keys & prohibidas
    assert resp.json()["employee_name"] == "Operator"
    assert resp.json()["lines_count"] == 1


def test_bottles_with_tenths_convert_once_on_the_server(
    db: Session, store: Store, admin_client: TestClient, device_client: TestClient, identify: Callable[..., Any],
    employees: dict[str, Employee], bar_and_kitchen: dict[str, Any],
) -> None:
    ron = bar_and_kitchen["ron"]["id"]
    identify(device_client, employees["operator"])
    bad = _count(device_client, "opening", [(ron, "2.35")])
    assert bad.status_code == 400
    assert "décimas" in bad.json()["error"]["message"]
    ok = _count(device_client, "opening", [(ron, "2,3")])
    assert ok.status_code == 201, ok.text
    detail = admin_client.get(f"{API}/admin/area-counts/{ok.json()['id']}?store_id={store.id}").json()
    line = detail["lines"][0]
    assert line["entered_qty"] == "2,3" and line["entered_unit"] == "botella"
    assert line["counted_qty"] == "1725"  # 2,3 × 750 ml


def test_a_count_must_include_every_item_and_nothing_is_written_when_it_does_not(
    db: Session, device_client: TestClient, identify: Callable[..., Any], employees: dict[str, Employee],
    bar_and_kitchen: dict[str, Any],
) -> None:
    identify(device_client, employees["operator2"])
    resp = _count(device_client, "opening", [(bar_and_kitchen["carne"]["id"], "5")])
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "COUNT_INCOMPLETE"
    assert "Huevos" in resp.json()["error"]["message"]
    other = _count(device_client, "opening", [(bar_and_kitchen["ron"]["id"], "1"), (bar_and_kitchen["carne"]["id"], "1")])
    assert other.status_code == 400
    assert db.execute(select(func.count(AreaCount.id))).scalar_one() == 0


def test_the_count_is_idempotent(
    db: Session, device_client: TestClient, identify: Callable[..., Any], employees: dict[str, Employee],
    bar_and_kitchen: dict[str, Any],
) -> None:
    identify(device_client, employees["operator"])
    payload = {"moment": "opening", "lines": [{"ingredient_id": bar_and_kitchen["ron"]["id"], "qty": "1"}]}
    key = {"Idempotency-Key": str(uuid4())}
    first = device_client.post(f"{API}/device/area-counts", json=payload, headers=key)
    second = device_client.post(f"{API}/device/area-counts", json=payload, headers=key)
    assert first.status_code == second.status_code == 201
    assert first.json() == second.json()
    assert db.execute(select(func.count(AreaCount.id))).scalar_one() == 1


def test_suggested_moment_moves_to_closing_after_the_opening_count(
    device_client: TestClient, identify: Callable[..., Any], employees: dict[str, Employee],
    bar_and_kitchen: dict[str, Any], clock: Any,
) -> None:
    clock.set(datetime(2026, 5, 2, 15, 0, tzinfo=timezone.utc))  # 10:00 en Bogotá
    identify(device_client, employees["operator"])
    before = _board(device_client)
    assert before["suggested_moment"] == "opening" and before["opening_done"] is None
    assert _count(device_client, "opening", [(bar_and_kitchen["ron"]["id"], "4")]).status_code == 201
    after = _board(device_client)
    assert after["suggested_moment"] == "closing"
    assert after["opening_done"]["employee_name"] == "Operator"


# ---------------------------------------------------------------------------
# La matemática: faltante de la noche y del turno.
# ---------------------------------------------------------------------------


def test_night_and_shift_shortage_with_sales_waste_and_a_reception_in_between(
    db: Session, store: Store, admin_client: TestClient, device_client: TestClient, identify: Callable[..., Any],
    employees: dict[str, Employee], bar_and_kitchen: dict[str, Any], clock: Any,
) -> None:
    carne = bar_and_kitchen["carne"]["id"]
    huevos = bar_and_kitchen["huevos"]["id"]
    cook = employees["operator2"]

    # Día 1, 22:00 en Bogotá: cierra quien sale. 10 kg de carne, 30 huevos.
    clock.set(datetime(2026, 5, 2, 3, 0, tzinfo=timezone.utc))
    identify(device_client, cook)
    closing1 = _count(device_client, "closing", [(carne, "10"), (huevos, "30")])
    assert closing1.status_code == 201, closing1.text

    # Día 2, 9:00: abre quien entra. 9,5 kg: faltaron 500 g de noche.
    clock.set(datetime(2026, 5, 2, 14, 0, tzinfo=timezone.utc))
    identify(device_client, cook)
    opening = _count(device_client, "opening", [(carne, "9.5"), (huevos, "30")])
    assert opening.status_code == 201, opening.text

    night = admin_client.get(f"{API}/admin/area-counts/{opening.json()['id']}?store_id={store.id}").json()
    assert night["window"] == "night"
    assert night["reference_count_id"] == closing1.json()["id"]
    row = next(l for l in night["lines"] if l["ingredient_id"] == carne)
    assert row["reference_qty"] == "10000" and row["inflow_qty"] == "0" and row["outflow_qty"] == "0"
    assert row["expected_qty"] == "10000"
    assert row["shortage_qty"] == "500"
    assert row["shortage_value"] == 15_000  # 500 g × $30/g
    assert row["shortage_pct_bp"] == 500  # 5 %
    # Default: 2 % Y $ 20.000. Pasa el porcentaje pero no el monto: no se marca.
    assert row["flagged"] is False

    # En el turno: entran 5 kg (recepción), salen 3 kg por ventas (consumo
    # teórico por receta) y 200 g de merma por su puerta HTTP.
    clock.set(datetime(2026, 5, 2, 15, 0, tzinfo=timezone.utc))
    _move(db, store, employees["admin"], clock, carne, 5_000_000, MovementCause.PURCHASE)
    clock.set(datetime(2026, 5, 2, 18, 0, tzinfo=timezone.utc))
    _move(db, store, employees["admin"], clock, carne, -3_000_000, MovementCause.SALE)
    identify(device_client, cook)
    waste = device_client.post(
        f"{API}/waste",
        json={"ingredient_id": carne, "qty": "200", "type": "breakage", "employee_pin": "3333"},
        headers=_h(),
    )
    assert waste.status_code == 201, waste.text

    # 22:00: cierre. Esperado 9,5 + 5 − 3 − 0,2 = 11,3 kg; contó 10,8.
    clock.set(datetime(2026, 5, 3, 3, 0, tzinfo=timezone.utc))
    identify(device_client, cook)
    closing2 = _count(device_client, "closing", [(carne, "10.8"), (huevos, "28")])
    assert closing2.status_code == 201, closing2.text
    shift = admin_client.get(f"{API}/admin/area-counts/{closing2.json()['id']}?store_id={store.id}").json()
    assert shift["window"] == "shift"
    assert shift["reference_count_id"] == opening.json()["id"]
    row = next(l for l in shift["lines"] if l["ingredient_id"] == carne)
    assert row["reference_qty"] == "9500"
    assert row["inflow_qty"] == "5000"
    assert row["outflow_qty"] == "3200"
    assert row["expected_qty"] == "11300"
    assert row["counted_qty"] == "10800"
    assert row["shortage_qty"] == "500"
    eggs = next(l for l in shift["lines"] if l["ingredient_id"] == huevos)
    assert eggs["shortage_qty"] == "2" and eggs["shortage_value"] == 1_000

    # Umbral más bajo en plata: ahora sí se marca.
    put = admin_client.put(
        f"{API}/admin/area-count-settings?store_id={store.id}", json={"threshold_pct_bp": 200, "threshold_amount": 10_000}
    )
    assert put.status_code == 200, put.text
    assert "2,0\u202f%" in put.json()["reading"] and "bloquea" in put.json()["reading"]
    again = admin_client.get(f"{API}/admin/area-counts/{closing2.json()['id']}?store_id={store.id}").json()
    assert next(l for l in again["lines"] if l["ingredient_id"] == carne)["flagged"] is True
    assert again["flagged_count"] == 1  # los huevos: 6,7 % pero $ 1.000, bajo el monto
    assert again["shortage_value_total"] == 16_000


def test_a_closing_without_an_opening_says_why_instead_of_a_zero(
    store: Store, admin_client: TestClient, device_client: TestClient, identify: Callable[..., Any],
    employees: dict[str, Employee], bar_and_kitchen: dict[str, Any],
) -> None:
    identify(device_client, employees["operator"])
    closing = _count(device_client, "closing", [(bar_and_kitchen["ron"]["id"], "3")])
    detail = admin_client.get(f"{API}/admin/area-counts/{closing.json()['id']}?store_id={store.id}").json()
    assert detail["reference_count_id"] is None
    assert "al abrir" in detail["reason"]
    line = detail["lines"][0]
    assert line["shortage_qty"] is None and line["shortage_value"] is None
    assert line["null_reason"]


# ---------------------------------------------------------------------------
# Hoy y el recuento sorpresa.
# ---------------------------------------------------------------------------


def test_today_says_which_areas_counted_and_the_spot_recount_comes_back_with_its_difference(
    db: Session, store: Store, admin_client: TestClient, device_client: TestClient, identify: Callable[..., Any],
    employees: dict[str, Employee], bar_and_kitchen: dict[str, Any], clock: Any,
) -> None:
    ron = bar_and_kitchen["ron"]["id"]
    clock.set(datetime(2026, 5, 2, 15, 0, tzinfo=timezone.utc))
    # El sistema cree que hay 4 botellas (3.000 ml).
    _move(db, store, employees["admin"], clock, ron, 3_000_000, MovementCause.PURCHASE)
    identify(device_client, employees["operator2"])
    carne, huevos = bar_and_kitchen["carne"]["id"], bar_and_kitchen["huevos"]["id"]
    assert _count(device_client, "opening", [(carne, "1"), (huevos, "1")]).status_code == 201

    today = admin_client.get(f"{API}/admin/today?store_id={store.id}").json()
    assert today["area_counts_enabled"] is True
    by_area = {a["area_name"]: a for a in today["area_counts_areas"]}
    assert by_area["Cocina"]["opening"]["employee_name"] == "Operator2"
    assert by_area["Bar"]["opening"] is None  # no contó: la pantalla lo pinta en rojo, no bloquea nada

    req = admin_client.post(
        f"{API}/admin/area-recounts?store_id={store.id}",
        json={"area_id": bar_and_kitchen["bar"]["id"], "ingredient_ids": [ron], "note": "Revisá el ron"},
        headers=_h(),
    )
    assert req.status_code == 201, req.text
    assert admin_client.get(f"{API}/admin/today?store_id={store.id}").json()["area_recounts_pending_count"] == 1

    # La cocina no lo ve ni lo puede responder.
    identify(device_client, employees["operator2"])
    assert _board(device_client)["recounts"] == []
    otra = device_client.post(
        f"{API}/device/area-recounts/{req.json()['id']}/answer",
        json={"lines": [{"ingredient_id": ron, "qty": "3"}]}, headers=_h(),
    )
    assert otra.status_code == 403

    identify(device_client, employees["operator"])
    pend = _board(device_client)["recounts"]
    assert [r["id"] for r in pend] == [req.json()["id"]]
    assert pend[0]["items"][0]["name"] == "Ron"
    assert not {k for k in _deep_keys(pend) if "cost" in k or "stock" in k}
    answer = device_client.post(
        f"{API}/device/area-recounts/{req.json()['id']}/answer",
        json={"lines": [{"ingredient_id": ron, "qty": "3.5"}]}, headers=_h(),
    )
    assert answer.status_code == 201, answer.text
    twice = device_client.post(
        f"{API}/device/area-recounts/{req.json()['id']}/answer",
        json={"lines": [{"ingredient_id": ron, "qty": "3.5"}]}, headers=_h(),
    )
    assert twice.status_code == 409

    listed = admin_client.get(f"{API}/admin/area-recounts?store_id={store.id}").json()
    assert listed[0]["status"] == "answered" and listed[0]["count_id"] == answer.json()["id"]
    spot = admin_client.get(f"{API}/admin/area-counts/{answer.json()['id']}?store_id={store.id}").json()
    assert spot["window"] == "spot" and spot["moment"] == "spot"
    line = spot["lines"][0]
    assert line["reference_qty"] == "3000"  # el sistema en ese instante
    assert line["counted_qty"] == "2625"  # 3,5 × 750
    assert line["shortage_qty"] == "375"

    today = admin_client.get(f"{API}/admin/today?store_id={store.id}").json()
    assert today["area_recounts_pending_count"] == 0
    flags = [f for f in today["area_counts_flags"] if f["window"] == "spot"]
    assert len(flags) == 1
    assert flags[0]["ingredient_name"] == "Ron" and flags[0]["shortage_qty"] == "375"
    assert flags[0]["shortage_value"] == 22_500  # 375 ml × $60/ml


# ---------------------------------------------------------------------------
# Configuración, flag y permisos.
# ---------------------------------------------------------------------------


def test_an_item_is_counted_in_a_single_area(
    store: Store, admin_client: TestClient, bar_and_kitchen: dict[str, Any]
) -> None:
    resp = _items(admin_client, store, bar_and_kitchen["bar"]["id"], [bar_and_kitchen["ron"]["id"], bar_and_kitchen["carne"]["id"]])
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "ITEM_IN_OTHER_AREA"
    assert "Cocina" in resp.json()["error"]["message"]
    areas = admin_client.get(f"{API}/admin/count-areas?store_id={store.id}").json()
    bar = next(a for a in areas if a["name"] == "Bar")
    assert [i["name"] for i in bar["items"]] == ["Ron"]
    assert [m["employee_name"] for m in bar["members"]] == ["Operator"]


def test_a_list_holds_at_most_fifteen_items(store: Store, admin_client: TestClient, shift_counts_on: None) -> None:
    area = _area(admin_client, store, "Bodega")
    resp = _items(admin_client, store, area["id"], list(range(1, 17)))
    assert resp.status_code == 400 and resp.json()["error"]["code"] == "VALIDATION_ERROR"


def test_with_the_feature_off_every_route_says_feature_disabled_and_today_is_empty(
    store: Store, admin_client: TestClient, device_client: TestClient, identify: Callable[..., Any],
    employees: dict[str, Employee], set_feature: Callable[..., None], shift_counts_on: None,
) -> None:
    set_feature("inventory.shift_counts", False)
    identify(device_client, employees["operator"])
    for resp in (
        device_client.get(f"{API}/device/area-count"),
        device_client.post(f"{API}/device/area-counts", json={"moment": "opening", "lines": [{"ingredient_id": 1, "qty": "1"}]}, headers=_h()),
        admin_client.get(f"{API}/admin/count-areas?store_id={store.id}"),
        admin_client.get(f"{API}/admin/area-counts?store_id={store.id}"),
    ):
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
    today = admin_client.get(f"{API}/admin/today?store_id={store.id}").json()
    assert today["area_counts_enabled"] is False and today["area_counts_areas"] == []


def test_the_dependency_is_checked_first(
    store: Store, admin_client: TestClient, set_feature: Callable[..., None], shift_counts_on: None
) -> None:
    set_feature("inventory.perpetual", False)
    resp = admin_client.get(f"{API}/admin/count-areas?store_id={store.id}")
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
    assert "inventory.perpetual" in resp.json()["error"]["message"]


def test_permissions_device_cannot_configure_and_other_org_is_404(
    store: Store, store_b: Store, admin_client: TestClient, device_client: TestClient, identify: Callable[..., Any],
    employees: dict[str, Employee], bar_and_kitchen: dict[str, Any],
) -> None:
    identify(device_client, employees["operator"])
    assert device_client.get(f"{API}/admin/count-areas?store_id={store.id}").status_code == 401
    assert device_client.post(
        f"{API}/admin/area-recounts?store_id={store.id}",
        json={"area_id": bar_and_kitchen["bar"]["id"], "ingredient_ids": [bar_and_kitchen["ron"]["id"]]}, headers=_h(),
    ).status_code == 401
    assert admin_client.get(f"{API}/admin/count-areas?store_id={store_b.id}").status_code == 404


def test_writing_a_count_needs_an_identified_person(
    device_client: TestClient, bar_and_kitchen: dict[str, Any]
) -> None:
    resp = _count(device_client, "opening", [(bar_and_kitchen["ron"]["id"], "1")])
    assert resp.status_code == 401
    # La lista también pide persona: sin saber quién es, no hay área que mostrar.
    board = device_client.get(f"{API}/device/area-count")
    assert board.status_code == 401 and board.json()["error"]["code"] == "IDENTIFY_REQUIRED"


def test_catalog_declares_the_feature_on_in_standard_and_full() -> None:
    from app.core.features import FEATURE_BY_KEY

    feature = FEATURE_BY_KEY["inventory.shift_counts"]
    assert feature.requires == ["inventory.perpetual"]
    assert feature.defaults == {"basic": False, "standard": True, "full": True}


def test_with_nothing_counted_yet_the_night_suggests_closing(
    device_client: TestClient, identify: Callable[..., Any], employees: dict[str, Employee],
    bar_and_kitchen: dict[str, Any], clock: Any,
) -> None:
    clock.set(datetime(2026, 5, 3, 2, 0, tzinfo=timezone.utc))  # 21:00 en Bogotá
    identify(device_client, employees["operator"])
    assert _board(device_client)["suggested_moment"] == "closing"
    clock.set(datetime(2026, 5, 3, 7, 30, tzinfo=timezone.utc))  # 2:30, antes del corte de las 6:00
    identify(device_client, employees["operator"])
    assert _board(device_client)["suggested_moment"] == "closing"
