"""«El operador no ve costos»: el KDS es superficie de DISPOSITIVO (sesión de
dispositivo, no de admin). Ninguna respuesta de ninguna ruta de
`app/kitchen/**` puede declarar `cost`/`margin` (ni anidado) en su esquema
OpenAPI, y ninguna de mis rutas puede colarse como si exigiera
`current_admin`.

Este archivo NO reemplaza el barrido compartido
(`tests/payments/test_documents.py::
test_openapi_device_responses_never_expose_cost_fields`, que recorre TODO
`/api/v1` y ya cubre estas rutas apenas están montadas) — es la verificación
acotada a mi propio territorio que puedo correr sin tocar `tests/audit/**` ni
disparar la suite compartida (`AGENTS.md § Verificación`). Importa las
utilidades de `tests.audit.conftest` de sólo LECTURA (mismo patrón que ya usa
`tests/payments/test_documents.py`): no se escribe nada ahí."""

from __future__ import annotations

from app.main import app


def test_no_kitchen_response_schema_declares_cost_or_margin() -> None:
    from tests.audit.conftest import MONEY_LEAK_SUBSTRINGS, openapi_properties_reachable_from

    spec = app.openapi()
    # `GET`/`POST /kitchen/print-jobs` comparten una sola clave de `path` en
    # el OpenAPI (el método las distingue adentro): 5 paths para las 6 rutas.
    kitchen_paths = {p for p in spec.get("paths", {}) if p.startswith("/api/v1/kitchen")}
    assert len(kitchen_paths) >= 5, f"no se encontraron las rutas nuevas del KDS en el OpenAPI: {sorted(kitchen_paths)}"
    for anchor in (
        "/api/v1/kitchen/rounds",
        "/api/v1/kitchen/items/{item_id}/bump",
        "/api/v1/kitchen/items/{item_id}/unbump",
        "/api/v1/kitchen/orders/{order_id}/expedite",
        "/api/v1/kitchen/print-jobs",
    ):
        assert anchor in kitchen_paths, f"{anchor} no está en el OpenAPI"

    leaked = [
        (where, prop)
        for where, prop in openapi_properties_reachable_from(spec, kitchen_paths)
        if any(secret in prop.lower() for secret in MONEY_LEAK_SUBSTRINGS)
    ]
    assert not leaked, (
        "el OpenAPI declara costo/margen alcanzable desde una ruta del KDS: "
        + "; ".join(f"{w} :: {p}" for w, p in sorted(leaked))
    )


def test_no_kitchen_route_requires_current_admin() -> None:
    """El criterio con el que se acota el barrido NO es el texto del path,
    es la sesión: `current_admin` en el árbol de dependencias. Ninguna ruta
    de `kitchen` lo tiene — todas son de dispositivo (`current_device`/
    `current_operator`)."""
    from tests.audit.conftest import admin_only_paths

    admin_paths = admin_only_paths()
    kitchen_admin_paths = {p for p in admin_paths if p.startswith("/api/v1/kitchen")}
    assert kitchen_admin_paths == set(), f"rutas de kitchen que exigen current_admin: {kitchen_admin_paths}"
