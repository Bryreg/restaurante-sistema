"""Motor de costo: propaga insumo -> preparación -> plato, siempre **al
vuelo** (nunca materializado).

Decisión documentada (la pide la misión): el costo teórico de una preparación
y de una ficha se recalcula en cada lectura a partir del costo VIGENTE de sus
insumos, no se guarda en una columna que haya que invalidar. Nada acá escribe
en la base — es la misma razón por la que `expand_consumption` (`hooks.py`)
es pura. Ventajas sobre materializar-e-invalidar: cero grafo de invalidación
que mantener (una preparación puede usarse en N fichas y otra preparación
puede usar esta preparación: invalidar "transitivamente" es exactamente la
clase de bug que dejó la referencia sin propagación) y cero riesgo de que un
costo quede desactualizado por una escritura que se olvidó de invalidar. El
costo de lo que se pierde: cada lectura de una ficha con muchas preparaciones
anidadas repite trabajo (mitigado acá con memoización *por llamada* vía
`visiting`, no persistida). Con los volúmenes de una carta de restaurante
(decenas de productos, no miles) el costo de recalcular en cada consulta es
insignificante frente a la garantía de que "cambiar el costo de un insumo
cambia el costo de la preparación y el del plato que la usa" sea siempre
cierto, sin acordarse de invalidar nada.

Fórmulas (spec de negocio §4.2/§4.3), todo en enteros, acumulado en
millonésimas de principio a fin (nunca se redondea a pesos línea por línea):

    line_micros            = qty_base * cost_micros // QTY_SCALE
    ingrediente (con yield) = apply_yield(qty_base, yield_pct) * cost_micros // QTY_SCALE
    preparación (standard)  = Σ line_micros(líneas) * QTY_SCALE // standard_yield_qty
    preparación (real,lote) = Σ line_micros(líneas escaladas) * QTY_SCALE // qty_real
    ficha del plato          = Σ line_micros(insumo con yield) + Σ line_micros(preparación)
    food_cost_pct            = (costo_micros * 100) / (precio_neto_de_impuesto * COST_SCALE)

`food_cost_pct` se calcula **sobre los micros directamente**, sin pasar por
`micros_to_pesos` en ningún paso intermedio: redondear a pesos ANTES de
dividir por el precio hace que cualquier plato de costo menor a $1 (una
guarnición de sal, por ejemplo) dé `0.00 %` en vez de su porcentaje real.
El costo que viaja por la API de este dominio (`unit_cost`, `total_cost`,
`theoretical_cost`) también evita `micros_to_pesos`: sale como texto
decimal de precisión completa con `app.core.quantity.format_cost_micros`,
igual que `app.inventory.service.ingredient_out`. `micros_to_pesos` queda
reservado para plata de venta (el snapshot `order_items.unit_cost`, totales
de reportes en pesos), nunca para un costo por unidad base publicado acá.
"""

from __future__ import annotations

from decimal import Decimal
from typing import TYPE_CHECKING, Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.recipes.models import PrepBatch, PrepMode, Preparation, PreparationLine, RecipeLine

if TYPE_CHECKING:
    from app.catalog.models import Product
    from app.inventory.models import CostSource

# Orden de "confiabilidad": el peor origen entre las líneas manda el origen
# agregado (nunca se reporta "oficial" si una sola línea es "estimado", y
# nunca un total parcial se disfraza de completo si a una línea le falta
# costo del todo — ahí el agregado es `None`/`none`, no una suma que omite
# en silencio lo que no tenía costo).
_SOURCE_RANK: dict[str, int] = {
    "official": 0,
    "weighted_average": 1,
    "last_purchase": 2,
    "estimated": 3,
    "none": 4,
}


def _combine_sources(sources: Sequence["CostSource"]) -> "CostSource":
    from app.inventory.models import CostSource

    if not sources:
        return CostSource.NONE
    worst = max(sources, key=lambda s: _SOURCE_RANK.get(s.value, 4))
    return worst


