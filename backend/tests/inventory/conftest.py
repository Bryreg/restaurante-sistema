"""Fixtures propias de `inventory` (no redefine las compartidas de
`tests/conftest.py`, sólo agrega las de acá).

`app.inventory` todavía no está en `app.main.DOMAINS` — otro agente lo agrega
al integrar el dominio (ver `app/inventory/__init__.py` y el "PASO 0" del
mandato de este territorio). Mientras tanto, este conftest monta el router a
mano sobre el `app` compartido, sin tocar `app/main.py`, y se salta el
montaje si "inventory" ya está en `DOMAINS` (para no duplicar rutas una vez
que otro agente lo integre y la suite completa corra en un solo proceso).
"""

from __future__ import annotations

from typing import Any, Callable

import pytest
from fastapi.testclient import TestClient

import app.main as main_module
from app.inventory.router import router as _inventory_router
from app.stores.models import Store

if "inventory" not in main_module.DOMAINS and not getattr(
    main_module.app, "_inventory_router_mounted", False
):
    # `app.main.create_app` registra el fallback SPA (`/{full_path:path}`,
    # cuando existe `frontend/dist`) como la ÚLTIMA ruta. Un `include_router`
    # normal APPENDEA las rutas nuevas al final de `app.routes`, así que
    # quedarían DESPUÉS del catch-all y jamás se alcanzarían (el catch-all
    # matchea cualquier path, incluido `/api/v1/admin/ingredients`). Se saca
    # el catch-all, se monta el router, y se lo vuelve a poner al final.
    _routes = main_module.app.router.routes
    _catch_all = None
    if _routes and getattr(_routes[-1], "path", None) == "/{full_path:path}":
        _catch_all = _routes.pop()
    main_module.app.include_router(_inventory_router, prefix="/api/v1")
    if _catch_all is not None:
        _routes.append(_catch_all)
    main_module.app._inventory_router_mounted = True  # type: ignore[attr-defined]


@pytest.fixture()
def enable_inventory(set_feature: Callable[..., None]) -> Callable[[], None]:
    def _enable() -> None:
        set_feature("catalog.recipes", True)
        set_feature("inventory.perpetual", True)
        set_feature("inventory.waste", True)

    return _enable


@pytest.fixture()
def create_ingredient(admin_client: TestClient, store: Store) -> Callable[..., dict[str, Any]]:
    def _create(
        *,
        name: str = "Pechuga de pollo",
        base_unit: str = "g",
        purchase_unit: str = "kg",
        purchase_factor: int = 1000,
        yield_pct: int = 100,
        official_cost: str | None = "10",
        estimated_cost: str | None = None,
        min_stock: str = "1000",
        key_item: bool = False,
        consumption_untracked: bool = False,
        substitute_ingredient_id: int | None = None,
        active: bool = True,
    ) -> dict[str, Any]:
        resp = admin_client.post(
            f"/api/v1/admin/ingredients?store_id={store.id}",
            json={
                "name": name,
                "category": "Proteínas",
                "base_unit": base_unit,
                "purchase_unit": purchase_unit,
                "purchase_factor": purchase_factor,
                "yield_pct": yield_pct,
                "official_cost": official_cost,
                "estimated_cost": estimated_cost,
                "min_stock": min_stock,
                "key_item": key_item,
                "consumption_untracked": consumption_untracked,
                "substitute_ingredient_id": substitute_ingredient_id,
                "active": active,
            },
        )
        assert resp.status_code == 201, resp.text
        return resp.json()

    return _create
