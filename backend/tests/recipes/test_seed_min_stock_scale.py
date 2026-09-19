"""El seed no puede dejar la alerta de «bajo mínimo» apagada.

**Defecto encontrado recorriendo la app, no por un test.** En la pantalla de
Insumos se leía «Gaseosa 400ml — mínimo 0.024 unidad»: `app/recipes/seed.py`
pasaba el entero crudo a una columna que está en MILÉSIMAS, mientras
`app/inventory/seed.py` pasaba por `parse_qty_base`. Dos seeds, dos escalas
para la misma columna, y seis insumos con el umbral mil veces más chico — o
sea, con el motor de alertas apagado, que es textualmente el defecto que
SPEC-NEGOCIO §4.1 existe para evitar.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.quantity import QTY_SCALE

#: Por debajo de esto, un umbral de stock no protege nada: son fracciones de
#: gramo o de unidad. Ningún insumo de verdad tiene un mínimo así.
MINIMO_CREIBLE_BASE = 1 * QTY_SCALE


def test_no_seeded_ingredient_has_a_minimum_that_is_a_fraction_of_a_unit(db: Session, store: Any, employees: Any) -> None:
    from app.inventory.models import Ingredient
    from app.inventory.seed import seed_inventory
    from app.recipes.seed import seed_recipes

    seed_inventory(db, store)
    seed_recipes(db, store)
    db.flush()

    sospechosos = [
        (i.name, i.min_stock, i.base_unit.value)
        for i in db.execute(select(Ingredient).where(Ingredient.store_id == store.id)).scalars()
        if i.min_stock < MINIMO_CREIBLE_BASE
    ]
    assert not sospechosos, (
        "estos insumos quedaron con un mínimo por debajo de UNA unidad base, así que su alerta de "
        f"«bajo mínimo» nunca se dispara: {sospechosos}. Suele ser la escala: la columna está en "
        "milésimas y alguien guardó el número en unidad base"
    )


def test_every_seeded_ingredient_has_a_minimum_greater_than_zero(db: Session, store: Any, employees: Any) -> None:
    """§4.1: el umbral es obligatorio y nunca cero."""
    from app.inventory.models import Ingredient
    from app.inventory.seed import seed_inventory
    from app.recipes.seed import seed_recipes

    seed_inventory(db, store)
    seed_recipes(db, store)
    db.flush()

    en_cero = [
        i.name for i in db.execute(select(Ingredient).where(Ingredient.store_id == store.id)).scalars() if i.min_stock <= 0
    ]
    assert not en_cero, f"insumos sembrados con `min_stock <= 0`: {en_cero}"
