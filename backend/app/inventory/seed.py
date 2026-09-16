"""Insumos de desarrollo: `seed_inventory(db, store)`. La llama
`app.seed.seed()` después de `app.catalog.seed.seed_catalog` — una base
recién sembrada tiene que poder ejercitar el camino nuevo, igual que hoy
carga los rangos de numeración DIAN de desarrollo.

Idempotente: si la sede ya tiene algún insumo, no repite nada.

Cubre a propósito, en un solo lote: `yield_pct` distinto de 100 (para que
`apply_yield` se vea en acción), costo oficial con origen, `min_stock` real
(nunca `0`, sería `400 MIN_STOCK_REQUIRED`), un `key_item`, un
`consumption_untracked`, y un par con sustituto en cascada (leche entera ->
deslactosada, el caso exacto de la referencia).
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import clock
from app.core.quantity import parse_cost_micros, parse_qty_base
from app.inventory.models import BaseUnit, Ingredient
from app.stores.models import Store


def seed_inventory(db: Session, store: Store) -> list[Ingredient]:
    if db.execute(select(Ingredient).where(Ingredient.store_id == store.id)).scalars().first() is not None:
        return []

    org_id = store.organization_id
    now = clock.now_utc()

    def _ingredient(
        name: str,
        *,
        category: str,
        base_unit: BaseUnit,
        purchase_unit: str,
        purchase_factor: int,
        yield_pct: int = 100,
        official_cost: str | None = None,
        estimated_cost: str | None = None,
        min_stock: str,
        lead_time_days: int | None = None,
        perishable: bool = False,
        key_item: bool = False,
        consumption_untracked: bool = False,
        substitute_ingredient_id: int | None = None,
    ) -> Ingredient:
        row = Ingredient(
            organization_id=org_id,
            store_id=store.id,
            name=name,
            category=category,
            base_unit=base_unit,
            purchase_unit=purchase_unit,
            purchase_factor=purchase_factor,
            yield_pct=yield_pct,
            official_cost_micros=parse_cost_micros(official_cost) if official_cost is not None else None,
            estimated_cost_micros=parse_cost_micros(estimated_cost) if estimated_cost is not None else None,
            min_stock=parse_qty_base(min_stock),
            lead_time_days=lead_time_days,
            perishable=perishable,
            key_item=key_item,
            active=True,
            consumption_untracked=consumption_untracked,
            substitute_ingredient_id=substitute_ingredient_id,
            supplier_id=None,
            created_at=now,
            updated_at=now,
        )
        db.add(row)
        db.flush()
        return row

    # Pechuga de pollo: rinde 85% limpia -> `apply_yield` descuenta más que
    # la cantidad limpia de la receta. Costo oficial, crítico (entra al
    # conteo rápido de 2b), perecedero.
    chicken = _ingredient(
        "Pechuga de pollo",
        category="Proteínas",
        base_unit=BaseUnit.G,
        purchase_unit="kg",
        purchase_factor=1000,
        yield_pct=85,
        official_cost="14.5",  # $14,5/g == $14.500/kg
        min_stock="5000",  # 5 kg
        lead_time_days=2,
        perishable=True,
        key_item=True,
    )

    # Leche deslactosada: el SUSTITUTO (se crea primero para poder
    # referenciarlo).
    lactose_free_milk = _ingredient(
        "Leche deslactosada",
        category="Lácteos",
        base_unit=BaseUnit.ML,
        purchase_unit="litro",
        purchase_factor=1000,
        official_cost="4.2",
        min_stock="2000",
        lead_time_days=1,
        perishable=True,
    )

    # Leche entera: sustituto en cascada -> deslactosada (el caso exacto de
    # la referencia: "leche entera en -4 y deslactosada en +19" por dos
    # caminos de consumo independientes; acá hay UN solo camino,
    # `hooks.resolve_consumption_target`).
    _ingredient(
        "Leche entera",
        category="Lácteos",
        base_unit=BaseUnit.ML,
        purchase_unit="litro",
        purchase_factor=1000,
        official_cost="3.8",
        min_stock="3000",
        lead_time_days=1,
        perishable=True,
        substitute_ingredient_id=lactose_free_milk.id,
    )

    # Sal de mesa: consumo no predecible, sin receta, costo estimado (nadie
    # pesa la sal que usa cada plato; se mide entre dos conteos en 2b).
    _ingredient(
        "Sal de mesa",
        category="Abarrotes",
        base_unit=BaseUnit.G,
        purchase_unit="bulto 25kg",
        purchase_factor=25_000,
        estimated_cost="0.003",
        min_stock="1000",
        consumption_untracked=True,
    )

    # Arroz blanco: rendimiento 100% (identidad de `apply_yield`), costo
    # estimado (todavía sin costo oficial fijado por el dueño).
    _ingredient(
        "Arroz blanco",
        category="Abarrotes",
        base_unit=BaseUnit.G,
        purchase_unit="bulto 50kg",
        purchase_factor=50_000,
        estimated_cost="2.8",
        min_stock="10000",
        lead_time_days=3,
    )

    db.flush()
    return [chicken, lactose_free_milk]
