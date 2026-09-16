"""`app.inventory.seed.seed_inventory`: idempotente, y ejercita el camino
nuevo (yield_pct != 100, costo oficial, min_stock real, key_item,
consumption_untracked, sustituto en cascada). Llamado desde `app.seed.seed`
(archivo huérfano, dueño único de este territorio)."""

from __future__ import annotations

import importlib

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.modules import find_spec_safe
from app.inventory.models import Ingredient
from app.inventory.seed import seed_inventory
from app.stores.models import Store

# Ver el mismo import defensivo, con la misma razón, en
# `tests/core/test_seed.py`: `app.seed.seed()` (que `test_full_app_seed_...`
# llama acá abajo) cae en `app.recipes.seed.seed_recipes` cuando ese dominio
# existe, y sin este import la fixture `db` nunca ve la tabla `recipes`.
if find_spec_safe("app.recipes.models") is not None:
    importlib.import_module("app.recipes.models")


def test_seed_inventory_loads_expected_shape(db: Session, store: Store) -> None:
    seed_inventory(db, store)
    db.commit()

    rows = db.execute(select(Ingredient).where(Ingredient.store_id == store.id)).scalars().all()
    assert len(rows) >= 3

    assert any(i.yield_pct != 100 for i in rows), "ningún insumo con yield_pct != 100"
    assert any(i.official_cost_micros is not None for i in rows), "ningún insumo con costo oficial"
    assert any(i.min_stock > 0 for i in rows)
    assert all(i.min_stock > 0 for i in rows), "min_stock nunca puede ser 0 (400 MIN_STOCK_REQUIRED)"
    assert any(i.key_item for i in rows), "ningún insumo key_item"
    assert any(i.consumption_untracked for i in rows), "ningún insumo consumption_untracked"
    assert any(i.substitute_ingredient_id is not None for i in rows), "ningún insumo con sustituto"


def test_seed_inventory_is_idempotent(db: Session, store: Store) -> None:
    seed_inventory(db, store)
    db.commit()
    first_count = len(db.execute(select(Ingredient).where(Ingredient.store_id == store.id)).scalars().all())

    seed_inventory(db, store)
    db.commit()
    second_count = len(db.execute(select(Ingredient).where(Ingredient.store_id == store.id)).scalars().all())

    assert first_count == second_count


def test_full_app_seed_loads_ingredients_too(db: Session) -> None:
    """`app.seed.seed()` (archivo huérfano de este territorio) carga los
    insumos junto con el resto de la base de desarrollo."""
    from app.seed import seed

    seed(db)
    db.commit()

    rows = db.execute(select(Ingredient)).scalars().all()
    assert len(rows) >= 3
