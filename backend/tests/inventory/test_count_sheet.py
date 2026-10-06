"""Tanda 5, i5: la hoja de conteo para imprimir.

Por área, en el orden del estante (el que puso el administrador), después lo
demás del área por categoría y al final lo que no es de ningún área. A
ciegas: ni stock teórico ni costos."""

from __future__ import annotations

from typing import Any, Callable

from fastapi.testclient import TestClient

from app.stores.models import Store

API = "/api/v1"


def _sheet(client: TestClient, store: Store, area_id: int | None = None) -> Any:
    url = f"{API}/admin/count-sheet?store_id={store.id}"
    if area_id is not None:
        url += f"&area_id={area_id}"
    return client.get(url)


def _set_category(client: TestClient, ingredient_id: int, category: str) -> None:
    resp = client.patch(f"{API}/admin/ingredients/{ingredient_id}", json={"category": category})
    assert resp.status_code == 200, resp.text


def _keys(node: Any) -> set[str]:
    if isinstance(node, dict):
        return set(node) | {k for v in node.values() for k in _keys(v)}
    if isinstance(node, list):
        return {k for v in node for k in _keys(v)}
    return set()


def test_sheet_groups_by_area_in_shelf_order_then_the_rest_by_category(
    admin_client: TestClient,
    store: Store,
    set_feature: Callable[..., None],
    create_ingredient: Callable[..., dict[str, Any]],
) -> None:
    for key in ("catalog.recipes", "inventory.perpetual", "inventory.shift_counts"):
        set_feature(key, True)
    ron = create_ingredient(name="Ron", base_unit="ml", purchase_unit="botella", purchase_factor=750)
    aguardiente = create_ingredient(name="Aguardiente", base_unit="ml", purchase_unit="botella", purchase_factor=750)
    limon = create_ingredient(name="Limón", base_unit="unit", purchase_unit="unidad", purchase_factor=1)
    arroz = create_ingredient(name="Arroz", base_unit="g", purchase_unit="bulto", purchase_factor=25_000)
    sal = create_ingredient(name="Sal", base_unit="g", purchase_unit="kg", purchase_factor=1000)
    _set_category(admin_client, limon["id"], "Frutas")
    _set_category(admin_client, arroz["id"], "Granos")
    _set_category(admin_client, sal["id"], "Abarrotes")

    bar = admin_client.post(f"{API}/admin/count-areas?store_id={store.id}", json={"name": "Bar"}).json()
    # El orden del estante: primero el ron, después el aguardiente.
    assert admin_client.put(
        f"{API}/admin/count-areas/{bar['id']}/items?store_id={store.id}",
        json={"ingredient_ids": [ron["id"], aguardiente["id"]]},
    ).status_code == 200
    # Y el resto de la categoría «Frutas» también es del bar.
    assert admin_client.put(
        f"{API}/admin/count-areas/{bar['id']}/categories?store_id={store.id}", json={"categories": ["Frutas"]}
    ).status_code == 200

    resp = _sheet(admin_client, store)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [s["title"] for s in body["sections"]] == ["Bar", "Sin área asignada"]
    bar_items = body["sections"][0]["items"]
    assert [i["name"] for i in bar_items] == ["Ron", "Aguardiente", "Limón"]
    assert bar_items[0]["count_unit"] == "botella"
    rest = body["sections"][1]["items"]
    # Por categoría y nombre: Abarrotes (Sal) antes que Granos (Arroz).
    assert [i["name"] for i in rest] == ["Sal", "Arroz"]
    assert rest[0]["count_unit"] == "kg"
    assert body["areas"] == [{"id": bar["id"], "name": "Bar"}]

    # A ciegas: ni stock ni costos en ninguna parte de la hoja.
    keys = _keys(body)
    assert not {k for k in keys if "stock" in k or "cost" in k or "expected" in k}

    only_bar = _sheet(admin_client, store, bar["id"]).json()
    assert [s["title"] for s in only_bar["sections"]] == ["Bar"]


def test_without_areas_it_is_one_section_and_an_unknown_area_is_404(
    admin_client: TestClient,
    store: Store,
    set_feature: Callable[..., None],
    create_ingredient: Callable[..., dict[str, Any]],
) -> None:
    for key in ("catalog.recipes", "inventory.perpetual"):
        set_feature(key, True)
    set_feature("inventory.shift_counts", False)
    create_ingredient(name="Arroz")
    body = _sheet(admin_client, store).json()
    assert [s["title"] for s in body["sections"]] == ["Todos los insumos"]
    assert _sheet(admin_client, store, 999).status_code == 404


def test_count_sheet_is_admin_only_and_behind_perpetual(
    admin_client: TestClient,
    device_client: TestClient,
    store: Store,
    set_feature: Callable[..., None],
) -> None:
    set_feature("catalog.recipes", True)
    set_feature("inventory.perpetual", False)
    resp = _sheet(admin_client, store)
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
    set_feature("inventory.perpetual", True)
    assert _sheet(device_client, store).status_code in (401, 403)
