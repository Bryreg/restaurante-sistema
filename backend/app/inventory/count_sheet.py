"""Hoja de conteo para imprimir (auditoría del dueño, tanda 5, i5).

La hoja que se lleva en la mano al depósito: por área (Bar, Cocina…), en el
orden en que el administrador puso los artículos del área —que es el orden
en que están en el estante— y después lo demás del área por categoría. Lo
que no es de ningún área sale al final, por categoría y nombre. Cada
artículo con la unidad en que se cuenta (`units.entry_spec`, la misma del
conteo por área: kg, botella, L, unidad).

**A ciegas**: la hoja NO lleva el stock teórico (ni costos). Es papel para
anotar; lo contado se carga después por la pantalla de siempre.

Sin `inventory.shift_counts` no hay áreas: sale una sola sección con todos
los insumos activos por categoría.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import clock, features, tz
from app.core.errors import NotFoundError
from app.inventory import area_counts
from app.inventory.models import CountArea, Ingredient
from app.inventory.units import entry_spec
from app.stores.models import Store

NO_AREA_TITLE = "Sin área asignada"
ALL_TITLE = "Todos los insumos"


def _item(ingredient: Ingredient) -> dict[str, Any]:
    spec = entry_spec(ingredient)
    return {
        "ingredient_id": ingredient.id,
        "name": ingredient.name,
        "category": ingredient.category,
        "count_unit": spec.unit,
    }


def _by_category(ingredients: list[Ingredient]) -> list[Ingredient]:
    return sorted(
        ingredients,
        key=lambda i: ((i.category or "").casefold() == "", (i.category or "").casefold(), i.name.casefold(), i.id),
    )


def count_sheet(db: Session, *, store: Store, area_id: int | None) -> dict[str, Any]:
    active = list(
        db.execute(select(Ingredient).where(Ingredient.store_id == store.id, Ingredient.active.is_(True))).scalars()
    )
    areas_on = features.is_enabled(db, store.organization_id, store.id, area_counts.FEATURE)
    areas: list[CountArea] = area_counts.list_areas(db, store=store, active_only=True) if areas_on else []

    sections: list[dict[str, Any]] = []
    if area_id is not None:
        area = next((a for a in areas if a.id == area_id), None)
        if area is None:
            raise NotFoundError("El área no existe en esta sede (o está desactivada)")
        chosen = [area]
    else:
        chosen = areas

    placed: set[int] = set()
    for area in chosen:
        items = area_counts.full_list(db, store=store, area=area)
        placed.update(i.id for i in items)
        sections.append({"area_id": area.id, "title": area.name, "items": [_item(i) for i in items]})

    if area_id is None:
        if areas:
            # Lo que quedó en alguna área no elegida tampoco va a «sin área».
            for area in areas:
                placed.update(i.id for i in area_counts.full_list(db, store=store, area=area))
        rest = _by_category([i for i in active if i.id not in placed])
        if rest:
            sections.append(
                {"area_id": None, "title": NO_AREA_TITLE if areas else ALL_TITLE, "items": [_item(i) for i in rest]}
            )

    now = clock.now_utc()
    return {
        "store_id": store.id,
        "store_name": store.name,
        "business_date": tz.business_date_for(now, store.cutoff_hour).isoformat(),
        "generated_at": now,
        "areas": [{"id": a.id, "name": a.name} for a in areas],
        "sections": sections,
    }
