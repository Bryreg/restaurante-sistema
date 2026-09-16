"""La firma que publica este dominio para `backend-consumo` (`app.orders`) y
para `GET /admin/today` (dueño ajeno).

`expand_consumption` es **pura**: no escribe nada, no llama a
`app.inventory.hooks.record_movement`. Devuelve un plan ya resuelto —
rendimientos aplicados, `recipe_effect` de los modificadores aplicado,
preparaciones `exploded` aplanadas hasta insumos, preparaciones `batch`
dejadas como línea de preparación, líneas del mismo insumo fusionadas,
sustitutos resueltos por el único camino de `app.inventory.hooks` — para que
quien la llama (`app.orders.service.send`, dentro de su propia transacción)
decida cuándo y cómo aplicarlo con `record_movement`. Nunca lanza por un
producto sin ficha ni insumo directo, y nunca devuelve `0` en vez de `null`:
`catalog.recipes` apagada o cobertura vacía son el mismo caso,
`ConsumptionPlan(None, None, CostSource.NONE, [])`.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import TYPE_CHECKING, Any, Sequence

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.recipes.cost import _combine_sources, _preparation_lines, line_cost_micros, preparation_unit_cost
from app.recipes.models import (
    ModifierOptionRecipeEffect,
    ModifierOptionRecipeEffectLine,
    PrepMode,
    Preparation,
    Recipe,
    RecipeEffectType,
    RecipeLine,
    RecipeVersion,
)

if TYPE_CHECKING:
    from app.inventory.models import CostSource


@dataclass(frozen=True)
class ConsumptionLine:
    ingredient_id: int | None
    preparation_id: int | None  # sólo si la preparación es modo batch
    qty_base: int  # positivo; ya con rendimiento y modificadores aplicados
    cost_micros: int | None
    cost_source: "CostSource"


@dataclass(frozen=True)
class ConsumptionPlan:
    recipe_version: int | None  # None = el plato no descuenta nada (cobertura)
    unit_cost_micros: int | None  # costo teórico de UNA unidad del plato
    cost_source: "CostSource"
    lines: list[ConsumptionLine]


_AccKey = tuple[str, int]  # ("ingredient"|"preparation", id)


def _accumulate(
    db: Session,
    lines: Sequence[Any],
    multiplier_num: int,
    multiplier_den: int,
    acc: dict[_AccKey, int],
    *,
    store_id: int,
    visiting: frozenset[int] = frozenset(),
) -> None:
    from app.core.quantity import apply_yield
    from app.inventory import hooks as inventory_hooks

    for line in lines:
        qty_scaled = line.qty_base
        if (multiplier_num, multiplier_den) != (1, 1):
            qty_scaled = qty_scaled * multiplier_num // multiplier_den

        if line.ingredient_id is not None:
            ingredient = inventory_hooks.get_ingredient(db, store_id=store_id, ingredient_id=line.ingredient_id)
            if ingredient is None:
                # Insumo borrado/de otra sede: no hay a quién cargarle el
                # consumo. No revienta la venta (§5.2); simplemente esta
                # línea no aporta nada al plan.
                continue
            qty_final = apply_yield(qty_scaled, ingredient.yield_pct)
            # Único camino de consumo con cascada de sustituto
            # (`app.inventory.hooks.resolve_consumption_target`): venta,
            # cortesía, staff_meal y producción pasan TODOS por acá, nunca
            # cada uno resolviendo el sustituto a su manera.
            for resolved_ingredient, resolved_qty in inventory_hooks.resolve_consumption_target(
                db, ingredient, qty_final
            ):
                key: _AccKey = ("ingredient", resolved_ingredient.id)
                acc[key] = acc.get(key, 0) + resolved_qty
            continue

        component_id = getattr(line, "component_preparation_id", None)
        if component_id is None:
            component_id = line.preparation_id
        if component_id is None or component_id in visiting:
            continue
        component = db.get(Preparation, component_id)
        if component is None:
            continue
        if component.mode == PrepMode.BATCH:
            key = ("preparation", component_id)
            acc[key] = acc.get(key, 0) + qty_scaled
        else:
            sub_lines = _preparation_lines(db, component_id)
            _accumulate(
                db,
                sub_lines,
                qty_scaled,
                component.standard_yield_qty,
                acc,
                store_id=store_id,
                visiting=visiting | {component_id},
            )


def _load_effects(
    db: Session, option_ids: Sequence[int]
) -> dict[int, tuple[ModifierOptionRecipeEffect, list[ModifierOptionRecipeEffectLine]]]:
    if not option_ids:
        return {}
    effects = (
        db.execute(
            select(ModifierOptionRecipeEffect).where(
                ModifierOptionRecipeEffect.modifier_option_id.in_(set(option_ids))
            )
        )
        .scalars()
        .all()
    )
    result: dict[int, tuple[ModifierOptionRecipeEffect, list[ModifierOptionRecipeEffectLine]]] = {}
    for effect in effects:
        effect_lines = (
            db.execute(
                select(ModifierOptionRecipeEffectLine).where(
                    ModifierOptionRecipeEffectLine.effect_id == effect.id
                )
            )
            .scalars()
            .all()
        )
        result[effect.modifier_option_id] = (effect, list(effect_lines))
    return result


def _cost_of_acc(db: Session, acc: dict[_AccKey, int], store_id: int) -> tuple[int | None, "CostSource"]:
    from app.inventory import hooks as inventory_hooks
    from app.inventory.models import CostSource

    total = 0
    sources: list[CostSource] = []
    for (kind, component_id), qty_base in acc.items():
        if qty_base <= 0:
            continue
        if kind == "ingredient":
            ingredient = inventory_hooks.get_ingredient(db, store_id=store_id, ingredient_id=component_id)
            if ingredient is None:
                return None, CostSource.NONE
            cost_micros, source = inventory_hooks.resolve_ingredient_cost(db, ingredient)
        else:
            component = db.get(Preparation, component_id)
            if component is None:
                return None, CostSource.NONE
            cost_micros, source = preparation_unit_cost(db, component)
        if cost_micros is None:
            return None, CostSource.NONE
        micros = line_cost_micros(qty_base, cost_micros)
        if micros is None:
            return None, CostSource.NONE
        total += micros
        sources.append(source)
    if not sources:
        return None, CostSource.NONE
    return total, _combine_sources(sources)


def expand_consumption(
    db: Session, *, store_id: int, product_id: int, qty: int, modifier_option_ids: list[int]
) -> ConsumptionPlan:
    from app.core.features import is_enabled
    from app.inventory import hooks as inventory_hooks
    from app.inventory.models import CostSource
    from app.stores.models import Store

    empty = ConsumptionPlan(recipe_version=None, unit_cost_micros=None, cost_source=CostSource.NONE, lines=[])

    if qty <= 0:
        return empty

    store = db.get(Store, store_id)
    if store is None:
        return empty
    if not is_enabled(db, store.organization_id, store_id, "catalog.recipes"):
        return empty

    recipe = db.execute(
        select(Recipe).where(Recipe.product_id == product_id, Recipe.store_id == store_id)
    ).scalar_one_or_none()

    acc: dict[_AccKey, int] = {}
    version_number: int | None = None

    if recipe is not None and recipe.current_version > 0:
        version = db.execute(
            select(RecipeVersion).where(
                RecipeVersion.recipe_id == recipe.id, RecipeVersion.version == recipe.current_version
            )
        ).scalar_one_or_none()
        if version is not None:
            lines = list(
                db.execute(select(RecipeLine).where(RecipeLine.recipe_version_id == version.id)).scalars().all()
            )
            _accumulate(db, lines, 1, 1, acc, store_id=store_id)
            version_number = recipe.current_version
    else:
        return empty

    if modifier_option_ids:
        effects = _load_effects(db, modifier_option_ids)
        for option_id in modifier_option_ids:
            entry = effects.get(option_id)
            if entry is None:
                continue
            effect_row, effect_lines = entry
            if effect_row.effect == RecipeEffectType.ADD:
                _accumulate(db, effect_lines, 1, 1, acc, store_id=store_id)
            elif effect_row.effect == RecipeEffectType.REMOVE:
                to_remove: dict[_AccKey, int] = {}
                _accumulate(db, effect_lines, 1, 1, to_remove, store_id=store_id)
                for key, q in to_remove.items():
                    if key in acc:
                        acc[key] = max(0, acc[key] - q)
            elif effect_row.effect == RecipeEffectType.REPLACE:
                for eline in effect_lines:
                    # Límite conocido (documentado en el entregable): esto
                    # busca la clave por el id ORIGINAL que configuró el
                    # admin (`replaces_ingredient_id`), no por dónde cascadeó
                    # `resolve_consumption_target` si ese insumo tiene
                    # sustituto Y el sustituto llegó a activarse en este
                    # mismo plan. El caso común (sin sustituto, o sustituto
                    # sin activar) queda cubierto.
                    target: _AccKey | None = None
                    if eline.replaces_ingredient_id is not None:
                        target = ("ingredient", eline.replaces_ingredient_id)
                    elif eline.replaces_preparation_id is not None:
                        target = ("preparation", eline.replaces_preparation_id)
                    if target is not None and target in acc:
                        del acc[target]
                    _accumulate(db, [eline], 1, 1, acc, store_id=store_id)

    lines_out: list[ConsumptionLine] = []
    for (kind, component_id), qty_unit in acc.items():
        if qty_unit <= 0:
            continue
        qty_total = qty_unit * qty
        if kind == "ingredient":
            ingredient = inventory_hooks.get_ingredient(db, store_id=store_id, ingredient_id=component_id)
            cost_micros, source = (
                inventory_hooks.resolve_ingredient_cost(db, ingredient)
                if ingredient is not None
                else (None, CostSource.NONE)
            )
            lines_out.append(
                ConsumptionLine(
                    ingredient_id=component_id,
                    preparation_id=None,
                    qty_base=qty_total,
                    cost_micros=cost_micros,
                    cost_source=source,
                )
            )
        else:
            component = db.get(Preparation, component_id)
            cost_micros, source = (
                preparation_unit_cost(db, component) if component is not None else (None, CostSource.NONE)
            )
            lines_out.append(
                ConsumptionLine(
                    ingredient_id=None,
                    preparation_id=component_id,
                    qty_base=qty_total,
                    cost_micros=cost_micros,
                    cost_source=source,
                )
            )

    if not lines_out:
        return ConsumptionPlan(recipe_version=version_number, unit_cost_micros=None, cost_source=CostSource.NONE, lines=[])

    unit_cost_micros, plan_source = _cost_of_acc(db, acc, store_id)
    return ConsumptionPlan(
        recipe_version=version_number,
        unit_cost_micros=unit_cost_micros,
        cost_source=plan_source,
        lines=lines_out,
    )


def prep_stock_alerts(db: Session, *, store_id: int) -> list[dict[str, Any]]:
    """Preparaciones en modo `batch` sin producción (stock agregado <= 0):
    lo consume `GET /admin/today`, ajeno."""
    from app.inventory import hooks as inventory_hooks

    stmt = select(Preparation).where(
        Preparation.store_id == store_id, Preparation.mode == PrepMode.BATCH, Preparation.active.is_(True)
    )
    alerts: list[dict[str, Any]] = []
    for prep in db.execute(stmt).scalars().all():
        stock = inventory_hooks.current_stock(db, store_id=store_id, preparation_id=prep.id)
        if stock <= 0:
            alerts.append(
                {
                    "type": "prep_no_production",
                    "preparation_id": prep.id,
                    "preparation_name": prep.name,
                    "current_stock": stock,
                    "unit": prep.standard_yield_unit,
                }
            )
    return alerts


def uncosted_products(db: Session, *, store_id: int, date_from: date, date_to: date) -> list[dict[str, Any]]:
    """Platos vendidos en `[date_from, date_to]` que no descuentan nada (sin
    ficha ni insumo directo): lo consume `GET /admin/today` y el reporte de
    cobertura, ambos ajenos a este dominio salvo por esta función."""
    from app.orders.models import Order, OrderItem

    stmt = (
        select(OrderItem.product_id, func.count(OrderItem.id), func.coalesce(func.sum(OrderItem.qty), 0))
        .join(Order, Order.id == OrderItem.order_id)
        .where(
            Order.store_id == store_id,
            Order.business_date >= date_from,
            Order.business_date <= date_to,
            OrderItem.product_id.is_not(None),
            OrderItem.voided_at.is_(None),
        )
        .group_by(OrderItem.product_id)
    )

    from app.catalog.models import Product

    result: list[dict[str, Any]] = []
    for product_id, item_count, qty_sold in db.execute(stmt).all():
        if product_id is None:
            continue
        plan = expand_consumption(db, store_id=store_id, product_id=product_id, qty=1, modifier_option_ids=[])
        if plan.lines:
            continue
        product = db.get(Product, product_id)
        result.append(
            {
                "product_id": product_id,
                "product_name": product.name if product is not None else None,
                "items_sold": item_count,
                "qty_sold": qty_sold,
            }
        )
    return result
