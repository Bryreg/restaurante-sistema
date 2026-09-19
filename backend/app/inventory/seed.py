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

**Pedido 2b agrega `seed_counts_and_purchase(db, store, admin_employee)`**:
dos conteos completos aplicados y consecutivos con una compra en el medio.
La spec de 2b pide "un conteo completo aplicado", pero con uno solo el food
cost real (`app.inventory.service.food_cost_report`) es `null` PARA SIEMPRE
— hacen falta DOS consecutivos para que la resta tenga con qué cerrar. Ver
la decisión completa en `outputs-2b/backend-inventario-espejo.md § 5`.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.deps import Actor
from app.auth.models import Employee
from app.core import clock, tz
from app.core.quantity import parse_cost_micros, parse_qty_base
from app.inventory import hooks
from app.inventory.models import (
    BaseUnit,
    CostSource,
    Ingredient,
    MovementCause,
    StockCount,
    StockCountLine,
    StockCountScope,
    StockCountStatus,
)
from app.stores.models import Store

#: Hace cuántos días siembra el seed el conteo completo de APERTURA de la
#: ventana de food cost real. Deliberadamente NO es `INVENTORY_STALE_DAYS`:
#: son dos números sin relación, y cuando este valía 14 —el mismo que el
#: umbral, y justo sobre su borde— cualquiera lo leía como el umbral repetido
#: a mano. Lo único que tiene que cumplir es quedar antes de la compra
#: sembrada (7 días atrás), para que la ventana entre los dos conteos la
#: contenga y el food cost real de la demo dé un número en vez de `null`.
SEED_OPENING_FULL_COUNT_DAYS_AGO = 21


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


def seed_counts_and_purchase(db: Session, store: Store, admin_employee: Employee) -> bool:
    """Dos conteos completos aplicados y consecutivos, con UNA compra en el
    medio. Devuelve `True` si sembró algo (para que `app.seed` lo reporte),
    `False` si ya existía (idempotente: si la sede ya tiene algún conteo, no
    repite nada).

    **Decisión declarada**: los dos conteos son "limpios" a propósito —
    `qty_counted` de cada renglón es EXACTAMENTE el stock del libro en ese
    instante (`hooks.current_stock(..., as_of=...)`), así que el ajuste de
    aplicar cada uno da `0` para todos los insumos. Fabricar una diferencia
    (un "faltante" de demostración) sería una elección de negocio silenciosa
    que no le corresponde a un seed de desarrollo — y además haría que
    `apply_count` escribiera un `count_adjustment` arbitrario que después
    hay que explicarle a quien recorra la base. Lo que este seed necesita
    demostrar es que el food cost real y el promedio ponderado FUNCIONAN con
    dos conteos reales, no que haya una varianza fabricada.

    No depende de que `app.purchases` exista: crea su propio `stock_batch` y
    su propio movimiento `cause=purchase` directamente con
    `app.inventory.hooks`, así que una base sembrada SIN el dominio de
    compras montado todavía puede mostrar el promedio ponderado, la última
    compra y un food cost real no nulo. Se llama DESPUÉS de
    `seed_inventory`/`seed_recipes`/`app.purchases.seed.seed_purchases` (si
    existe): si `purchases` ya sembró sus propias recepciones, esas quedan
    ADEMÁS de la compra de acá (no hay conflicto: son movimientos distintos,
    fechados en instantes distintos)."""
    if db.execute(select(StockCount).where(StockCount.store_id == store.id)).scalars().first() is not None:
        return False

    ingredients = list(
        db.execute(select(Ingredient).where(Ingredient.store_id == store.id, Ingredient.active.is_(True)))
        .scalars()
        .all()
    )
    if not ingredients:
        return False

    actor = Actor(
        kind="admin",
        organization_id=store.organization_id,
        store_id=store.id,
        employee_id=admin_employee.id,
        employee_name=admin_employee.name,
        role=admin_employee.role,
    )

    def _open_and_apply_full_count(at: datetime) -> StockCount:
        business_date = tz.business_date_for(at, store.cutoff_hour)
        count = StockCount(
            organization_id=store.organization_id,
            store_id=store.id,
            scope=StockCountScope.FULL,
            status=StockCountStatus.OPEN,
            opened_at=at,
            business_date=business_date,
            opened_by_employee_id=admin_employee.id,
            opened_by_employee_name=admin_employee.name,
            applied_at=None,
            applied_by_employee_id=None,
            applied_by_employee_name=None,
        )
        db.add(count)
        db.flush()
        for ingredient in ingredients:
            current = hooks.current_stock(db, store_id=store.id, ingredient_id=ingredient.id, as_of=at)
            db.add(
                StockCountLine(
                    count_id=count.id, ingredient_id=ingredient.id, qty_counted=current, was_counted=True, counted_at=at
                )
            )
        db.flush()
        # Aplicar: `qty_counted == stock_at_count_instant` para todos, así
        # que el ajuste da 0 (conteo "limpio" a propósito, ver docstring) —
        # no hace falta pasar por `app.inventory.service.apply_count`.
        count.status = StockCountStatus.APPLIED
        count.applied_at = at
        count.applied_by_employee_id = admin_employee.id
        count.applied_by_employee_name = admin_employee.name
        db.flush()
        return count

    now = clock.now_utc()
    # Conteo completo de APERTURA de la ventana de food cost real. El único
    # requisito es que quede ANTES de la compra sembrada (7 días atrás) para
    # que la ventana entre los dos conteos la contenga; no tiene ninguna
    # relación con `INVENTORY_STALE_DAYS`. Va como constante con nombre
    # porque antes era `days=14` —el mismo número que el umbral de
    # «inventario no confiable», y además justo sobre su borde (`unreliable =
    # días > 14`)—, y un lector razonable lo leía como el umbral repetido a
    # mano. Lo era por coincidencia, que es la peor forma de serlo.
    _open_and_apply_full_count(now - timedelta(days=SEED_OPENING_FULL_COUNT_DAYS_AGO))

    purchase_at = now - timedelta(days=7)
    purchase_business_date = tz.business_date_for(purchase_at, store.cutoff_hour)
    key_ingredient = next((i for i in ingredients if i.key_item), ingredients[0])
    unit_cost_micros = key_ingredient.official_cost_micros or key_ingredient.estimated_cost_micros or 1_000_000
    qty_purchased = 5000  # 5 (kg/L/unidades) en milésimas de la unidad base

    batch = hooks.create_stock_batch(
        db,
        organization_id=store.organization_id,
        store_id=store.id,
        ingredient_id=key_ingredient.id,
        qty_base=qty_purchased,
        unit_cost_micros=unit_cost_micros,
        cost_source=CostSource.OFFICIAL,
        lot_code="SEED-0001",
        expires_at=None,
        received_at=purchase_at,
        business_date=purchase_business_date,
        source_type="seed",
        source_id=0,
    )
    hooks.record_movement(
        db,
        organization_id=store.organization_id,
        store_id=store.id,
        ingredient_id=key_ingredient.id,
        qty_base=qty_purchased,
        cause=MovementCause.PURCHASE,
        cost_micros=unit_cost_micros,
        cost_source=CostSource.OFFICIAL,
        actor=actor,
        business_date=purchase_business_date,
        at=purchase_at,
        ref_type="stock_batch",
        ref_id=batch.id,
    )

    _open_and_apply_full_count(now - timedelta(days=1))
    return True
