"""Pedir insumos desde la tablet sin 58 toques (auditoría de tablet).

- Las sugerencias se filtran por el área de quien pide (Conteo por área) y,
  sin área asignada, por la que se llama como su puesto.
- Se pide en la unidad cómoda (kg, botellas, L, unidades) y el servidor
  convierte una sola vez; lo guardado sigue en la unidad base.
- La cantidad sugerida viene redondeada hacia arriba a la unidad cómoda.
- «Frecuentes»: lo que más se pidió en la sede.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.auth.models import Employee
from app.inventory.models import BaseUnit
from app.requests.models import StaffRequestLine
from tests.requests.conftest import API, find_secret_keys, idem


def _area(admin_client: Any, store_id: int, name: str, ingredient_ids: list[int]) -> int:
    created = admin_client.post(f"{API}/admin/count-areas", params={"store_id": store_id}, json={"name": name})
    assert created.status_code == 201, created.text
    area_id = int(created.json()["id"])
    items = admin_client.put(
        f"{API}/admin/count-areas/{area_id}/items",
        params={"store_id": store_id},
        json={"ingredient_ids": ingredient_ids},
    )
    assert items.status_code == 200, items.text
    return area_id


def test_suggestions_are_filtered_by_the_requesters_area(
    device_client, admin_client, open_shift, make_ingredient, store, employees
) -> None:
    open_shift()
    ron = make_ingredient("Ron", min_stock=3_000_000, base_unit=BaseUnit.ML)
    papa = make_ingredient("Papa", min_stock=2_000_000)
    bar = _area(admin_client, store.id, "Bar", [ron.id])
    _area(admin_client, store.id, "Cocina", [papa.id])
    assigned = admin_client.put(
        f"{API}/admin/count-area-members",
        params={"store_id": store.id},
        json={"employee_id": employees["cashier"].id, "area_id": bar},
    )
    assert assigned.status_code == 200, assigned.text

    body = device_client.get(f"{API}/requests/supply-suggestions").json()
    assert body["area_name"] == "Bar"
    assert body["area_via"] == "member"
    assert [r["ingredient_id"] for r in body["rows"]] == [ron.id]
    assert body["other_areas_count"] == 1
    assert find_secret_keys(body) == []


def test_without_an_assigned_area_the_puesto_picks_the_area(
    device_client, admin_client, open_shift, make_ingredient, store, employees, db: Session
) -> None:
    open_shift()
    ron = make_ingredient("Ron", min_stock=3_000_000, base_unit=BaseUnit.ML)
    papa = make_ingredient("Papa", min_stock=2_000_000)
    _area(admin_client, store.id, "Bar", [ron.id])
    _area(admin_client, store.id, "Cocina", [papa.id])
    cashier = db.get(Employee, employees["cashier"].id)
    assert cashier is not None
    cashier.puesto = "cocina"
    db.commit()

    body = device_client.get(f"{API}/requests/supply-suggestions").json()
    assert body["area_via"] == "puesto"
    assert body["area_name"] == "Cocina"
    assert [r["ingredient_id"] for r in body["rows"]] == [papa.id]


def test_without_area_nor_puesto_the_whole_store_is_suggested(device_client, open_shift, make_ingredient) -> None:
    open_shift()
    ron = make_ingredient("Ron", min_stock=3_000_000, base_unit=BaseUnit.ML)
    papa = make_ingredient("Papa", min_stock=2_000_000)
    body = device_client.get(f"{API}/requests/supply-suggestions").json()
    assert body["area_via"] == "none"
    assert {r["ingredient_id"] for r in body["rows"]} >= {ron.id, papa.id}
    assert body["other_areas_count"] == 0


def test_suggested_quantity_is_rounded_up_in_the_comfortable_unit(device_client, open_shift, make_ingredient) -> None:
    open_shift()
    # 503,177 g de faltante: se sugiere 1 kg (medio kilo hacia arriba), no 503,177 g.
    carne = make_ingredient("Carne", min_stock=503_177)
    # ml con unidad de compra de 1000 ml (la fixture: «kg», factor 1000) → botellas enteras.
    ron = make_ingredient("Ron", min_stock=1_200_000, base_unit=BaseUnit.ML)
    huevo = make_ingredient("Huevo", min_stock=2_500, base_unit=BaseUnit.UNIT)
    rows = {r["ingredient_id"]: r for r in device_client.get(f"{API}/requests/supply-suggestions").json()["rows"]}
    assert (rows[carne.id]["entry_unit"], rows[carne.id]["suggested_entry_qty"]) == ("kg", "1")
    assert rows[carne.id]["suggested_qty"] == "1000"
    assert rows[ron.id]["entry_mode"] == "bottle"
    assert rows[ron.id]["suggested_entry_qty"] == "2"
    assert rows[huevo.id]["entry_mode"] == "unit"
    assert rows[huevo.id]["suggested_entry_qty"] == "3"


def test_the_request_is_typed_in_the_comfortable_unit_and_stored_in_base(
    device_client, open_shift, make_ingredient, db: Session
) -> None:
    open_shift()
    papa = make_ingredient("Papa", min_stock=1)
    resp = device_client.post(
        f"{API}/requests/supplies",
        json={"lines": [{"ingredient_id": papa.id, "qty": "2,5", "entry_unit": "kg"}]},
        headers=idem(),
    )
    assert resp.status_code == 201, resp.text
    line = resp.json()["lines"][0]
    assert line["qty_requested"] == "2500"
    assert line["entry_unit"] == "kg"
    assert line["qty_requested_entry"] == "2.5"
    stored = db.query(StaffRequestLine).one()
    assert stored.qty_requested == 2_500_000


def test_a_wrong_entry_unit_is_rejected_before_writing(device_client, open_shift, make_ingredient, db: Session) -> None:
    open_shift()
    papa = make_ingredient("Papa", min_stock=1)
    resp = device_client.post(
        f"{API}/requests/supplies",
        json={"lines": [{"ingredient_id": papa.id, "qty": "2", "entry_unit": "botella"}]},
        headers=idem(),
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_ERROR"
    assert db.query(StaffRequestLine).count() == 0


def test_frequent_lists_what_the_store_asks_for_most(device_client, open_shift, make_ingredient) -> None:
    open_shift()
    papa = make_ingredient("Papa", min_stock=1)
    sal = make_ingredient("Sal", min_stock=1)
    for lines in ([papa.id, sal.id], [papa.id], [papa.id]):
        resp = device_client.post(
            f"{API}/requests/supplies",
            json={"lines": [{"ingredient_id": i, "qty": "1", "entry_unit": "kg"} for i in lines]},
            headers=idem(),
        )
        assert resp.status_code == 201, resp.text
    frequent = device_client.get(f"{API}/requests/supply-suggestions").json()["frequent"]
    assert [f["ingredient_id"] for f in frequent][:2] == [papa.id, sal.id]
    assert frequent[0]["entry_unit"] == "kg"
