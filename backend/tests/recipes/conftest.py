"""Fixtures de `tests/recipes/**`.

**Convergencia**: `app.core.quantity` (contrato de `backend-inventario`) y el
dominio `app.inventory` completo pueden no existir todavía cuando este
archivo se colecciona (se escribieron en paralelo, en el mismo pedido). Si
no existen, este `conftest` instala un doble fiel al contrato dado por la
misión (`_quantity_stub.py`, `_inventory_stub.py`, ambos en este mismo
directorio — territorio propio, nunca se importan desde `app/`) ANTES de
importar nada de `app.recipes`. Si ya existen de verdad, no se toca nada:
los tests corren directo contra el dominio real. Ningún test de este
directorio depende de cuál de los dos casos ocurrió.
"""

from __future__ import annotations

import importlib
import sys
import types
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from sqlalchemy.orm import Session


def _stub_module(name: str, build: Callable[[types.ModuleType], None]) -> None:
    module = types.ModuleType(name)
    build(module)
    sys.modules[name] = module
    if "." in name:
        parent_name, child_name = name.rsplit(".", 1)
        parent = sys.modules.get(parent_name)
        if parent is not None:
            setattr(parent, child_name, module)


def _install_stubs() -> None:
    # Importa los dobles SÓLO si hacen falta (import perezoso, adentro de
    # cada rama `except`): `_inventory_stub.py`/`_quantity_stub.py` definen
    # clases ORM de verdad a nivel de módulo, y `Base.metadata` es global —
    # importarlos sin necesidad, aunque después no se usen, ya registra
    # "ingredients"/"stock_movements" y choca con el dominio real si éste
    # también está montado (`Table 'ingredients' is already defined`).
    try:
        importlib.import_module("app.core.quantity")
    except ModuleNotFoundError:
        from tests.recipes import _quantity_stub

        def _quantity(mod: types.ModuleType) -> None:
            mod.QTY_SCALE = _quantity_stub.QTY_SCALE
            mod.COST_SCALE = _quantity_stub.COST_SCALE
            mod.apply_yield = _quantity_stub.apply_yield
            mod.micros_to_pesos = _quantity_stub.micros_to_pesos
            mod.format_cost_micros = _quantity_stub.format_cost_micros

        _stub_module("app.core.quantity", _quantity)

    try:
        importlib.import_module("app.inventory")
        importlib.import_module("app.inventory.models")
        importlib.import_module("app.inventory.hooks")
    except ModuleNotFoundError:
        from tests.recipes import _inventory_stub

        def _inventory_pkg(mod: types.ModuleType) -> None:
            mod.__path__ = []  # type: ignore[attr-defined]

        def _inventory_models(mod: types.ModuleType) -> None:
            mod.MovementCause = _inventory_stub.MovementCause
            mod.CostSource = _inventory_stub.CostSource
            mod.Ingredient = _inventory_stub.Ingredient
            mod.StockMovement = _inventory_stub.StockMovement

        def _inventory_hooks(mod: types.ModuleType) -> None:
            mod.record_movement = _inventory_stub.record_movement
            mod.resolve_ingredient_cost = _inventory_stub.resolve_ingredient_cost
            mod.current_stock = _inventory_stub.current_stock
            mod.get_ingredient = _inventory_stub.get_ingredient

        _stub_module("app.inventory", _inventory_pkg)
        _stub_module("app.inventory.models", _inventory_models)
        _stub_module("app.inventory.hooks", _inventory_hooks)


_install_stubs()

# Con `app.core.quantity`/`app.inventory` ya resueltos (reales o de prueba),
# registrar las tablas de este dominio en `Base.metadata` (la fixture
# compartida `db` de `tests/conftest.py` hace `create_all` con lo que haya
# registrado en ese momento).
import app.recipes.models  # noqa: E402  (después de instalar los stubs, a propósito)

from app.core import clock as clock_module  # noqa: E402
from app.stores.models import Organization, Store  # noqa: E402


