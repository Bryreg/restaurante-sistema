"""El seed corre aparte del arranque y corriendo dos veces no duplica nada."""

from __future__ import annotations

import importlib

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.models import Employee
from app.core.modules import find_spec_safe
from app.seed import ADMIN_EMAIL, seed
from app.stores.models import Store, Table, Zone

# `seed()` cae en `app.recipes.seed.seed_recipes` cuando ese dominio existe
# (territorio ajeno, todavía fuera de `app.core.models_registry.MODEL_MODULES`).
# Sin este import, la fixture `db` (que crea el esquema con
# `Base.metadata.create_all` ANTES de que `seed()` corra) nunca ve la tabla
# `recipes`, y `seed_recipes` revienta con "no such table: recipes" -- no es
# un fallo de este territorio, es el mismo caso que documenta
# `0007_fiscal_ranges_notes.py` para `NoReferencedTableError`, pero para el
# *esquema* en vez de una FK.
if find_spec_safe("app.recipes.models") is not None:
    importlib.import_module("app.recipes.models")


def test_seed_is_idempotent(db: Session) -> None:
    seed(db)
    db.commit()
    employees_after_first = db.execute(select(Employee)).scalars().all()
    stores_after_first = db.execute(select(Store)).scalars().all()

    seed(db)
    db.commit()
    employees_after_second = db.execute(select(Employee)).scalars().all()
    stores_after_second = db.execute(select(Store)).scalars().all()

    assert len(employees_after_second) == len(employees_after_first)
    assert len(stores_after_second) == len(stores_after_first)


def test_seed_creates_expected_demo_data(db: Session) -> None:
    seed(db)
    db.commit()

    admin = db.execute(select(Employee).where(Employee.email == ADMIN_EMAIL)).scalars().first()
    assert admin is not None
    assert admin.role == "admin"

    stores = db.execute(select(Store)).scalars().all()
    assert len(stores) == 1

    zones = db.execute(select(Zone)).scalars().all()
    tables = db.execute(select(Table)).scalars().all()
    assert len(zones) == 2
    assert len(tables) == 8

    operators = db.execute(select(Employee).where(Employee.role == "operator")).scalars().all()
    assert len(operators) == 4
    assert sum(1 for o in operators if o.can_charge) == 1
