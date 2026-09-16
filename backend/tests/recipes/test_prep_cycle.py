"""Una preparación que se referencia a sí misma **por cualquier camino** ->
`400 PREP_CYCLE`, al GUARDAR (nunca al consumir). El checklist pide
explícitamente un ciclo de TRES saltos, no sólo el padre directo.
"""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.recipes import service
from app.recipes.schemas import ComponentLineIn, PreparationIn, PreparationUpdateIn


def test_three_hop_cycle_is_rejected_with_400(
    db: Session, org: Any, store: Any, admin_actor: Any, make_ingredient: Any
) -> None:
    base = make_ingredient("Base (ciclo)")

    prep_a = service.create_preparation(
        db, actor=admin_actor, store_id=store.id,
        data=PreparationIn(
            name="A (ciclo)", mode="exploded", standard_yield_qty="1000", standard_yield_unit="g",
            lines=[ComponentLineIn(ingredient_id=base.id, qty="500", unit="g")],
        ),
    )
    prep_b = service.create_preparation(
        db, actor=admin_actor, store_id=store.id,
        data=PreparationIn(
            name="B (ciclo)", mode="exploded", standard_yield_qty="1000", standard_yield_unit="g",
            lines=[ComponentLineIn(preparation_id=prep_a.id, qty="200", unit="g")],
        ),
    )
    prep_c = service.create_preparation(
        db, actor=admin_actor, store_id=store.id,
        data=PreparationIn(
            name="C (ciclo)", mode="exploded", standard_yield_qty="1000", standard_yield_unit="g",
            lines=[ComponentLineIn(preparation_id=prep_b.id, qty="200", unit="g")],
        ),
    )
    # Cierra el ciclo de tres saltos: A -> C -> B -> A.
    with pytest.raises(AppError) as exc:
        service.update_preparation(
            db, actor=admin_actor, preparation=prep_a,
            data=PreparationUpdateIn(lines=[ComponentLineIn(preparation_id=prep_c.id, qty="100", unit="g")]),
        )
    assert exc.value.code == "PREP_CYCLE"
    assert exc.value.status == 400


def test_self_reference_is_rejected(
    db: Session, org: Any, store: Any, admin_actor: Any, make_ingredient: Any
) -> None:
    base = make_ingredient("Base (autociclo)")
    prep = service.create_preparation(
        db, actor=admin_actor, store_id=store.id,
        data=PreparationIn(
            name="Autociclo", mode="exploded", standard_yield_qty="1000", standard_yield_unit="g",
            lines=[ComponentLineIn(ingredient_id=base.id, qty="500", unit="g")],
        ),
    )
    with pytest.raises(AppError) as exc:
        service.update_preparation(
            db, actor=admin_actor, preparation=prep,
            data=PreparationUpdateIn(lines=[ComponentLineIn(preparation_id=prep.id, qty="100", unit="g")]),
        )
    assert exc.value.code == "PREP_CYCLE"


def test_a_dag_without_cycle_is_accepted(
    db: Session, org: Any, store: Any, admin_actor: Any, make_ingredient: Any
) -> None:
    """Dos preparaciones distintas que comparten un mismo componente (un
    diamante, no un ciclo) no deberían dispararse por error."""
    base = make_ingredient("Base (dag)")
    prep_a = service.create_preparation(
        db, actor=admin_actor, store_id=store.id,
        data=PreparationIn(
            name="A (dag)", mode="exploded", standard_yield_qty="1000", standard_yield_unit="g",
            lines=[ComponentLineIn(ingredient_id=base.id, qty="500", unit="g")],
        ),
    )
    service.create_preparation(
        db, actor=admin_actor, store_id=store.id,
        data=PreparationIn(
            name="B (dag)", mode="exploded", standard_yield_qty="1000", standard_yield_unit="g",
            lines=[ComponentLineIn(preparation_id=prep_a.id, qty="100", unit="g")],
        ),
    )
    service.create_preparation(
        db, actor=admin_actor, store_id=store.id,
        data=PreparationIn(
            name="C (dag)", mode="exploded", standard_yield_qty="1000", standard_yield_unit="g",
            lines=[ComponentLineIn(preparation_id=prep_a.id, qty="200", unit="g")],
        ),
    )  # No debe lanzar.