def _mount_recipes_router() -> None:
    """`app.main.DOMAINS` todavía no incluye `"recipes"` (lo agrega otro
    agente, ver `docs/ESTADO.md`/misión, PASO 0) — sin eso, `admin_client`/
    `device_client`/`client` (que usan el singleton `app.main.app`) responden
    `405` a cualquier ruta de este dominio, aunque el router esté bien
    escrito. Acá se monta sobre ESE MISMO singleton (mismo objeto que
    `tests/conftest.py` ya importó) para que los tests HTTP de este
    directorio no dependan de que otro equipo actualice `app/main.py`
    primero. No toca `app/main.py` en disco; `app.recipes.router` importado
    dos veces (por dos ejecuciones de pytest en el mismo proceso) se guarda
    con un flag para no registrar las rutas por duplicado."""
    from app.main import app as main_app

    if getattr(main_app.state, "_recipes_router_mounted", False):
        return
    from app.recipes.router import router as recipes_router

    # `create_app()` registra el fallback SPA (`GET /{full_path:path}`) al
    # final de `main_app.router.routes`, DESPUÉS de recorrer `DOMAINS`.
    # `include_router` sólo AGREGA al final de esa misma lista — si se deja
    # así, cualquier GET a una ruta de este dominio la intercepta antes el
    # catch-all (primer *match* completo gana en Starlette) y devuelve el
    # `index.html` del frontend en vez de `404`/JSON. Se insertan las rutas
    # nuevas ANTES del catch-all para que compitan en pie de igualdad con
    # las de cualquier otro dominio ya montado.
    routes_before = list(main_app.router.routes)
    main_app.include_router(recipes_router, prefix="/api/v1")
    new_routes = [r for r in main_app.router.routes if r not in routes_before]
    if new_routes:
        for r in new_routes:
            main_app.router.routes.remove(r)
        catch_all_index = next(
            (i for i, r in enumerate(main_app.router.routes) if getattr(r, "path", None) == "/{full_path:path}"),
            len(main_app.router.routes),
        )
        for offset, r in enumerate(new_routes):
            main_app.router.routes.insert(catch_all_index + offset, r)
    main_app.state._recipes_router_mounted = True


_mount_recipes_router()


@pytest.fixture()
def make_ingredient(db: Session, org: Organization, store: Store) -> Callable[..., Any]:
    from app.inventory.models import Ingredient

    def _make(
        name: str,
        *,
        base_unit: str = "g",
        yield_pct: int = 100,
        official_cost_micros: int | None = 10_000_000,
        min_stock: int = 1_000,
        category: str = "General",
        consumption_untracked: bool = False,
        substitute_ingredient_id: int | None = None,
        active: bool = True,
        store_override: Store | None = None,
    ) -> Any:
        target_store = store_override or store
        now = clock_module.now_utc()
        row = Ingredient(
            organization_id=target_store.organization_id,
            store_id=target_store.id,
            name=name,
            category=category,
            base_unit=base_unit,
            purchase_unit=base_unit,
            purchase_factor=1,
            yield_pct=yield_pct,
            official_cost_micros=official_cost_micros,
            estimated_cost_micros=None,
            min_stock=min_stock,
            lead_time_days=None,
            perishable=False,
            key_item=False,
            consumption_untracked=consumption_untracked,
            substitute_ingredient_id=substitute_ingredient_id,
            supplier_id=None,
            active=active,
            created_at=now,
            updated_at=now,
        )
        db.add(row)
        db.flush()
        return row

    return _make


@pytest.fixture()
def make_product(db: Session, org: Organization, store: Store) -> Callable[..., Any]:
    from app.catalog.models import Category, Product

    def _make(name: str, *, price_dine_in: int = 20_000, tax_code: str = "inc_8") -> Any:
        now = clock_module.now_utc()
        category = Category(
            organization_id=org.id, store_id=store.id, name=f"Categoría {name}", sort_order=0,
            default_course=None, default_station=None, active=True,
        )
        db.add(category)
        db.flush()
        product = Product(
            organization_id=org.id, store_id=store.id, category_id=category.id, name=name, description=None,
            station=None, default_course=None, price_dine_in=price_dine_in, price_takeout=None,
            price_delivery=None, price_platform=None, tax_code=tax_code, active=True, available=True,
            daily_count=None, daily_remaining=None, created_at=now, updated_at=now,
        )
        db.add(product)
        db.flush()
        return product

    return _make


@pytest.fixture()
def admin_actor(org: Organization, employees: dict[str, Any]) -> Any:
    from app.auth.deps import Actor

    admin = employees["admin"]
    return Actor(
        kind="admin", organization_id=org.id, store_id=None, employee_id=admin.id, employee_name=admin.name,
        role="admin",
    )


@pytest.fixture()
def make_modifier_option(db: Session, org: Organization, store: Store) -> Callable[..., Any]:
    from app.catalog.models import ModifierGroup, ModifierOption

    def _make(product: Any, name: str, *, price_delta: int = 0) -> Any:
        group = ModifierGroup(
            organization_id=org.id, store_id=store.id, product_id=product.id, name=f"Grupo {name}",
            required=False, min=0, max=1, sort_order=0,
        )
        db.add(group)
        db.flush()
        option = ModifierOption(
            organization_id=org.id, store_id=store.id, modifier_group_id=group.id, name=name,
            price_delta=price_delta, sort_order=0, available=True,
        )
        db.add(option)
        db.flush()
        return option

    return _make
