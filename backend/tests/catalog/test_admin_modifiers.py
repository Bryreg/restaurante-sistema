"""Grupos de modificadores: creación con opciones anidadas, edición
(upsert por `id`), disponibilidad por opción, y el flag `pos.modifiers`."""

from __future__ import annotations

from typing import Any, Callable

from fastapi.testclient import TestClient

from app.stores.models import Store


def test_create_modifier_group_with_nested_options(
    admin_client: TestClient, create_product: Callable[..., dict[str, Any]]
) -> None:
    product = create_product(name="Lomo al trapo", dine_in=42_000)
    resp = admin_client.post(
        f"/api/v1/admin/modifier-groups?product_id={product['id']}",
        json={
            "name": "Término de la carne",
            "required": True,
            "min": 1,
            "max": 1,
            "options": [{"name": "A punto"}, {"name": "Bien asado"}, {"name": "Poco asado"}],
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["required"] is True
    assert body["min"] == 1 and body["max"] == 1
    assert {o["name"] for o in body["options"]} == {"A punto", "Bien asado", "Poco asado"}
    assert all(o["price_delta"] == 0 for o in body["options"])
    assert all(o["available"] is True for o in body["options"])
    # `recipe_effect` nunca se expone en 1a (siempre nulo internamente).
    assert "recipe_effect" not in body["options"][0]


def test_update_modifier_group_upserts_options_by_id(
    admin_client: TestClient, create_product: Callable[..., dict[str, Any]]
) -> None:
    product = create_product(name="Pechuga a la plancha", dine_in=30_000)
    resp = admin_client.post(
        f"/api/v1/admin/modifier-groups?product_id={product['id']}",
        json={"name": "Acompañamiento extra", "required": False, "min": 0, "max": 2, "options": [{"name": "Papa criolla", "price_delta": 5000}]},
    )
    group = resp.json()
    existing_option_id = group["options"][0]["id"]

    resp = admin_client.patch(
        f"/api/v1/admin/modifier-groups/{group['id']}",
        json={
            "options": [
                {"id": existing_option_id, "name": "Papa criolla", "price_delta": 6000},
                {"name": "Arroz", "price_delta": 3000},
            ]
        },
    )
    assert resp.status_code == 200, resp.text
    options = {o["name"]: o for o in resp.json()["options"]}
    assert options["Papa criolla"]["id"] == existing_option_id
    assert options["Papa criolla"]["price_delta"] == 6000
    assert "Arroz" in options


def test_modifier_group_endpoints_require_feature(
    admin_client: TestClient, create_product: Callable[..., dict[str, Any]], set_feature: Callable[..., None]
) -> None:
    product = create_product(name="Con modificadores", dine_in=20_000)
    set_feature("pos.modifiers", False)
    resp = admin_client.post(
        f"/api/v1/admin/modifier-groups?product_id={product['id']}",
        json={"name": "Grupo", "options": []},
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"


def test_set_modifier_option_availability_records_who_and_when(
    admin_client: TestClient, store: Store, create_product: Callable[..., dict[str, Any]]
) -> None:
    product = create_product(name="Con modificadores", dine_in=20_000)
    resp = admin_client.post(
        f"/api/v1/admin/modifier-groups?product_id={product['id']}",
        json={"name": "Grupo", "options": [{"name": "Extra queso", "price_delta": 2000}]},
    )
    option_id = resp.json()["options"][0]["id"]

    resp = admin_client.post(f"/api/v1/modifier-options/{option_id}/availability", json={"available": False})
    assert resp.status_code == 200, resp.text
    assert resp.json()["available"] is False

    resp = admin_client.get(f"/api/v1/admin/products?store_id={store.id}")
    row = next(p for p in resp.json() if p["id"] == product["id"])
    option = next(o for g in row["modifier_groups"] for o in g["options"] if o["id"] == option_id)
    assert option["available"] is False

    resp = admin_client.get("/api/v1/admin/audit?entity=modifier_option")
    audit_row = next(r for r in resp.json() if r["entity_id"] == str(option_id))
    assert audit_row["before"] == {"available": True}
    assert audit_row["after"] == {"available": False}
