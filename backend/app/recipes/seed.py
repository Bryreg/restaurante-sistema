"""`seed_recipes(db, store)`: la llama `app.seed.seed()` (vía
`find_spec_safe`, nunca al arrancar la API), después de `catalog.seed` y del
seed de insumos de `app.inventory` — una base recién sembrada tiene que poder
ejercitar el camino nuevo (§4.1/§4.2/§4.3), igual que hoy carga los rangos de
numeración.

Idempotente: si la sede ya tiene una `Recipe`, no repite nada.

Este dominio no siembra insumos por su cuenta en el seed general
(`app.inventory.seed`, si existe, es quien decide qué insumos carga la
sede) — pero como ninguno de los dos dominios controla el orden del otro
desde acá, y esta función necesita insumos concretos con nombre conocido
para poder armar fichas y preparaciones de ejemplo, `_get_or_create_ingredient`
es idempotente por nombre: si `app.inventory.seed` ya sembró un insumo con
ese nombre exacto, lo reutiliza; si no, lo crea con los mismos campos que
publica `app.inventory.models.Ingredient`."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import clock
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
from app.core.quantity import QTY_SCALE
from app.recipes.units import to_base_qty
from app.stores.models import Store


def _get_or_create_ingredient(db: Session, store: Store, *, name: str, **kwargs: object) -> Any:
    """`min_stock` se recibe en UNIDAD BASE (g, ml, unidad) y se guarda en
    milésimas, que es la escala de `app/core/quantity.py`.

    Antes se pasaba el entero crudo a la columna, que está en milésimas: el
    pollo quedaba con un mínimo de **2 gramos** en vez de 2 kg, el limón con
    **0,05 unidades** en vez de 50, y la gaseosa con **0,024 botellas** en vez
    de 24. Seis insumos con el umbral mil veces más chico, o sea con la
    alerta de «bajo mínimo» apagada — que es textualmente el defecto que
    SPEC-NEGOCIO §4.1 existe para evitar («en la referencia 55 de 56
    productos quedaron con el motor de alertas apagado»).

    `app/inventory/seed.py` ya lo hacía bien, pasando por `parse_qty_base`.
    Eran dos seeds con dos escalas para la misma columna."""
    from app.inventory.models import Ingredient

    if "min_stock" in kwargs:
        kwargs["min_stock"] = int(kwargs["min_stock"]) * QTY_SCALE  # type: ignore[call-overload,arg-type]

    existing = db.execute(
        select(Ingredient).where(Ingredient.store_id == store.id, Ingredient.name == name)
    ).scalar_one_or_none()
    if existing is not None:
        return existing
    now = clock.now_utc()
    row = Ingredient(
        organization_id=store.organization_id,
        store_id=store.id,
        name=name,
        active=True,
        created_at=now,
        updated_at=now,
        **kwargs,
    )
    db.add(row)
    db.flush()
    return row


def seed_recipes(db: Session, store: Store) -> None:
    if db.execute(select(Recipe).where(Recipe.store_id == store.id)).scalars().first() is not None:
        return

    from app.catalog.models import ModifierOption, Product
    from app.inventory import hooks as inventory_hooks
    from app.inventory.models import BaseUnit

    now = clock.now_utc()

    def _product(name: str) -> Product | None:
        return db.execute(
            select(Product).where(Product.store_id == store.id, Product.name == name)
        ).scalar_one_or_none()

    # -- Insumos con costo oficial, umbral > 0 y un yield distinto de 100 ---
    # Los tres primeros los carga ya `app/inventory/seed.py` con otro nombre
    # parecido; antes se sembraban dos veces («Pollo en pechuga» y «Pechuga de
    # pollo», «Arroz» y «Arroz blanco», «Sal» y «Sal de mesa»), y el pollo
    # desmechado consumía el duplicado, que quedaba en negativo para siempre.
    # Con el mismo nombre, `_get_or_create_ingredient` reutiliza el que existe.
    pollo = _get_or_create_ingredient(
        db, store, name="Pechuga de pollo", category="Proteínas", base_unit=BaseUnit.G, purchase_unit="kg",
        purchase_factor=1000, yield_pct=85, official_cost_micros=12_000_000, estimated_cost_micros=None,
        min_stock=2_000, lead_time_days=2, perishable=True, key_item=True, consumption_untracked=False,
        substitute_ingredient_id=None, supplier_id=None,
    )
    papa = _get_or_create_ingredient(
        db, store, name="Papa criolla", category="Verduras", base_unit=BaseUnit.G, purchase_unit="kg",
        purchase_factor=1000, yield_pct=90, official_cost_micros=3_000_000, estimated_cost_micros=None,
        min_stock=5_000, lead_time_days=2, perishable=True, key_item=False, consumption_untracked=False,
        substitute_ingredient_id=None, supplier_id=None,
    )
    arroz = _get_or_create_ingredient(
        db, store, name="Arroz blanco", category="Abarrotes", base_unit=BaseUnit.G, purchase_unit="kg",
        purchase_factor=1000, yield_pct=100, official_cost_micros=4_000_000, estimated_cost_micros=None,
        min_stock=10_000, lead_time_days=7, perishable=False, key_item=False, consumption_untracked=False,
        substitute_ingredient_id=None, supplier_id=None,
    )
    limon = _get_or_create_ingredient(
        db, store, name="Limón", category="Frutas", base_unit=BaseUnit.UNIT, purchase_unit="unit",
        purchase_factor=1, yield_pct=100, official_cost_micros=300_000_000, estimated_cost_micros=None,
        min_stock=50, lead_time_days=2, perishable=True, key_item=False, consumption_untracked=False,
        substitute_ingredient_id=None, supplier_id=None,
    )
    panela = _get_or_create_ingredient(
        db, store, name="Panela", category="Abarrotes", base_unit=BaseUnit.G, purchase_unit="kg",
        purchase_factor=1000, yield_pct=100, official_cost_micros=4_000_000, estimated_cost_micros=None,
        min_stock=3_000, lead_time_days=7, perishable=False, key_item=False, consumption_untracked=False,
        substitute_ingredient_id=None, supplier_id=None,
    )
    gaseosa_insumo = _get_or_create_ingredient(
        db, store, name="Gaseosa 400ml (botella)", category="Bebidas", base_unit=BaseUnit.UNIT, purchase_unit="unit",
        purchase_factor=1, yield_pct=100, official_cost_micros=2_500_000_000, estimated_cost_micros=None,
        min_stock=24, lead_time_days=3, perishable=False, key_item=False, consumption_untracked=False,
        substitute_ingredient_id=None, supplier_id=None,
    )
    # `consumption_untracked`: sin receta, se mide entre dos conteos (§4.1) —
    # se declara pero no entra en ninguna línea de receta.
    _get_or_create_ingredient(
        db, store, name="Sal de mesa", category="Abarrotes", base_unit=BaseUnit.G, purchase_unit="kg",
        purchase_factor=1000, yield_pct=100, official_cost_micros=2_000_000, estimated_cost_micros=None,
        min_stock=1_000, lead_time_days=14, perishable=False, key_item=False, consumption_untracked=True,
        substitute_ingredient_id=None, supplier_id=None,
    )

    # -- Preparación en modo `exploded` (default): hogao ---------------------
    # 1000 g de hogao = 600 g de tomate... (usamos sólo insumos ya creados
    # para no inflar el seed) 700 g de papa + 300 g de limón simbólico no
    # aplica; usamos panela+papa como base simplificada del ejemplo.
    hogao = Preparation(
        organization_id=store.organization_id, store_id=store.id, name="Hogao",
        mode=PrepMode.EXPLODED, standard_yield_qty=to_base_qty("1000", "g", "g"), standard_yield_unit="g",
        process_loss_pct=10, shelf_life_days=2, active=True, created_at=now, updated_at=now,
    )
    db.add(hogao)
    db.flush()
    db.add(
        PreparationLine(
            preparation_id=hogao.id, ingredient_id=papa.id, component_preparation_id=None,
            qty_base=to_base_qty("1000", "g", "g"), unit="g",
        )
    )
    db.flush()

    # -- Preparación en modo `batch`: pollo desmechado, con un lote ya
    # producido (costo real propagado) ---------------------------------------
    pollo_desmechado = Preparation(
        organization_id=store.organization_id, store_id=store.id, name="Pollo desmechado",
        mode=PrepMode.BATCH, standard_yield_qty=to_base_qty("1000", "g", "g"), standard_yield_unit="g",
        process_loss_pct=15, shelf_life_days=3, active=True, created_at=now, updated_at=now,
    )
    db.add(pollo_desmechado)
    db.flush()
    db.add(
        PreparationLine(
            preparation_id=pollo_desmechado.id, ingredient_id=pollo.id, component_preparation_id=None,
            qty_base=to_base_qty("1300", "g", "g"), unit="g",
        )
    )
    db.flush()

    # Un lote ya producido, vía la única escritura de inventario
    # (`record_movement`), para que la sede recién sembrada tenga costo real
    # por lote (no sólo estándar) desde el primer arranque.
    from datetime import timedelta

    from app.inventory.models import MovementCause

    qty_expected = pollo_desmechado.standard_yield_qty
    qty_real = qty_expected  # sin varianza en el seed
    pollo_yield_qty = to_base_qty("1300", "g", "g")
    from app.core.quantity import QTY_SCALE, apply_yield

    consumed_pollo = apply_yield(pollo_yield_qty, pollo.yield_pct)
    cost_micros, cost_source = inventory_hooks.resolve_ingredient_cost(db, pollo)
    total_cost_micros = None if cost_micros is None else consumed_pollo * cost_micros // QTY_SCALE
    unit_cost_micros = None if total_cost_micros is None else total_cost_micros * QTY_SCALE // qty_real

    from app.auth.deps import Actor
    from app.core import tz

    seed_employee_id = _seed_employee_id(db, store)
    seed_actor = Actor(
        kind="admin", organization_id=store.organization_id, store_id=store.id,
        employee_id=seed_employee_id, employee_name="Seed", role="admin",
    )
    business_date = tz.today_business_date(store.cutoff_hour)
    batch = PrepBatch(
        organization_id=store.organization_id, store_id=store.id, preparation_id=pollo_desmechado.id,
        qty_expected=qty_expected, qty_real=qty_real, unit="g", variance_pct_x100=0, variance_alert=False,
        total_cost_micros=total_cost_micros, unit_cost_micros=unit_cost_micros,
        cost_source=cost_source.value,
        expiry_date=business_date + timedelta(days=pollo_desmechado.shelf_life_days or 0),
        produced_by_employee_id=seed_employee_id, produced_by_employee_name="Seed",
        produced_at=now, business_date=business_date, note="Lote de arranque (seed)",
    )
    db.add(batch)
    db.flush()
    inventory_hooks.record_movement(
        db, organization_id=store.organization_id, store_id=store.id, ingredient_id=pollo.id,
        qty_base=-consumed_pollo, cause=MovementCause.PRODUCTION_OUT, cost_micros=cost_micros,
        cost_source=cost_source, actor=seed_actor, business_date=business_date, at=now,
        ref_type="prep_batch", ref_id=batch.id, note="Seed",
    )
    inventory_hooks.record_movement(
        db, organization_id=store.organization_id, store_id=store.id, preparation_id=pollo_desmechado.id,
        qty_base=qty_real, cause=MovementCause.PRODUCTION_IN, cost_micros=unit_cost_micros,
        cost_source=cost_source, actor=seed_actor,
        business_date=business_date, at=now, ref_type="prep_batch", ref_id=batch.id, note="Seed",
    )

    # -- Fichas técnicas: varios productos de la carta del seed --------------
    def _save_recipe(product: Product | None, lines: list[tuple[int | None, int | None, str, str]]) -> None:
        if product is None or not lines:
            return
        recipe = Recipe(
            organization_id=store.organization_id, store_id=store.id, product_id=product.id,
            current_version=0, created_at=now, updated_at=now,
        )
        db.add(recipe)
        db.flush()
        version = RecipeVersion(
            recipe_id=recipe.id, version=1, created_at=now, created_by_employee_id=None,
            created_by_employee_name="Seed",
        )
        db.add(version)
        db.flush()
        for ingredient_id, preparation_id, qty, unit in lines:
            db.add(
                RecipeLine(
                    recipe_version_id=version.id, ingredient_id=ingredient_id, preparation_id=preparation_id,
                    qty_base=to_base_qty(qty, unit, unit), unit=unit,
                )
            )
        recipe.current_version = 1
        db.flush()

    # Arroz con pollo: insumo con yield 85% + preparación batch (pollo desmechado).
    _save_recipe(
        _product("Arroz con pollo"),
        [(arroz.id, None, "250", "g"), (None, pollo_desmechado.id, "180", "g")],
    )
    # Bandeja paisa: usa hogao (exploded, se aplana a insumos al enviar) + arroz.
    _save_recipe(
        _product("Bandeja paisa"), [(arroz.id, None, "200", "g"), (None, hogao.id, "80", "g")]
    )
    # Sancocho de gallina: insumo directo de pollo con su propio yield.
    _save_recipe(_product("Sancocho de gallina"), [(pollo.id, None, "400", "g")])
    # Limonada de coco: insumo directo simple.
    _save_recipe(_product("Limonada de coco"), [(limon.id, None, "3", "unit")])
    # Gaseosa: "consume un insumo uno a uno" (§4.3) — ficha de una sola línea.
    _save_recipe(_product("Gaseosa"), [(gaseosa_insumo.id, None, "1", "unit")])

    # -- `recipe_effect`: "Papa criolla" (extra en Pechuga a la plancha) suma
    # consumo de papa criolla.
    pechuga = _product("Pechuga a la plancha")
    if pechuga is not None:
        option = db.execute(
            select(ModifierOption).where(
                ModifierOption.store_id == store.id, ModifierOption.name == "Papa criolla"
            )
        ).scalar_one_or_none()
        if option is not None:
            effect = ModifierOptionRecipeEffect(
                organization_id=store.organization_id, store_id=store.id, modifier_option_id=option.id,
                effect=RecipeEffectType.ADD, created_at=now, updated_at=now,
            )
            db.add(effect)
            db.flush()
            db.add(
                ModifierOptionRecipeEffectLine(
                    effect_id=effect.id, ingredient_id=papa.id, preparation_id=None,
                    qty_base=to_base_qty("150", "g", "g"), unit="g",
                    replaces_ingredient_id=None, replaces_preparation_id=None,
                )
            )
            db.flush()


def _seed_employee_id(db: Session, store: Store) -> int:
    from app.auth.models import Employee

    admin = db.execute(
        select(Employee).where(Employee.organization_id == store.organization_id, Employee.role == "admin")
    ).scalars().first()
    if admin is not None:
        return admin.id
    any_employee = db.execute(
        select(Employee).where(Employee.organization_id == store.organization_id)
    ).scalars().first()
    if any_employee is None:
        raise RuntimeError("seed_recipes necesita al menos un empleado ya sembrado (corre después de auth.seed)")
    return any_employee.id
