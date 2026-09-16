"""El operador no recibe costos ni márgenes: ningún esquema de una ruta de
DISPOSITIVO (`GET /preparations`, `POST /preparations/{id}/produce`) declara
un campo cuyo nombre contenga `cost`, `margin`, `unit_cost` ni `food_cost`.
Es el mismo control que ya corre en `tests/audit/test_security_invariants.py`
(`MONEY_SECRETS`) — replicado acá sobre las rutas nuevas de este dominio
porque ese archivo es ajeno (`backend/tests/audit/**`) y este pedido lo pide
explícito: "hay tres tests sobre el OpenAPI... tienen que seguir pasando con
los dominios nuevos montados"; este test es la contraparte que prueba que
las rutas NUEVAS tampoco filtran nada, sin tocar ese archivo.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

MONEY_SECRETS = ("cost", "margin", "unit_cost", "food_cost")


def _resolve(spec: dict[str, Any], node: Any, seen: set[str], names: set[str]) -> None:
    if isinstance(node, dict):
        if "$ref" in node:
            ref = node["$ref"]
            if ref in seen:
                return
            seen.add(ref)
            schema_name = ref.rsplit("/", 1)[-1]
            target = spec.get("components", {}).get("schemas", {}).get(schema_name)
            if target is not None:
                _resolve(spec, target, seen, names)
            return
        for key, value in node.items():
            if key == "properties" and isinstance(value, dict):
                for prop_name, prop_schema in value.items():
                    names.add(prop_name)
                    _resolve(spec, prop_schema, seen, names)
            else:
                _resolve(spec, value, seen, names)
    elif isinstance(node, list):
        for item in node:
            _resolve(spec, item, seen, names)


def _property_names_for_paths(spec: dict[str, Any], path_prefixes: tuple[str, ...]) -> set[str]:
    names: set[str] = set()
    seen: set[str] = set()
    for path, operations in spec.get("paths", {}).items():
        if not any(path.startswith(prefix) for prefix in path_prefixes):
            continue
        _resolve(spec, operations, seen, names)
    return names


def test_device_preparation_routes_never_declare_cost_fields(client: TestClient) -> None:
    spec = client.get("/openapi.json").json()
    names = _property_names_for_paths(spec, ("/api/v1/preparations",))
    assert names, "no se encontró ningún esquema bajo /preparations (¿el router está montado?)"
    leaked = {n for n in names if any(secret in n.lower() for secret in MONEY_SECRETS)}
    assert not leaked, f"las rutas de dispositivo de preparaciones declaran campos de costo: {sorted(leaked)}"


def test_admin_recipe_routes_are_allowed_to_declare_cost_fields(client: TestClient) -> None:
    """Control negativo: si este test fallara (ADMIN sin ningún campo de
    costo), sería señal de que el escaneo de arriba no está mirando nada."""
    spec = client.get("/openapi.json").json()
    names = _property_names_for_paths(spec, ("/api/v1/admin/preparations", "/api/v1/admin/products"))
    lowered = {n.lower() for n in names}
    assert any("cost" in n for n in lowered)