def line_cost_micros(qty_base: int, cost_micros: int | None) -> int | None:
    """`null` si `cost_micros` es `null` — nunca un cero mudo."""
    from app.core.quantity import QTY_SCALE

    if cost_micros is None:
        return None
    return qty_base * cost_micros // QTY_SCALE


def compute_lines_cost(
    db: Session,
    lines: Sequence[RecipeLine | PreparationLine],
    *,
    store_id: int,
    scale_num: int = 1,
    scale_den: int = 1,
    visiting: frozenset[int] | None = None,
) -> tuple[int | None, "CostSource"]:
    """Costo total (micros) de un conjunto de líneas (de una `RecipeVersion`
    o de una `Preparation`), en `store_id`. `scale_num/scale_den` escala cada
    línea antes de costear (lo usa `produce()` cuando `qty_expected` distinto
    de `standard_yield_qty` de la preparación). `visiting` corta la
    recursión si, por un bug, una preparación se costea a sí misma (los
    ciclos reales se bloquean al GUARDAR, en `service.py`; esto es sólo
    defensivo, para nunca devolver un `500` por una recursión infinita)."""
    from app.inventory import hooks as inventory_hooks
    from app.inventory.models import CostSource

    visiting = visiting or frozenset()
    total = 0
    sources: list[CostSource] = []

    for line in lines:
        qty_base = line.qty_base
        if (scale_num, scale_den) != (1, 1):
            qty_base = qty_base * scale_num // scale_den

        if line.ingredient_id is not None:
            ingredient = inventory_hooks.get_ingredient(
                db, store_id=store_id, ingredient_id=line.ingredient_id
            )
            if ingredient is None:
                return None, CostSource.NONE
            cost_micros, source = inventory_hooks.resolve_ingredient_cost(db, ingredient)
            if cost_micros is None:
                return None, CostSource.NONE
            from app.core.quantity import apply_yield

            adjusted_qty = apply_yield(qty_base, ingredient.yield_pct)
            micros = line_cost_micros(adjusted_qty, cost_micros)
            if micros is None:
                return None, CostSource.NONE
            total += micros
            sources.append(source)
            continue

        component_id = (
            line.preparation_id if isinstance(line, RecipeLine) else line.component_preparation_id
        )
        if component_id is None or component_id in visiting:
            # Defensivo: sin componente resoluble, o ciclo colado. No debería
            # pasar (el guardado bloquea ciclos con PREP_CYCLE) pero nunca
            # 500 por esto.
            return None, CostSource.NONE
        component = db.get(Preparation, component_id)
        if component is None:
            return None, CostSource.NONE
        unit_cost, source = preparation_unit_cost(db, component, visiting=visiting | {component_id})
        if unit_cost is None:
            return None, CostSource.NONE
        micros = line_cost_micros(qty_base, unit_cost)
        if micros is None:
            return None, CostSource.NONE
        total += micros
        sources.append(source)

    if not sources:
        return None, CostSource.NONE
    return total, _combine_sources(sources)


def _preparation_lines(db: Session, preparation_id: int) -> list[PreparationLine]:
    stmt = select(PreparationLine).where(PreparationLine.preparation_id == preparation_id)
    return list(db.execute(stmt).scalars().all())


def preparation_standard_unit_cost(
    db: Session, preparation: Preparation, *, visiting: frozenset[int] | None = None
) -> tuple[int | None, "CostSource"]:
    """Costo estándar por unidad base de la preparación: Σ insumos (de UNA
    corrida estándar de la receta) ÷ `standard_yield_qty`. Origen `estimated`
    como mínimo salvo que el peor insumo de la cadena sea peor todavía
    (`_combine_sources` ya se encarga: nunca sube el origen, sólo baja al
    peor)."""
    from app.core.quantity import QTY_SCALE
    from app.inventory.models import CostSource

    lines = _preparation_lines(db, preparation.id)
    total_micros, source = compute_lines_cost(
        db, lines, store_id=preparation.store_id, visiting=(visiting or frozenset()) | {preparation.id}
    )
    if total_micros is None:
        return None, CostSource.NONE
    unit_cost = total_micros * QTY_SCALE // preparation.standard_yield_qty
    return unit_cost, source


