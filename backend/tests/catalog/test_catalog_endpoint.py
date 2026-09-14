"""`GET /catalog`: sin costos, con fallback de precio por canal, y las
funciones opcionales (`pos.modifiers`, `pos.combos`) vaciando su lista cuando
están apagadas (checklist del pedido 1a)."""

from __future__ import annotations

from typing import Any, Callable

from fastapi.testclient import TestClient

from app.main import app
from app.stores.models import Store

FORBIDDEN_KEYS = {"cost", "margin", "unit_cost"}


def _assert_no_forbidden_keys(node: Any) -> None:
    if isinstance(node, dict):
        for key, value in node.items():
            assert key not in FORBIDDEN_KEYS, f'clave prohibida "{key}" en la respuesta de /catalog'
            _assert_no_forbidden_keys(value)
    elif isinstance(node, list):
        for item in node:
            _assert_no_forbidden_keys(item)


def test_catalog_response_has_no_cost_fields(
    device_client: TestClient, create_product: Callable[..., dict[str, Any]]
) -> None:
    create_product(name="Producto simple", dine_in=20_000)
    resp = device_client.get("/api/v1/catalog")
    assert resp.status_code == 200, resp.text
    _assert_no_forbidden_keys(resp.json())


def test_openapi_catalog_schema_has_no_cost_fields() -> None:
    """Recorre el esquema de `CatalogOut` (y todo lo que referencia por
    `$ref`) buscando `cost`/`margin`/`unit_cost` entre las propiedades — no
    alcanza con mirar sólo una respuesta concreta, porque un campo opcional
    ausente en una muestra no demuestra que no exista en el contrato."""
    schema = app.openapi()
    components: dict[str, Any] = schema["components"]["schemas"]
    catalog_get = schema["paths"]["/api/v1/catalog"]["get"]
    response_schema = catalog_get["responses"]["200"]["content"]["application/json"]["schema"]

    visited: set[str] = set()

    def _ref_name(ref: str) -> str:
        return ref.split("/")[-1]

    def _walk(node: Any) -> None:
        if isinstance(node, dict):
            if "$ref" in node:
                name = _ref_name(node["$ref"])
                if name in visited:
                    return
                visited.add(name)
                _walk(components[name])
                return
            for key, value in node.items():
                if key == "properties":
                    for prop_name, prop_schema in value.items():
                        assert prop_name not in FORBIDDEN_KEYS, f'clave prohibida "{prop_name}" en el OpenAPI de /catalog'
                        _walk(prop_schema)
                else:
                    _walk(value)
        elif isinstance(node, list):
            for item in node:
                _walk(item)

    _walk(response_schema)
    assert visited, "no se resolvió ningún esquema desde la respuesta de GET /catalog"


def test_price_takeout_falls_back_to_dine_in_when_absent(
    device_client: TestClient, create_product: Callable[..., dict[str, Any]]
) -> None:
    create_product(name="Sin precio de para llevar", dine_in=20_000, takeout=None)
    create_product(name="Con precio propio", dine_in=20_000, takeout=17_000)

    resp = device_client.get("/api/v1/catalog")
    products = {p["name"]: p for p in resp.json()["products"]}

    assert products["Sin precio de para llevar"]["prices"]["takeout"] == 20_000
    assert products["Sin precio de para llevar"]["prices"]["delivery"] == 20_000
    assert products["Con precio propio"]["prices"]["takeout"] == 17_000


def test_admin_products_list_keeps_raw_null_price(
    admin_client: TestClient, store: Store, create_product: Callable[..., dict[str, Any]]
) -> None:
    """A diferencia de `GET /catalog`, la lista de administración muestra el
    precio crudo (`null` si no se configuró): es lo que el frontend pinta
    como "—" en la tabla de productos."""
    create_product(name="Sin precio de para llevar", dine_in=20_000, takeout=None)
    resp = admin_client.get(f"/api/v1/admin/products?store_id={store.id}")
    row = next(p for p in resp.json() if p["name"] == "Sin precio de para llevar")
    assert row["prices"]["takeout"] is None


def test_modifier_groups_empty_when_feature_disabled(
    device_client: TestClient,
    create_product: Callable[..., dict[str, Any]],
    admin_client: TestClient,
    store: Store,
    set_feature: Callable[..., None],
) -> None:
    product = create_product(name="Con modificadores", dine_in=30_000)
    resp = admin_client.post(
        f"/api/v1/admin/modifier-groups?product_id={product['id']}",
        json={"name": "Término", "required": True, "min": 1, "max": 1, "options": [{"name": "A punto"}]},
    )
    assert resp.status_code == 200, resp.text

    set_feature("pos.modifiers", False)
    resp = device_client.get("/api/v1/catalog")
    body = resp.json()
    modified = next(p for p in body["products"] if p["name"] == "Con modificadores")
    assert modified["modifier_groups"] == []


def test_combos_empty_and_create_blocked_when_feature_disabled(
    device_client: TestClient,
    admin_client: TestClient,
    store: Store,
    set_feature: Callable[..., None],
    create_combo: Callable[..., dict[str, Any]],
    create_product: Callable[..., dict[str, Any]],
) -> None:
    product = create_product(name="Base combo", dine_in=10_000)
    create_combo(groups=[{"name": "Plato", "options": [{"product_id": product["id"]}]}])

    set_feature("pos.combos", False)
    resp = device_client.get("/api/v1/catalog")
    assert resp.json()["combos"] == []

    resp = admin_client.post(
        f"/api/v1/admin/combos?store_id={store.id}",
        json={"name": "Otro combo", "price": 1000, "active": False, "schedule": {"days": [0], "from": "10:00", "to": "12:00"}, "groups": []},
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
    assert resp.json()["error"]["feature"] == "pos.combos"


def test_daily_menu_today_blocked_when_feature_disabled(
    admin_client: TestClient,
    store: Store,
    set_feature: Callable[..., None],
    create_combo: Callable[..., dict[str, Any]],
    create_product: Callable[..., dict[str, Any]],
) -> None:
    product = create_product(name="Sopa del día", dine_in=10_000)
    combo = create_combo(groups=[{"name": "Sopa", "options": [{"product_id": product["id"]}]}])

    set_feature("pos.daily_menu", False)
    option_id = combo["groups"][0]["options"][0]["id"]
    resp = admin_client.put(
        f"/api/v1/admin/combos/{combo['id']}/today", json={"active_option_ids": [option_id]}
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "FEATURE_DISABLED"
    assert resp.json()["error"]["feature"] == "pos.daily_menu"


def test_combo_option_agotado_stays_listed_with_available_today_false(
    admin_client: TestClient,
    device_client: TestClient,
    create_combo: Callable[..., dict[str, Any]],
    create_product: Callable[..., dict[str, Any]],
) -> None:
    product = create_product(name="Sancocho", dine_in=22_000)
    combo = create_combo(groups=[{"name": "Sopa", "options": [{"product_id": product["id"]}]}])
    option_id = combo["groups"][0]["options"][0]["id"]

    resp = admin_client.post(f"/api/v1/combo-options/{option_id}/availability", json={"available": False})
    assert resp.status_code == 200, resp.text
    assert resp.json()["available_today"] is False

    resp = device_client.get("/api/v1/catalog")
    seen = next(c for c in resp.json()["combos"] if c["id"] == combo["id"])
    option = seen["groups"][0]["options"][0]
    assert option["id"] == option_id
    assert option["available_today"] is False
