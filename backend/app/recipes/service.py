"""Lógica de negocio de fichas técnicas, preparaciones y `recipe_effect`.

Aislamiento por organización/sede igual que el resto del backend (un id ajeno
es `404`, nunca `403`); toda escritura de inventario pasa por
`app.inventory.hooks.record_movement` — nada de este módulo escribe
`StockMovement`/`Ingredient` directamente.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.auth.deps import Actor
from app.auth.models import Employee
from app.core import clock, tz
from app.core.errors import AppError, ConflictError, NotFoundError
from app.recipes import cost, units
from app.recipes.hooks import _accumulate, _cost_of_acc
from app.recipes.models import (
    ModifierOptionRecipeEffect,
    ModifierOptionRecipeEffectLine,
    PrepBatch,
    PrepMode,
    Preparation,
    PreparationLine,
    Recipe,
    RecipeEffectType,
    RecipeLine,
    RecipeVersion,
)
from app.recipes.schemas import (
    ComponentLineIn,
    ComponentLineOut,
    PrepBatchAdminOut,
    PreparationAdminOut,
    PreparationDeviceOut,
    PreparationIn,
    PreparationUpdateIn,
    ProduceIn,
    ProduceOut,
    ProductRecipeIn,
    ProductRecipeOut,
    RecipeEffectIn,
    RecipeEffectLineOut,
    RecipeEffectOut,
)

VARIANCE_ALERT_THRESHOLD_X100 = 1500  # 15.00 %

# ---------------------------------------------------------------------------
# Aislamiento por organización/sede (mismo patrón que `app.catalog.service`).
# ---------------------------------------------------------------------------


def _scoped_or_404(row: Any, actor: Actor, *, message: str) -> Any:
    if row is None or row.organization_id != actor.organization_id:
        raise NotFoundError(message)
    if actor.kind == "device" and row.store_id != actor.store_id:
        raise NotFoundError(message)
    return row


def preparation_or_404(db: Session, actor: Actor, preparation_id: int) -> Preparation:
    return _scoped_or_404(db.get(Preparation, preparation_id), actor, message="La preparación no existe")


def _cutoff_hour(db: Session, store_id: int) -> int:
    from app.stores.models import Store

    store = db.get(Store, store_id)
    return store.cutoff_hour if store is not None else 6


def _component_base_unit(db: Session, *, store_id: int, ingredient_id: int | None, preparation_id: int | None) -> str:
    if ingredient_id is not None:
        from app.inventory import hooks as inventory_hooks

        ingredient = inventory_hooks.get_ingredient(db, store_id=store_id, ingredient_id=ingredient_id)
        if ingredient is None:
            raise NotFoundError("El insumo no existe")
        return ingredient.base_unit
    prep = db.get(Preparation, preparation_id)
    if prep is None or prep.store_id != store_id:
        raise NotFoundError("La preparación referenciada no existe")
    return prep.standard_yield_unit


def _built_lines(db: Session, store_id: int, lines_in: list[ComponentLineIn]) -> list[tuple[int | None, int | None, int, str]]:
    """`(ingredient_id, preparation_id, qty_base, unit)` por línea, ya
    validada la unidad contra la unidad base del componente."""
    built: list[tuple[int | None, int | None, int, str]] = []
    for item in lines_in:
        base_unit = _component_base_unit(
            db, store_id=store_id, ingredient_id=item.ingredient_id, preparation_id=item.preparation_id
        )
        qty_base = units.to_base_qty(item.qty, item.unit, base_unit)
        built.append((item.ingredient_id, item.preparation_id, qty_base, item.unit))
    return built


def _line_out(
    db: Session, *, store_id: int, ingredient_id: int | None, preparation_id: int | None, qty_base: int, unit: str
) -> ComponentLineOut:
    from app.inventory import hooks as inventory_hooks

    ingredient_name = None
    preparation_name = None
    if ingredient_id is not None:
        ingredient = inventory_hooks.get_ingredient(db, store_id=store_id, ingredient_id=ingredient_id)
        ingredient_name = ingredient.name if ingredient is not None else None
    else:
        prep = db.get(Preparation, preparation_id)
        preparation_name = prep.name if prep is not None else None
    qty_display = units.base_qty_to_decimal(qty_base, unit)
    return ComponentLineOut(
        ingredient_id=ingredient_id,
        ingredient_name=ingredient_name,
        preparation_id=preparation_id,
        preparation_name=preparation_name,
        qty=str(qty_display),
        unit=unit,
    )


# ---------------------------------------------------------------------------
# Ciclos (§4.2, checklist): DFS sobre el grafo COMPLETO de preparaciones,
# no sólo el padre directo. Se corre al GUARDAR, nunca al consumir.
# ---------------------------------------------------------------------------


def _would_create_cycle(db: Session, preparation_id: int, new_component_ids: set[int]) -> bool:
    if preparation_id in new_component_ids:
        return True
    visited: set[int] = set()
    stack: list[int] = list(new_component_ids)
    while stack:
        node = stack.pop()
        if node == preparation_id:
            return True
        if node in visited:
            continue
        visited.add(node)
        children = (
            db.execute(
                select(PreparationLine.component_preparation_id).where(
                    PreparationLine.preparation_id == node,
                    PreparationLine.component_preparation_id.is_not(None),
                )
            )
            .scalars()
            .all()
        )
        stack.extend(c for c in children if c is not None)
    return False


def _replace_preparation_lines(db: Session, preparation: Preparation, lines_in: list[ComponentLineIn]) -> None:
    built = _built_lines(db, preparation.store_id, lines_in)
    component_ids = {preparation_id for _ing, preparation_id, _q, _u in built if preparation_id is not None}
    if component_ids and _would_create_cycle(db, preparation.id, component_ids):
        raise AppError(
            code="PREP_CYCLE",
            message=(
                "Esta preparación terminaría refiriéndose a sí misma por alguna cadena de "
                "preparaciones; revisá las líneas y quitá la que cierra el ciclo"
            ),
        )
    db.execute(sa_delete(PreparationLine).where(PreparationLine.preparation_id == preparation.id))
    for ingredient_id, component_preparation_id, qty_base, unit in built:
        db.add(
            PreparationLine(
                preparation_id=preparation.id,
                ingredient_id=ingredient_id,
                component_preparation_id=component_preparation_id,
                qty_base=qty_base,
                unit=unit,
            )
        )
    db.flush()


# ---------------------------------------------------------------------------
# Preparaciones — CRUD admin
# ---------------------------------------------------------------------------


def list_preparations(db: Session, *, store_id: int, active_only: bool = True) -> list[Preparation]:
    stmt = select(Preparation).where(Preparation.store_id == store_id)
    if active_only:
        stmt = stmt.where(Preparation.active.is_(True))
    return list(db.execute(stmt.order_by(Preparation.name)).scalars().all())


def create_preparation(db: Session, *, actor: Actor, store_id: int, data: PreparationIn) -> Preparation:
    now = clock.now_utc()
    standard_yield_qty = units.to_base_qty(data.standard_yield_qty, data.standard_yield_unit, data.standard_yield_unit)
    prep = Preparation(
        organization_id=actor.organization_id,
        store_id=store_id,
        name=data.name,
        mode=PrepMode(data.mode),
        standard_yield_qty=standard_yield_qty,
        standard_yield_unit=data.standard_yield_unit,
        process_loss_pct=data.process_loss_pct,
        shelf_life_days=data.shelf_life_days,
        active=True,
        created_at=now,
        updated_at=now,
    )
    db.add(prep)
    db.flush()
    _replace_preparation_lines(db, prep, data.lines)
    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=store_id,
        entity="preparation",
        entity_id=prep.id,
        action="create",
        before=None,
        after={"name": prep.name, "mode": prep.mode.value},
    )
    return prep


def update_preparation(db: Session, *, actor: Actor, preparation: Preparation, data: PreparationUpdateIn) -> Preparation:
    before = {"name": preparation.name, "active": preparation.active}
    if data.name is not None:
        preparation.name = data.name
    if data.standard_yield_unit is not None:
        preparation.standard_yield_unit = data.standard_yield_unit
    if data.standard_yield_qty is not None:
        preparation.standard_yield_qty = units.to_base_qty(
            data.standard_yield_qty, preparation.standard_yield_unit, preparation.standard_yield_unit
        )
    if data.process_loss_pct is not None:
        preparation.process_loss_pct = data.process_loss_pct
    if data.shelf_life_days is not None:
        preparation.shelf_life_days = data.shelf_life_days
    if data.active is not None:
        preparation.active = data.active
    preparation.updated_at = clock.now_utc()
    if data.lines is not None:
        _replace_preparation_lines(db, preparation, data.lines)
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=preparation.organization_id,
        store_id=preparation.store_id,
        entity="preparation",
        entity_id=preparation.id,
        action="update",
        before=before,
        after={"name": preparation.name, "active": preparation.active},
    )
    return preparation


def _close_open_batches(db: Session, preparation: Preparation, *, actor: Actor, closer: Employee) -> None:
    from app.inventory import hooks as inventory_hooks
    from app.inventory.models import CostSource, MovementCause

    now = clock.now_utc()
    business_date = tz.business_date_for(now, _cutoff_hour(db, preparation.store_id))
    stock = inventory_hooks.current_stock(db, store_id=preparation.store_id, preparation_id=preparation.id)
    if stock != 0:
        inventory_hooks.record_movement(
            db,
            organization_id=preparation.organization_id,
            store_id=preparation.store_id,
            preparation_id=preparation.id,
            qty_base=-stock,
            cause=MovementCause.COUNT_ADJUSTMENT,
            cost_micros=None,
            cost_source=CostSource.NONE,
            actor=actor,
            business_date=business_date,
            at=now,
            ref_type="preparation_mode_change",
            ref_id=preparation.id,
            note=f"Cierre de lotes al cambiar de modo, autorizado por {closer.name}",
        )
    open_batches = (
        db.execute(
            select(PrepBatch).where(PrepBatch.preparation_id == preparation.id, PrepBatch.closed_at.is_(None))
        )
        .scalars()
        .all()
    )
    for batch in open_batches:
        batch.closed_at = now
        batch.closed_by_employee_id = closer.id
        batch.closed_by_employee_name = closer.name
        batch.closed_reason = "Cambio de modo a exploded"
    db.flush()


def switch_preparation_mode(
    db: Session, *, actor: Actor, preparation: Preparation, new_mode: str, authorizer_pin: str | None
) -> Preparation:
    from app.auth import service as auth_service

    authorizer = auth_service.verify_authorizer(
        db,
        organization_id=preparation.organization_id,
        store_id=preparation.store_id,
        pin=authorizer_pin,
        action="preparation_mode_change",
        requested_by=actor,
    )
    new_mode_enum = PrepMode(new_mode)
    before_mode = preparation.mode
    if new_mode_enum == before_mode:
        return preparation

    if before_mode == PrepMode.BATCH and new_mode_enum == PrepMode.EXPLODED:
        _close_open_batches(db, preparation, actor=actor, closer=authorizer)

    preparation.mode = new_mode_enum
    preparation.updated_at = clock.now_utc()
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=preparation.organization_id,
        store_id=preparation.store_id,
        entity="preparation",
        entity_id=preparation.id,
        action="mode_change",
        before={"mode": before_mode.value},
        after={"mode": new_mode_enum.value},
        reason=f"autorizado por {authorizer.name}",
    )
    return preparation


# ---------------------------------------------------------------------------
# Producción rápida (dispositivo)
# ---------------------------------------------------------------------------


def produce_preparation(db: Session, *, actor: Actor, preparation: Preparation, data: ProduceIn) -> PrepBatch:
    from app.auth import service as auth_service
    from app.core.quantity import QTY_SCALE
    from app.inventory import hooks as inventory_hooks
    from app.inventory.models import CostSource, MovementCause

    if preparation.mode != PrepMode.BATCH:
        raise AppError(
            code="PREP_NOT_BATCH",
            message=(
                'Esta preparación es modo "exploded": no se produce, se descuenta sola al '
                'enviar el plato; cambiala a "batch" en Admin → Preparaciones si necesitás producirla'
            ),
        )
    if actor.employee_id is None:
        raise AppError(code="IDENTIFY_REQUIRED", message="Identificate con tu PIN antes de producir")
    employee = db.get(Employee, actor.employee_id)
    if employee is None or not auth_service.verify_pin(db, employee, data.employee_pin):
        raise AppError(code="EMPLOYEE_PIN_INVALID", message="El PIN no coincide con el operador identificado")

    unit = preparation.standard_yield_unit
    qty_expected = units.to_base_qty(data.qty_expected, unit, unit)
    qty_real = units.to_base_qty_nonnegative(data.qty_real, unit, unit)

    lines = list(
        db.execute(select(PreparationLine).where(PreparationLine.preparation_id == preparation.id)).scalars().all()
    )
    acc: dict[tuple[str, int], int] = {}
    _accumulate(
        db,
        lines,
        qty_expected,
        preparation.standard_yield_qty,
        acc,
        store_id=preparation.store_id,
        visiting=frozenset({preparation.id}),
    )
    total_micros, source = _cost_of_acc(db, acc, preparation.store_id)

    now = clock.now_utc()
    business_date = tz.business_date_for(now, _cutoff_hour(db, preparation.store_id))

    variance_pct_x100 = abs(qty_real - qty_expected) * 10000 // qty_expected
    variance_alert = variance_pct_x100 > VARIANCE_ALERT_THRESHOLD_X100

    unit_cost_micros: int | None = None
    if total_micros is not None and qty_real > 0:
        unit_cost_micros = total_micros * QTY_SCALE // qty_real
    # `cost_micros is None` <=> `cost_source is NONE` es un invariante que
    # exige `record_movement`: si `qty_real == 0` (se quemó toda la
    # producción) `unit_cost_micros` queda `None` aunque los insumos sí
    # tuvieran costo — el origen tiene que degradarse a `NONE` junto con él,
    # nunca quedar "oficial" sin costo.
    unit_cost_source = source if unit_cost_micros is not None else CostSource.NONE

    expiry_date: date | None = None
    if preparation.shelf_life_days is not None:
        expiry_date = business_date + timedelta(days=preparation.shelf_life_days)

    batch = PrepBatch(
        organization_id=preparation.organization_id,
        store_id=preparation.store_id,
        preparation_id=preparation.id,
        qty_expected=qty_expected,
        qty_real=qty_real,
        unit=unit,
        variance_pct_x100=variance_pct_x100,
        variance_alert=variance_alert,
        total_cost_micros=total_micros,
        unit_cost_micros=unit_cost_micros,
        cost_source=unit_cost_source.value,
        expiry_date=expiry_date,
        produced_by_employee_id=employee.id,
        produced_by_employee_name=employee.name,
        produced_at=now,
        business_date=business_date,
        note=data.note,
    )
    db.add(batch)
    db.flush()

    for (kind, component_id), qty_base in acc.items():
        if qty_base <= 0:
            continue
        if kind == "ingredient":
            ingredient = inventory_hooks.get_ingredient(db, store_id=preparation.store_id, ingredient_id=component_id)
            if ingredient is None:
                continue
            line_cost_micros, line_source = inventory_hooks.resolve_ingredient_cost(db, ingredient)
            inventory_hooks.record_movement(
                db,
                organization_id=preparation.organization_id,
                store_id=preparation.store_id,
                ingredient_id=component_id,
                qty_base=-qty_base,
                cause=MovementCause.PRODUCTION_OUT,
                cost_micros=line_cost_micros,
                cost_source=line_source,
                actor=actor,
                business_date=business_date,
                at=now,
                ref_type="prep_batch",
                ref_id=batch.id,
                note=data.note,
            )
        else:
            component = db.get(Preparation, component_id)
            comp_cost, comp_source = (
                cost.preparation_unit_cost(db, component) if component is not None else (None, CostSource.NONE)
            )
            inventory_hooks.record_movement(
                db,
                organization_id=preparation.organization_id,
                store_id=preparation.store_id,
                preparation_id=component_id,
                qty_base=-qty_base,
                cause=MovementCause.PRODUCTION_OUT,
                cost_micros=comp_cost,
                cost_source=comp_source,
                actor=actor,
                business_date=business_date,
                at=now,
                ref_type="prep_batch",
                ref_id=batch.id,
                note=data.note,
            )

    if qty_real > 0:
        # `record_movement` rechaza `qty_base == 0` (`VALIDATION_ERROR`): un
        # lote que salió en cero no genera entrada de la preparación, sólo
        # la salida de insumos ya registrada arriba.
        inventory_hooks.record_movement(
            db,
            organization_id=preparation.organization_id,
            store_id=preparation.store_id,
            preparation_id=preparation.id,
            qty_base=qty_real,
            cause=MovementCause.PRODUCTION_IN,
            cost_micros=unit_cost_micros,
            cost_source=unit_cost_source,
            actor=actor,
            business_date=business_date,
            at=now,
            ref_type="prep_batch",
            ref_id=batch.id,
            note=data.note,
        )

    record_audit(
        db,
        actor=actor,
        organization_id=preparation.organization_id,
        store_id=preparation.store_id,
        entity="prep_batch",
        entity_id=batch.id,
        action="produce",
        before=None,
        after={"qty_expected": qty_expected, "qty_real": qty_real, "variance_alert": variance_alert},
    )
    return batch


def list_batches(db: Session, *, preparation_id: int) -> list[PrepBatch]:
    stmt = select(PrepBatch).where(PrepBatch.preparation_id == preparation_id).order_by(PrepBatch.produced_at.desc())
    return list(db.execute(stmt).scalars().all())


# ---------------------------------------------------------------------------
# Salida (esquemas) — separada estrictamente en admin (con costo) y
# dispositivo (sin costo), como exige el checklist del OpenAPI.
# ---------------------------------------------------------------------------


def preparation_admin_out(db: Session, preparation: Preparation) -> PreparationAdminOut:
    from app.core.quantity import format_cost_micros
    from app.inventory import hooks as inventory_hooks

    lines = list(
        db.execute(select(PreparationLine).where(PreparationLine.preparation_id == preparation.id)).scalars().all()
    )
    unit_cost, source = cost.preparation_unit_cost(db, preparation)
    current_stock_display = None
    if preparation.mode == PrepMode.BATCH:
        stock = inventory_hooks.current_stock(db, store_id=preparation.store_id, preparation_id=preparation.id)
        current_stock_display = str(units.base_qty_to_decimal(stock, preparation.standard_yield_unit))
    return PreparationAdminOut(
        id=preparation.id,
        name=preparation.name,
        mode=preparation.mode.value,
        standard_yield_qty=str(units.base_qty_to_decimal(preparation.standard_yield_qty, preparation.standard_yield_unit)),
        standard_yield_unit=preparation.standard_yield_unit,
        process_loss_pct=preparation.process_loss_pct,
        shelf_life_days=preparation.shelf_life_days,
        active=preparation.active,
        current_stock=current_stock_display,
        unit_cost=format_cost_micros(unit_cost) if unit_cost is not None else None,
        cost_source=source.value,
        lines=[
            _line_out(
                db,
                store_id=preparation.store_id,
                ingredient_id=line.ingredient_id,
                preparation_id=line.component_preparation_id,
                qty_base=line.qty_base,
                unit=line.unit,
            )
            for line in lines
        ],
    )


def preparation_device_out(preparation: Preparation) -> PreparationDeviceOut:
    return PreparationDeviceOut(
        id=preparation.id,
        name=preparation.name,
        mode=preparation.mode.value,
        prefilled_qty=str(units.base_qty_to_decimal(preparation.standard_yield_qty, preparation.standard_yield_unit)),
        standard_yield_unit=preparation.standard_yield_unit,
        shelf_life_days=preparation.shelf_life_days,
    )


def produce_out(batch: PrepBatch) -> ProduceOut:
    return ProduceOut(
        id=batch.id,
        preparation_id=batch.preparation_id,
        qty_expected=str(units.base_qty_to_decimal(batch.qty_expected, batch.unit)),
        qty_real=str(units.base_qty_to_decimal(batch.qty_real, batch.unit)),
        unit=batch.unit,
        variance_pct=str((Decimal(batch.variance_pct_x100) / 100).quantize(Decimal("0.01"))),
        variance_alert=batch.variance_alert,
        expiry_date=batch.expiry_date,
        produced_at=batch.produced_at,
    )


def batch_admin_out(batch: PrepBatch) -> PrepBatchAdminOut:
    from app.core.quantity import format_cost_micros

    return PrepBatchAdminOut(
        id=batch.id,
        preparation_id=batch.preparation_id,
        qty_expected=str(units.base_qty_to_decimal(batch.qty_expected, batch.unit)),
        qty_real=str(units.base_qty_to_decimal(batch.qty_real, batch.unit)),
        unit=batch.unit,
        variance_pct=str((Decimal(batch.variance_pct_x100) / 100).quantize(Decimal("0.01"))),
        variance_alert=batch.variance_alert,
        total_cost=format_cost_micros(batch.total_cost_micros) if batch.total_cost_micros is not None else None,
        unit_cost=format_cost_micros(batch.unit_cost_micros) if batch.unit_cost_micros is not None else None,
        cost_source=batch.cost_source,
        expiry_date=batch.expiry_date,
        produced_by_employee_id=batch.produced_by_employee_id,
        produced_by_employee_name=batch.produced_by_employee_name,
        produced_at=batch.produced_at,
        note=batch.note,
        closed_at=batch.closed_at,
        closed_reason=batch.closed_reason,
    )


# ---------------------------------------------------------------------------
# Fichas técnicas del plato (§4.3) — versionadas.
# ---------------------------------------------------------------------------


def _current_recipe_lines(db: Session, recipe: Recipe) -> tuple[RecipeVersion | None, list[RecipeLine]]:
    if recipe.current_version == 0:
        return None, []
    version = db.execute(
        select(RecipeVersion).where(RecipeVersion.recipe_id == recipe.id, RecipeVersion.version == recipe.current_version)
    ).scalar_one_or_none()
    if version is None:
        return None, []
    lines = list(db.execute(select(RecipeLine).where(RecipeLine.recipe_version_id == version.id)).scalars().all())
    return version, lines


def get_product_recipe(db: Session, *, actor: Actor, product_id: int) -> ProductRecipeOut:
    from app.catalog import service as catalog_service
    from app.core.quantity import format_cost_micros

    product = catalog_service.product_or_404(db, actor, product_id)
    store_id = product.store_id
    recipe = db.execute(
        select(Recipe).where(Recipe.product_id == product_id, Recipe.store_id == store_id)
    ).scalar_one_or_none()

    net_price, _rate = cost.product_net_price(db, product, store_id)

    if recipe is None:
        from app.inventory.models import CostSource

        return ProductRecipeOut(
            product_id=product_id, version=0, theoretical_cost=None, cost_source=CostSource.NONE.value,
            food_cost_pct=None, net_price=net_price, lines=[],
        )

    _version, lines = _current_recipe_lines(db, recipe)
    if not lines:
        from app.inventory.models import CostSource

        return ProductRecipeOut(
            product_id=product_id, version=recipe.current_version, theoretical_cost=None,
            cost_source=CostSource.NONE.value, food_cost_pct=None, net_price=net_price, lines=[],
        )

    cost_micros, source = cost.recipe_lines_cost(db, lines, store_id=store_id)
    pct = cost.food_cost_pct(cost_micros, net_price)
    theoretical_cost = format_cost_micros(cost_micros) if cost_micros is not None else None
    return ProductRecipeOut(
        product_id=product_id,
        version=recipe.current_version,
        theoretical_cost=theoretical_cost,
        cost_source=source.value,
        food_cost_pct=pct,
        net_price=net_price,
        lines=[
            _line_out(
                db, store_id=store_id, ingredient_id=line.ingredient_id, preparation_id=line.preparation_id,
                qty_base=line.qty_base, unit=line.unit,
            )
            for line in lines
        ],
    )


def put_product_recipe(db: Session, *, actor: Actor, product_id: int, data: ProductRecipeIn) -> ProductRecipeOut:
    from app.catalog import service as catalog_service

    product = catalog_service.product_or_404(db, actor, product_id)
    store_id = product.store_id
    now = clock.now_utc()

    recipe = db.execute(
        select(Recipe).where(Recipe.product_id == product_id, Recipe.store_id == store_id)
    ).scalar_one_or_none()

    if recipe is None:
        if data.version != 0:
            raise ConflictError(
                "Alguien ya modificó esta ficha (o todavía no existe); recargá antes de guardar",
                code="RECIPE_VERSION_STALE",
            )
        recipe = Recipe(
            organization_id=actor.organization_id, store_id=store_id, product_id=product_id,
            current_version=0, created_at=now, updated_at=now,
        )
        db.add(recipe)
        db.flush()
    elif data.version != recipe.current_version:
        raise ConflictError(
            "Alguien ya guardó una versión más nueva de esta ficha; recargá antes de guardar",
            code="RECIPE_VERSION_STALE",
        )

    built = _built_lines(db, store_id, data.lines)

    new_version_number = recipe.current_version + 1
    version = RecipeVersion(
        recipe_id=recipe.id, version=new_version_number, created_at=now,
        created_by_employee_id=actor.employee_id, created_by_employee_name=actor.employee_name,
    )
    db.add(version)
    db.flush()
    for ingredient_id, preparation_id, qty_base, unit in built:
        db.add(
            RecipeLine(
                recipe_version_id=version.id, ingredient_id=ingredient_id, preparation_id=preparation_id,
                qty_base=qty_base, unit=unit,
            )
        )
    recipe.current_version = new_version_number
    recipe.updated_at = now
    db.flush()

    record_audit(
        db, actor=actor, organization_id=actor.organization_id, store_id=store_id, entity="recipe",
        entity_id=recipe.id, action="new_version",
        before={"version": new_version_number - 1}, after={"version": new_version_number},
    )
    return get_product_recipe(db, actor=actor, product_id=product_id)


# ---------------------------------------------------------------------------
# `recipe_effect` de las opciones de modificador
# ---------------------------------------------------------------------------


def put_modifier_option_recipe_effect(db: Session, *, actor: Actor, option_id: int, data: RecipeEffectIn) -> RecipeEffectOut:
    from app.catalog import service as catalog_service

    option = catalog_service.modifier_option_or_404(db, actor, option_id)
    store_id = option.store_id
    now = clock.now_utc()

    built = []
    for item in data.lines:
        base_unit = _component_base_unit(
            db, store_id=store_id, ingredient_id=item.ingredient_id, preparation_id=item.preparation_id
        )
        qty_base = units.to_base_qty(item.qty, item.unit, base_unit)
        built.append((item, qty_base))

    existing = db.execute(
        select(ModifierOptionRecipeEffect).where(ModifierOptionRecipeEffect.modifier_option_id == option_id)
    ).scalar_one_or_none()

    if existing is None:
        existing = ModifierOptionRecipeEffect(
            organization_id=actor.organization_id, store_id=store_id, modifier_option_id=option_id,
            effect=RecipeEffectType(data.effect), created_at=now, updated_at=now,
        )
        db.add(existing)
        db.flush()
    else:
        existing.effect = RecipeEffectType(data.effect)
        existing.updated_at = now
        db.execute(
            sa_delete(ModifierOptionRecipeEffectLine).where(ModifierOptionRecipeEffectLine.effect_id == existing.id)
        )

    for item, qty_base in built:
        db.add(
            ModifierOptionRecipeEffectLine(
                effect_id=existing.id, ingredient_id=item.ingredient_id, preparation_id=item.preparation_id,
                qty_base=qty_base, unit=item.unit,
                replaces_ingredient_id=item.replaces_ingredient_id,
                replaces_preparation_id=item.replaces_preparation_id,
            )
        )
    db.flush()

    record_audit(
        db, actor=actor, organization_id=actor.organization_id, store_id=store_id,
        entity="modifier_option_recipe_effect", entity_id=existing.id, action="upsert",
        before=None, after={"effect": existing.effect.value},
    )
    return recipe_effect_out(db, existing)


def recipe_effect_out(db: Session, effect: ModifierOptionRecipeEffect) -> RecipeEffectOut:
    effect_lines = list(
        db.execute(
            select(ModifierOptionRecipeEffectLine).where(ModifierOptionRecipeEffectLine.effect_id == effect.id)
        )
        .scalars()
        .all()
    )
    lines_out = []
    for line in effect_lines:
        base = _line_out(
            db, store_id=effect.store_id, ingredient_id=line.ingredient_id, preparation_id=line.preparation_id,
            qty_base=line.qty_base, unit=line.unit,
        )
        lines_out.append(
            RecipeEffectLineOut(
                **base.model_dump(),
                replaces_ingredient_id=line.replaces_ingredient_id,
                replaces_preparation_id=line.replaces_preparation_id,
            )
        )
    return RecipeEffectOut(modifier_option_id=effect.modifier_option_id, effect=effect.effect.value, lines=lines_out)


# ---------------------------------------------------------------------------
# Validaciones y cobertura (§4.3)
# ---------------------------------------------------------------------------

# "Receta sospechosa de unidad" (18 kg donde iban 18 g): una línea de insumo
# cuya cantidad en unidad base se aparta en DOS ÓRDENES DE MAGNITUD (>= 100x
# o <= 1/100) de la mediana de su categoría (misma unidad base, calculada
# sobre las demás fichas VIGENTES de la sede), o que supera un techo absoluto
# por unidad base — este último cubre el caso sin mediana confiable todavía
# (categoría nueva, o con menos de `MIN_CATEGORY_SAMPLE` líneas comparables).
SUSPICIOUS_CATEGORY_MULTIPLIER = 100
MIN_CATEGORY_SAMPLE = 3
SUSPICIOUS_CEILING_BASE_UNIT: dict[str, int] = {
    "g": 10_000,  # 10 kg en una sola línea de un plato: sospechoso.
    "ml": 10_000,  # 10 L.
    "unit": 500,
}


def suspicious_recipe_lines(db: Session, *, store_id: int) -> list[dict[str, Any]]:
    from app.core.quantity import QTY_SCALE
    from app.inventory import hooks as inventory_hooks

    stmt = (
        select(RecipeLine, RecipeVersion.recipe_id, Recipe.product_id)
        .join(RecipeVersion, RecipeVersion.id == RecipeLine.recipe_version_id)
        .join(Recipe, Recipe.id == RecipeVersion.recipe_id)
        .where(Recipe.store_id == store_id, RecipeVersion.version == Recipe.current_version, RecipeLine.ingredient_id.is_not(None))
    )
    rows = db.execute(stmt).all()

    # Mediana por categoría de insumo (en unidades base enteras, sin QTY_SCALE).
    by_category: dict[str, list[int]] = {}
    ingredient_cache: dict[int, Any] = {}

    def _ingredient(ingredient_id: int) -> Any:
        if ingredient_id not in ingredient_cache:
            ingredient_cache[ingredient_id] = inventory_hooks.get_ingredient(
                db, store_id=store_id, ingredient_id=ingredient_id
            )
        return ingredient_cache[ingredient_id]

    parsed: list[tuple[RecipeLine, int, Any]] = []
    for line, _recipe_id, product_id in rows:
        ingredient = _ingredient(line.ingredient_id)
        if ingredient is None:
            continue
        qty_units = line.qty_base // QTY_SCALE
        parsed.append((line, product_id, ingredient))
        by_category.setdefault(ingredient.category, []).append(qty_units)

    def _median(values: list[int]) -> Decimal | None:
        if not values:
            return None
        ordered = sorted(values)
        n = len(ordered)
        mid = n // 2
        if n % 2:
            return Decimal(ordered[mid])
        return (Decimal(ordered[mid - 1]) + Decimal(ordered[mid])) / 2

    from app.catalog.models import Product

    result: list[dict[str, Any]] = []
    for line, product_id, ingredient in parsed:
        qty_units = Decimal(line.qty_base) / Decimal(QTY_SCALE)
        ceiling = SUSPICIOUS_CEILING_BASE_UNIT.get(ingredient.base_unit)
        reason = None
        if ceiling is not None and qty_units >= ceiling:
            reason = f"supera el techo de {ceiling} {ingredient.base_unit} por línea"
        else:
            category_values = [v for v in by_category.get(ingredient.category, []) if True]
            others = [v for v in category_values if v != line.qty_base // QTY_SCALE] or category_values
            if len(others) >= MIN_CATEGORY_SAMPLE:
                median = _median(others)
                if median is not None and median > 0:
                    if qty_units >= median * SUSPICIOUS_CATEGORY_MULTIPLIER:
                        reason = f"{SUSPICIOUS_CATEGORY_MULTIPLIER}x la mediana de su categoría ({median} {ingredient.base_unit})"
                    elif qty_units <= median / SUSPICIOUS_CATEGORY_MULTIPLIER:
                        reason = f"1/{SUSPICIOUS_CATEGORY_MULTIPLIER} de la mediana de su categoría ({median} {ingredient.base_unit})"
        if reason is None:
            continue
        product = db.get(Product, product_id)
        result.append(
            {
                "product_id": product_id,
                "product_name": product.name if product is not None else None,
                "ingredient_id": ingredient.id,
                "ingredient_name": ingredient.name,
                "qty": str(qty_units),
                "unit": ingredient.base_unit,
                "reason": reason,
            }
        )
    return result