def latest_open_batch(db: Session, preparation_id: int) -> PrepBatch | None:
    stmt = (
        select(PrepBatch)
        .where(PrepBatch.preparation_id == preparation_id, PrepBatch.closed_at.is_(None))
        .order_by(PrepBatch.produced_at.desc())
    )
    return db.execute(stmt).scalars().first()


def preparation_unit_cost(
    db: Session, preparation: Preparation, *, visiting: frozenset[int] | None = None
) -> tuple[int | None, "CostSource"]:
    """Costo por unidad base de la preparación **para consumo** (§4.2): real
    por lote mientras haya stock agregado del último lote no cerrado; estándar
    en cualquier otro caso (modo `exploded`, o `batch` sin producción
    todavía). No promedia varios lotes abiertos a la vez (eso es FIFO real,
    `inventory.lots`, alcance de 2b) — usa el más reciente."""
    from app.inventory import hooks as inventory_hooks

    if preparation.mode == PrepMode.BATCH:
        stock = inventory_hooks.current_stock(
            db, store_id=preparation.store_id, preparation_id=preparation.id
        )
        if stock > 0:
            batch = latest_open_batch(db, preparation.id)
            if batch is not None and batch.unit_cost_micros is not None:
                from app.inventory.models import CostSource

                return batch.unit_cost_micros, CostSource(batch.cost_source)
    return preparation_standard_unit_cost(db, preparation, visiting=visiting)


def recipe_lines_cost(
    db: Session, lines: Sequence[RecipeLine], *, store_id: int
) -> tuple[int | None, "CostSource"]:
    """Costo teórico de una ficha (§4.3): misma `compute_lines_cost`, sin
    escala (las cantidades de `RecipeLine` ya son "por unidad vendida")."""
    return compute_lines_cost(db, lines, store_id=store_id)


def food_cost_pct(cost_micros: int | None, net_price_pesos: int) -> Decimal | None:
    """`costo / precio neto de impuesto` (§4.3), como porcentaje con 2
    decimales. `None` (nunca `0`) sin costo o sin precio positivo.

    Calculado **sobre los micros directamente**, sin redondear a pesos en
    ningún paso intermedio (`micros_to_pesos` queda fuera de esta cuenta a
    propósito): un plato de costo real $0,30 tiene que reportar un
    `food_cost_pct` distinto de `0.00` — si primero se redondea el costo a
    pesos enteros, $0,30 se trunca a $0 y el porcentaje sale `0.00` aunque
    el costo real no sea cero."""
    if cost_micros is None or net_price_pesos <= 0:
        return None
    from app.core.quantity import COST_SCALE

    return (Decimal(cost_micros) * 100 / (Decimal(net_price_pesos) * COST_SCALE)).quantize(Decimal("0.01"))


def product_net_price(db: Session, product: "Product", store_id: int) -> tuple[int, int]:
    """`(precio_neto_pesos, tax_rate_pct)` del producto (precio de mesa,
    obligatorio) usando la config fiscal vigente de la sede para saber si el
    precio guardado ya incluye impuesto. Reusa `round_half_up` de
    `app.orders.money` (la única matemática de redondeo del proyecto) en vez
    de reinventar el redondeo acá."""
    from app.core.tax import rate_for_code
    from app.orders.money import round_half_up
    from app.stores import service as stores_service

    rate = rate_for_code(product.tax_code)
    fiscal = stores_service.current_fiscal(db, store_id)
    price_includes_tax = fiscal.price_includes_tax if fiscal is not None else True
    price = product.price_dine_in
    if not price_includes_tax:
        return price, rate
    net = round_half_up(price * 100, 100 + rate)
    return net, rate
