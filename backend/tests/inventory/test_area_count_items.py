"""Conteo por área artículo por artículo, obligatorio al abrir, y conteo
completo mensual (`app/inventory/area_counts.py`, migración 0030).

Lo que el dueño decidió y estos tests fijan:
- cada artículo se guarda al contarlo, con quién y a qué hora;
- la pantalla trae las listas de TODAS las áreas (Mi área | Bar | Cocina |
  Todo): cualquiera ayuda a contar cualquier área;
- a ciegas también entre compañeros: se ve «contado por Kevin 7:10», nunca
  la cantidad; recontar agrega otra entrada, manda la última y la anterior
  queda en el historial del administrador;
- la apertura está completa cuando todos los artículos tienen conteo, y es
  obligatoria: `gate` frena a quien es del área (no al supervisor), el KDS
  sólo recibe la lista de pendientes;
- no hace falta caja abierta: el faltante de la noche sale igual, artículo
  por artículo, con `esperado = contado antes + entradas − salidas`;
- el día del conteo completo mensual la lista es todo lo del área por
  categoría; el tope de 15 es sólo de la lista corta.
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
from app.inventory.models import AreaCount, AreaCountLine, CostSource, Ingredient, MovementCause
from app.shifts.models import Shift
from app.stores.models import Store

API = "/api/v1"
MORNING = datetime(2026, 5, 2, 12, 0, tzinfo=timezone.utc)  # 7:00 en Bogotá, día operativo 2 de mayo


def _h() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


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


@pytest.fixture()
def setup(
    admin_client: TestClient,
    store: Store,
    employees: dict[str, Employee],
    create_ingredient: Callable[..., dict[str, Any]],
    set_feature: Callable[..., None],
    clock: Any,
) -> dict[str, Any]:
    """Bar (ron) y Cocina (carne, huevos). Operator es del bar; Operator2,
    de cocina; Operator3 no tiene área."""
    for key in ("catalog.recipes", "inventory.perpetual", "inventory.waste", "inventory.shift_counts"):
        set_feature(key, True)
    clock.set(MORNING)
    ron = create_ingredient(name="Ron", base_unit="ml", purchase_unit="botella", purchase_factor=750, official_cost="60")
    carne = create_ingredient(name="Carne", base_unit="g", purchase_unit="kg", purchase_factor=1000, official_cost="30")
    huevos = create_ingredient(name="Huevos", base_unit="unit", purchase_unit="panal", purchase_factor=30, official_cost="500")
    areas = {}
    for name in ("Bar", "Cocina"):
        resp = admin_client.post(f"{API}/admin/count-areas?store_id={store.id}", json={"name": name})
        assert resp.status_code == 201, resp.text
        areas[name] = resp.json()
    for area, ids in ((areas["Bar"], [ron["id"]]), (areas["Cocina"], [carne["id"], huevos["id"]])):
        resp = admin_client.put(
            f"{API}/admin/count-areas/{area['id']}/items?store_id={store.id}", json={"ingredient_ids": ids}
        )
        assert resp.status_code == 200, resp.text
    for emp, area in ((employees["operator"], areas["Bar"]), (employees["operator2"], areas["Cocina"])):
        resp = admin_client.put(
            f"{API}/admin/count-area-members?store_id={store.id}", json={"employee_id": emp.id, "area_id": area["id"]}
        )
        assert resp.status_code == 200, resp.text
    return {"ron": ron, "carne": carne, "huevos": huevos, "bar": areas["Bar"], "cocina": areas["Cocina"]}


def _sheet(client: TestClient) -> dict[str, Any]:
    resp = client.get(f"{API}/device/area-count/sheet")
    assert resp.status_code == 200, resp.text
    return resp.json()


def _gate(client: TestClient) -> dict[str, Any]:
    resp = client.get(f"{API}/device/area-count/gate")
    assert resp.status_code == 200, resp.text
    return resp.json()


def _item(client: TestClient, area_id: int, ingredient_id: int, qty: str, moment: str = "opening") -> Any:
    return client.post(
        f"{API}/device/area-count-items",
        json={"area_id": area_id, "moment": moment, "ingredient_id": ingredient_id, "qty": qty},
        headers=_h(),
    )


def _area(sheet: dict[str, Any], name: str) -> dict[str, Any]:
    return next(a for a in sheet["areas"] if a["area_name"] == name)


def _move(db: Session, store: Store, employee: Employee, clock: Any, ingredient_id: int, qty: int, cause: MovementCause) -> None:
    actor = Actor(
        kind="admin", organization_id=store.organization_id, store_id=store.id,
        employee_id=employee.id, employee_name=employee.name, role=employee.role,
    )
    hooks.record_movement(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=ingredient_id,
        qty_base=qty, cause=cause, cost_micros=parse_cost_micros("30"), cost_source=CostSource.OFFICIAL,
        actor=actor, business_date=clock.now().date(), at=clock.now(),
    )
    db.commit()


# ---------------------------------------------------------------------------
# Artículo por artículo, a ciegas, con quién y cuándo.
# ---------------------------------------------------------------------------


def test_each_item_saves_alone_with_who_and_when_and_nobody_sees_the_quantity(
    db: Session, store: Store, admin_client: TestClient, device_client: TestClient, identify: Callable[..., Any],
    employees: dict[str, Employee], setup: dict[str, Any], clock: Any,
) -> None:
    cocina, carne, huevos = setup["cocina"]["id"], setup["carne"]["id"], setup["huevos"]["id"]
    identify(device_client, employees["operator2"])
    saved = _item(device_client, cocina, carne, "9,5")
    assert saved.status_code == 201, saved.text
    body = saved.json()
    assert body["employee_name"] == "Operator2" and body["ingredient_name"] == "Carne"
    assert body["progress"] == {
        "counted": 1, "total": 2, "complete": False, "completed_at": None, "people": ["Operator2"],
    }

    sheet = _sheet(device_client)
    assert {a["area_name"] for a in sheet["areas"]} == {"Bar", "Cocina"}  # todas las áreas: se filtra en la pantalla
    assert sheet["my_area_id"] == cocina
    row = next(i for i in _area(sheet, "Cocina")["items"] if i["ingredient_id"] == carne)
    assert row["opening"]["employee_name"] == "Operator2" and row["opening"]["entries"] == 1
    assert row["closing"] is None
    # A ciegas: ni la cantidad tecleada, ni stock, ni esperado, ni costo, en la tablet.
    prohibidas = {"qty", "qty_base", "entered_qty", "counted_qty", "expected_qty", "reference_qty", "shortage_qty", "stock"}
    for payload in (body, sheet):
        keys = _deep_keys(payload)
        assert not keys & prohibidas, keys & prohibidas
        assert not {k for k in keys if "cost" in k or "value" in k}
    assert "9,5" not in saved.text and "9500" not in device_client.get(f"{API}/device/area-count/sheet").text

    # Recuenta otra persona (la del bar ayuda a la cocina): otra entrada, manda la última.
    clock.set(datetime(2026, 5, 2, 12, 10, tzinfo=timezone.utc))
    identify(device_client, employees["operator"])
    again = _item(device_client, cocina, carne, "9")
    assert again.status_code == 201, again.text
    row = next(i for i in _area(_sheet(device_client), "Cocina")["items"] if i["ingredient_id"] == carne)
    assert row["opening"]["employee_name"] == "Operator" and row["opening"]["entries"] == 2
    assert db.execute(select(func.count(AreaCountLine.id))).scalar_one() == 2  # nada se pisa
    assert db.execute(select(func.count(AreaCount.id))).scalar_one() == 1  # una sola sesión

    assert _item(device_client, cocina, huevos, "30").status_code == 201
    detail = admin_client.get(f"{API}/admin/area-counts/{body['count_id']}?store_id={store.id}").json()
    assert detail["scope"] == "short"
    assert detail["people"] == ["Operator"]  # la entrada que manda de cada artículo
    line = next(l for l in detail["lines"] if l["ingredient_id"] == carne)
    assert line["counted_qty"] == "9000" and line["employee_name"] == "Operator"
    assert [(h["employee_name"], h["counted_qty"]) for h in line["history"]] == [("Operator2", "9500")]

    status = admin_client.get(f"{API}/admin/area-count-status?store_id={store.id}").json()
    kitchen = next(a for a in status["areas"] if a["area_name"] == "Cocina")
    assert kitchen["opening"]["complete"] is True and kitchen["opening"]["counted"] == 2


def test_an_item_outside_todays_list_and_a_bad_quantity_write_nothing(
    db: Session, device_client: TestClient, identify: Callable[..., Any], employees: dict[str, Employee],
    setup: dict[str, Any],
) -> None:
    identify(device_client, employees["operator3"])
    wrong_area = _item(device_client, setup["bar"]["id"], setup["carne"]["id"], "1")
    assert wrong_area.status_code == 400 and wrong_area.json()["error"]["code"] == "ITEM_NOT_IN_LIST"
    bad = _item(device_client, setup["cocina"]["id"], setup["huevos"]["id"], "5,5")
    assert bad.status_code == 400 and "unidades enteras" in bad.json()["error"]["message"]
    assert db.execute(select(func.count(AreaCount.id))).scalar_one() == 0
    # Sin área propia también cuenta: ayuda a la que sea.
    assert _item(device_client, setup["cocina"]["id"], setup["huevos"]["id"], "5").status_code == 201
    sheet = _sheet(device_client)
    assert sheet["my_area_id"] is None and "ayudar" in sheet["reason"]


def test_the_item_save_is_idempotent_and_needs_a_person(
    db: Session, device_client: TestClient, identify: Callable[..., Any], employees: dict[str, Employee],
    setup: dict[str, Any],
) -> None:
    body = {"area_id": setup["bar"]["id"], "moment": "opening", "ingredient_id": setup["ron"]["id"], "qty": "2.3"}
    anon = device_client.post(f"{API}/device/area-count-items", json=body, headers=_h())
    assert anon.status_code == 401
    identify(device_client, employees["operator"])
    key = {"Idempotency-Key": str(uuid4())}
    first = device_client.post(f"{API}/device/area-count-items", json=body, headers=key)
    second = device_client.post(f"{API}/device/area-count-items", json=body, headers=key)
    assert first.status_code == second.status_code == 201
    assert first.json() == second.json()
    assert db.execute(select(func.count(AreaCountLine.id))).scalar_one() == 1


# ---------------------------------------------------------------------------
# Obligatorio al abrir: el gate, el KDS y Hoy.
# ---------------------------------------------------------------------------


def test_the_opening_is_mandatory_for_the_area_until_every_item_is_counted(
    store: Store, admin_client: TestClient, device_client: TestClient, identify: Callable[..., Any],
    employees: dict[str, Employee], setup: dict[str, Any],
) -> None:
    # Sin persona (el KDS mirando): nadie frenado, pero la lista de pendientes para el aviso rojo.
    kds = _gate(device_client)
    assert kds["required"] is False
    assert {p["area_name"] for p in kds["pending"]} == {"Bar", "Cocina"}

    identify(device_client, employees["operator2"])
    gate = _gate(device_client)
    assert gate["required"] is True and gate["area_name"] == "Cocina"
    assert "Primero el conteo de apertura" in gate["message"]
    assert _sheet(device_client)["opening_required"] is True

    # Quien no tiene área y el supervisor no quedan frenados.
    identify(device_client, employees["operator3"])
    assert _gate(device_client)["required"] is False
    identify(device_client, employees["supervisor"])
    assert _gate(device_client)["required"] is False

    today = admin_client.get(f"{API}/admin/today?store_id={store.id}").json()
    assert {a["area_name"]: a["opening"] for a in today["area_counts_areas"]}["Cocina"] is None

    identify(device_client, employees["operator2"])
    assert _item(device_client, setup["cocina"]["id"], setup["carne"]["id"], "10").status_code == 201
    assert _gate(device_client)["required"] is True  # falta uno: sigue pendiente, y Hoy sigue en rojo
    today = admin_client.get(f"{API}/admin/today?store_id={store.id}").json()
    assert {a["area_name"]: a["opening"] for a in today["area_counts_areas"]}["Cocina"] is None

    identify(device_client, employees["operator"])  # el del bar termina la cocina
    last = _item(device_client, setup["cocina"]["id"], setup["huevos"]["id"], "30")
    assert last.json()["progress"]["complete"] is True
    identify(device_client, employees["operator2"])
    gate = _gate(device_client)
    assert gate["required"] is False
    assert [p["area_name"] for p in gate["pending"]] == ["Bar"]
    today = admin_client.get(f"{API}/admin/today?store_id={store.id}").json()
    opening = {a["area_name"]: a["opening"] for a in today["area_counts_areas"]}["Cocina"]
    assert opening["employee_name"] == "Operator2, Operator"


def test_the_gate_lets_go_once_the_closing_started(
    device_client: TestClient, identify: Callable[..., Any], employees: dict[str, Employee], setup: dict[str, Any],
    clock: Any,
) -> None:
    clock.set(datetime(2026, 5, 3, 2, 0, tzinfo=timezone.utc))  # 21:00: nadie abrió, ya se cierra
    identify(device_client, employees["operator"])
    assert _gate(device_client)["required"] is True
    assert _item(device_client, setup["bar"]["id"], setup["ron"]["id"], "3", moment="closing").status_code == 201
    assert _gate(device_client)["required"] is False


# ---------------------------------------------------------------------------
# Sin caja abierta: el faltante de la noche, artículo por artículo.
# ---------------------------------------------------------------------------


def test_the_night_shortage_works_item_by_item_without_any_cash_shift(
    db: Session, store: Store, admin_client: TestClient, device_client: TestClient, identify: Callable[..., Any],
    employees: dict[str, Employee], setup: dict[str, Any], clock: Any,
) -> None:
    cocina, carne, huevos = setup["cocina"]["id"], setup["carne"]["id"], setup["huevos"]["id"]
    assert db.execute(select(func.count(Shift.id))).scalar_one() == 0  # ninguna caja, ni abierta ni cerrada
    cook = employees["operator2"]

    # Día 1, 22:00: cierre artículo por artículo.
    clock.set(datetime(2026, 5, 3, 3, 0, tzinfo=timezone.utc))
    identify(device_client, cook)
    assert _item(device_client, cocina, carne, "10", moment="closing").status_code == 201
    assert _item(device_client, cocina, huevos, "30", moment="closing").status_code == 201

    # 23:00: una venta de 1 kg de carne después del cierre.
    clock.set(datetime(2026, 5, 3, 4, 0, tzinfo=timezone.utc))
    _move(db, store, employees["admin"], clock, carne, -1_000_000, MovementCause.SALE)

    # Día 2, 7:00: abre la carne (8,5 kg: esperado 9, faltan 500 g).
    clock.set(datetime(2026, 5, 3, 12, 0, tzinfo=timezone.utc))
    identify(device_client, cook)
    opening = _item(device_client, cocina, carne, "8.5")
    assert opening.status_code == 201, opening.text
    # 7:15 se venden 2 huevos; 7:30 se cuentan los huevos: esperado 28, contó 28.
    clock.set(datetime(2026, 5, 3, 12, 15, tzinfo=timezone.utc))
    _move(db, store, employees["admin"], clock, huevos, -2_000, MovementCause.SALE)
    clock.set(datetime(2026, 5, 3, 12, 30, tzinfo=timezone.utc))
    identify(device_client, cook)
    assert _item(device_client, cocina, huevos, "28").status_code == 201

    detail = admin_client.get(f"{API}/admin/area-counts/{opening.json()['count_id']}?store_id={store.id}").json()
    assert detail["window"] == "night" and detail["reference_count_id"] is not None
    meat = next(l for l in detail["lines"] if l["ingredient_id"] == carne)
    assert meat["reference_qty"] == "10000" and meat["outflow_qty"] == "1000" and meat["expected_qty"] == "9000"
    assert meat["shortage_qty"] == "500"
    eggs = next(l for l in detail["lines"] if l["ingredient_id"] == huevos)
    # La venta de las 7:15 cae en la ventana de los huevos (contados 7:30), no en la de la carne (7:00).
    assert eggs["outflow_qty"] == "2" and eggs["expected_qty"] == "28" and eggs["shortage_qty"] == "0"
    assert eggs["counted_at"] > meat["counted_at"]


# ---------------------------------------------------------------------------
# Conteo completo mensual.
# ---------------------------------------------------------------------------


def test_the_monthly_full_count_lists_everything_of_the_area_by_category(
    db: Session, store: Store, admin_client: TestClient, device_client: TestClient, identify: Callable[..., Any],
    employees: dict[str, Employee], setup: dict[str, Any], create_ingredient: Callable[..., dict[str, Any]],
    clock: Any,
) -> None:
    cocina, bar = setup["cocina"], setup["bar"]
    extras = [create_ingredient(name=f"Corte {n:02d}") for n in range(16)]  # 16 > el tope de 15 de la lista corta
    licor = create_ingredient(name="Aguardiente", base_unit="ml", purchase_unit="botella", purchase_factor=750)
    db.get(Ingredient, licor["id"]).category = "Licores"  # type: ignore[union-attr]
    db.commit()

    put = admin_client.put(
        f"{API}/admin/count-areas/{cocina['id']}/categories?store_id={store.id}", json={"categories": ["proteínas "]}
    )
    assert put.status_code == 200, put.text
    assert put.json()["categories"] == ["proteínas"]
    # 2 de la lista corta + 16 cortes; el Ron está en la lista del Bar y el Aguardiente es Licores.
    assert put.json()["full_count_items"] == 18
    clash = admin_client.put(
        f"{API}/admin/count-areas/{bar['id']}/categories?store_id={store.id}", json={"categories": ["Proteínas"]}
    )
    assert clash.status_code == 400 and clash.json()["error"]["code"] == "CATEGORY_IN_OTHER_AREA"
    assert admin_client.put(
        f"{API}/admin/count-areas/{bar['id']}/categories?store_id={store.id}", json={"categories": ["Licores"]}
    ).status_code == 200

    identify(device_client, employees["operator2"])
    assert _area(_sheet(device_client), "Cocina")["scope"] == "short"
    early = _item(device_client, cocina["id"], extras[0]["id"], "1")
    assert early.status_code == 400 and early.json()["error"]["code"] == "ITEM_NOT_IN_LIST"

    # Hoy es 2 de mayo: el conteo completo es el día 2.
    settings = admin_client.put(
        f"{API}/admin/area-count-settings?store_id={store.id}",
        json={"threshold_pct_bp": 200, "threshold_amount": 20_000, "monthly_full_count_day": 2},
    )
    assert settings.status_code == 200, settings.text
    assert settings.json()["full_count_today"] is True and "hoy" in settings.json()["monthly_reading"]
    too_late = admin_client.put(
        f"{API}/admin/area-count-settings?store_id={store.id}", json={"monthly_full_count_day": 29}
    )
    assert too_late.status_code in (400, 422)
    # Guardar sólo el umbral no apaga el conteo completo.
    kept = admin_client.put(
        f"{API}/admin/area-count-settings?store_id={store.id}", json={"threshold_pct_bp": 300, "threshold_amount": None}
    )
    assert kept.json()["monthly_full_count_day"] == 2

    identify(device_client, employees["operator2"])
    sheet = _sheet(device_client)
    assert sheet["full_count_today"] is True
    kitchen = _area(sheet, "Cocina")
    assert kitchen["scope"] == "full" and kitchen["opening"]["total"] == 18
    assert [i["name"] for i in kitchen["items"]][:2] == ["Carne", "Huevos"]  # la lista corta primero
    assert [i["name"] for i in _area(sheet, "Bar")["items"]] == ["Ron", "Aguardiente"]
    saved = _item(device_client, cocina["id"], extras[0]["id"], "1")
    assert saved.status_code == 201, saved.text
    assert saved.json()["progress"]["total"] == 18
    gate = _gate(device_client)
    assert gate["required"] is True and {p["area_name"]: p["full_count"] for p in gate["pending"]}["Cocina"] is True
    detail = admin_client.get(f"{API}/admin/area-counts/{saved.json()['count_id']}?store_id={store.id}").json()
    assert detail["scope"] == "full"

    off = admin_client.put(
        f"{API}/admin/area-count-settings?store_id={store.id}",
        json={"threshold_pct_bp": 300, "threshold_amount": None, "monthly_full_count_day": None},
    )
    assert off.json()["monthly_full_count_day"] is None and "apagado" in off.json()["monthly_reading"]


def test_the_new_routes_say_feature_disabled_with_the_feature_off(
    store: Store, admin_client: TestClient, device_client: TestClient, identify: Callable[..., Any],
    employees: dict[str, Employee], setup: dict[str, Any], set_feature: Callable[..., None],
) -> None:
    set_feature("inventory.shift_counts", False)
    identify(device_client, employees["operator"])
    for resp in (
        device_client.get(f"{API}/device/area-count/sheet"),
        device_client.get(f"{API}/device/area-count/gate"),
        _item(device_client, setup["bar"]["id"], setup["ron"]["id"], "1"),
        admin_client.get(f"{API}/admin/area-count-status?store_id={store.id}"),
        admin_client.put(
            f"{API}/admin/count-areas/{setup['bar']['id']}/categories?store_id={store.id}", json={"categories": []}
        ),
    ):
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
