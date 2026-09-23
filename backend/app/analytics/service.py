"""Toda la lógica y la matemática de `analytics` (T4,
`features/fase-3-dinero-control/spec.md § 2`; `docs/CONTEXTO-AGENTES.md §3`:
`service.py` es dueño de la matemática, `router.py` sólo del borde HTTP).

**Este dominio no almacena nada — todo se deriva** (§6.1: "derivar en vez de
almacenar"; la única columna almacenada de ese tipo en la referencia fue la
que se desincronizó). No hay `models.py` ni migración `0021`: ver el
entregable (`features/fase-3-dinero-control/outputs/backend-analitica.md`).

**El snapshot es sagrado.** Ingeniería de menú y varianza por plato leen
`OrderItem.unit_cost_micros` — el costo CONGELADO al vender — y nunca vuelven
a la ficha técnica de hoy (`app.recipes`) para valorar una venta pasada. Los
únicos números "de hoy" que entran en este módulo son el costo de insumo que
usa la SALUD DEL CONTROL para valorar un CONTEO (que es una foto de stock,
no una venta — `app.inventory.service._count_inventory_value` hace la misma
distinción) y el `lead_time_days`/`min_stock` de reposición, que son
configuración vigente, no una venta pasada.

**Límite de import deliberado, documentado una sola vez acá.** El mandato de
este territorio es explícito: `app/inventory/service.py` se lee **sólo**
para ver `_variance_level` (el semáforo por renglón de un conteo, que D-1 no
toca) — nunca se importa. Pero D-1 ("sostenido") y la varianza por plato
necesitan exactamente la MISMA identidad que ya implementan
`food_cost_report`/`variance_report` en ese archivo (inicial + entradas −
cierre = uso real, contra teórico; `(inicial + compras − final) ÷ ventas
netas`), extendida a MÚLTIPLES ventanas históricas (algo que esas funciones
no ofrecen: sólo resuelven la ventana MÁS RECIENTE dentro de un rango).
Reimplementar esa identidad por fuera, usando datos inventados, sería la
"segunda matemática" que `AGENTS.md` prohíbe. La resolución: las funciones
`_count_inventory_value`, `_purchases_value` y `_signed_pct_bp` de acá abajo
son un ESPEJO LITERAL, línea por línea, de las funciones del mismo nombre en
`app.inventory.service` — compuestas EXCLUSIVAMENTE con primitivas
PUBLICADAS (`app.inventory.hooks.get_ingredient`,
`app.inventory.hooks.resolve_ingredient_cost`, `app.core.quantity.
line_cost_micros`/`micros_to_pesos`) y lectura de sólo lectura de
`StockCount`/`StockCountLine`/`StockMovement` (modelos, no lógica — mismo
patrón que `app.reports.service` ya usa para leer `Order`/`FiscalDocument`
de otros dominios, y que `app.expenses.service` usa para leer
`app.reports.service` directamente en este mismo pedido). Documentado como
GAP en el entregable: si la fórmula de `food_cost_report`/`variance_report`
cambia alguna vez, este espejo puede desincronizarse — se recomienda que
`app.inventory.hooks` publique una función de ventanas históricas en un
pedido futuro para que este archivo deje de necesitar el espejo."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.analytics.schemas import (
    MenuClassCountsOut,
    MenuClassLiteral,
    MenuEngineeringOut,
    MenuEngineeringRowOut,
    ReplenishmentOut,
    ReplenishmentRowOut,
    SustainedOut,
    SustainedWindowOut,
    VarianceByDishOut,
    VarianceByDishRowOut,
)
from app.catalog import hooks as catalog_hooks
from app.core.errors import AppError, NotFoundError
from app.core.percent import format_pct_bp
from app.core.quantity import format_qty_base, line_cost_micros, micros_to_pesos
from app.inventory import hooks as inventory_hooks
from app.inventory.models import (
    Ingredient,
    MovementCause,
    StockCount,
    StockCountLine,
    StockCountScope,
    StockCountStatus,
    StockMovement,
    StoreInventorySettings,
)
from app.orders import service as orders_service
from app.orders import hooks as orders_hooks
from app.orders.models import Order, OrderChannel, OrderItem, OrderItemStatus, OrderStatus
from app.orders.money import prorate
from app.stores.models import Store

# ---------------------------------------------------------------------------
# Compartido.
# ---------------------------------------------------------------------------

def _validate_range(date_from: date, date_to: date) -> None:
    if date_from > date_to:
        raise AppError("VALIDATION_ERROR", "from: tiene que ser anterior o igual a to", status=400)


def _half_up(numerator: int, denominator: int) -> int:
    """Redondeo half-up genérico para CANTIDADES (no plata): mismo criterio
    que `app.orders.money.round_half_up`, reimplementado acá porque esa
    función está declarada y documentada para pesos — reusarla para
    milésimas de insumo mezclaría dos magnitudes bajo el nombre de una."""
    if denominator <= 0:
        raise ValueError("denominator debe ser positivo")
    q, r = divmod(numerator, denominator)
    if r * 2 >= denominator:
        q += 1
    return q


def _signed_half_up(numerator: int, denominator: int) -> int:
    """Redondeo half-up con signo (`denominator > 0`, `numerator` puede ser
    negativo) — `_half_up` no admite negativos porque `app.orders.money.
    round_half_up`, en el que se inspira, tampoco (plata siempre >= 0); acá
    sí hace falta (una varianza o un margen pueden ser negativos)."""
    sign = -1 if numerator < 0 else 1
    return sign * _half_up(abs(numerator), denominator)


def _signed_pct_bp(value_pesos: int, denominator_pesos: int) -> int:
    """`value / denominator` en puntos básicos, con signo — mismo cálculo,
    letra por letra, que `app.inventory.service.food_cost_report` usa para
    su `pct_bp` (espejo declarado en el docstring del módulo). `denominator`
    > 0 siempre (lo valida el llamador antes)."""
    return _signed_half_up(value_pesos * 10000, denominator_pesos)


# (Las ventas netas y el costo teórico de una ventana ya no se leen acá por
# `business_date`: salen de `app.orders.hooks.sales_in_window`, por instante
# de cobro, la misma lectura que usa `app.inventory.service.food_cost_report`.)


# ---------------------------------------------------------------------------
# GET /admin/menu-engineering
# ---------------------------------------------------------------------------

# Regla del 70 % (Kasavana–Smith): un plato es "popular" si su participación
# en las unidades vendidas es al menos el 70 % de la participación pareja
# ("si todos los platos vendieran igual"). En bp para no usar float.
_POPULARITY_RULE_NUM = 7
_POPULARITY_RULE_DEN = 10


# Mínimo de unidades vendidas para clasificar un plato (informe #7: «Sopa
# de guineo», con 18, salía «Perro»). Configurable por query (`min_units`).
MENU_MIN_UNITS_DEFAULT = 20

_ACTION_BY_CLASS: dict[str, str] = {
    "star": "Mantener",
    "plowhorse": "Revisar precio",
    "puzzle": "Promocionar",
    "dog": "Sacar o rediseñar",
}


@dataclass
class _ProductAgg:
    name: str = ""
    qty_sold: int = 0
    revenue_net: int = 0
    # Ingreso neto y unidades de los ítems CON costo congelado: el margen se
    # calcula sólo sobre ellos (nunca costo de una parte contra ingreso del
    # todo — informe #4).
    costed_revenue_net: int = 0
    cost_micros: int = 0
    qty_costed: int = 0
    has_cost: bool = False


def _empty_menu(
    store: Store, date_from: date, date_to: date, reason: str, *, category_id: int | None, min_units: int, excluded: int = 0
) -> MenuEngineeringOut:
    return MenuEngineeringOut(
        store_id=store.id, date_from=date_from, date_to=date_to, available=False, reason=reason,
        popularity_threshold_bp=None, avg_contribution_margin_per_unit=None, rows=[],
        category_id=category_id, min_units=min_units, min_costed_pct_bp=inventory_hooks.FOOD_COST_MIN_COSTED_BP,
        costed_pct_bp=None, counts_by_class=MenuClassCountsOut(), excluded_products=excluded,
    )


def menu_engineering(
    db: Session,
    *,
    store: Store,
    date_from: date,
    date_to: date,
    category_id: int | None = None,
    min_units: int = MENU_MIN_UNITS_DEFAULT,
) -> MenuEngineeringOut:
    """Matriz de Kasavana–Smith sobre lo vendido en el período.

    Informe de visualización #7 / analista #5: (1) los CARGOS
    (`is_delivery_fee`) y la comida de personal (`staff_meal`, precio 0) no
    son platos que el cliente elige: se excluyen de la matriz Y de los
    umbrales (el cargo de domicilio bajaba el umbral de popularidad a
    1/21); (2) un plato con menos de `min_units` unidades no se clasifica
    (`classification: None`, `insufficient_sample: True`) pero sigue en la
    mezcla; (3) el margen se compara POR UNIDAD, y se publica
    (`contribution_margin_per_unit`); (4) `category_id` filtra y los
    umbrales se calculan dentro de la categoría."""
    _validate_range(date_from, date_to)
    if min_units < 1:
        raise AppError("VALIDATION_ERROR", "min_units: tiene que ser al menos 1", status=400)

    orders = list(
        db.execute(
            select(Order).where(
                Order.store_id == store.id,
                Order.business_date >= date_from,
                Order.business_date <= date_to,
                Order.status == OrderStatus.PAID,
            )
        ).scalars()
    )
    if not orders:
        return _empty_menu(
            store, date_from, date_to, "No hay ventas cobradas en el período", category_id=category_id, min_units=min_units
        )

    agg: dict[int, _ProductAgg] = {}
    staff_meal_products: set[int] = set()
    for order in orders:
        if order.channel == OrderChannel.STAFF_MEAL:
            # Comida de personal: sale a precio 0, no es una venta que el
            # cliente eligió. Se cuenta sólo para informar la exclusión.
            for pid in db.execute(
                select(OrderItem.product_id).where(
                    OrderItem.order_id == order.id,
                    OrderItem.status != OrderItemStatus.VOIDED,
                    OrderItem.product_id.is_not(None),
                )
            ).scalars():
                if pid is not None:
                    staff_meal_products.add(int(pid))
            continue
        # `compute_order_totals` es LA única matemática de la venta
        # (`app.orders.money`): reusada tal cual, sobre los campos
        # CONGELADOS del ítem (nunca la carta de hoy) — no se reimplementa
        # el prorrateo de descuento de comanda por plato.
        totals = orders_service.compute_order_totals(db, order)
        base_by_item = {lt.item_id: lt.base for lt in totals.lines}
        items = db.execute(
            select(OrderItem).where(
                OrderItem.order_id == order.id,
                OrderItem.status != OrderItemStatus.VOIDED,
                OrderItem.product_id.is_not(None),
            )
        ).scalars()
        for item in items:
            assert item.product_id is not None
            row = agg.setdefault(item.product_id, _ProductAgg())
            row.name = item.name  # último nombre congelado visto, no el de la carta actual
            row.qty_sold += item.qty
            base = base_by_item.get(item.id, 0)
            row.revenue_net += base
            if item.unit_cost_micros is not None:
                row.has_cost = True
                row.cost_micros += int(item.unit_cost_micros) * item.qty
                row.qty_costed += item.qty
                row.costed_revenue_net += base

    facts = catalog_hooks.product_facts(
        db, store_id=store.id, product_ids=sorted(set(agg) | staff_meal_products)
    )
    fee_ids = {pid for pid, f in facts.items() if f.is_delivery_fee}
    excluded_ids = (fee_ids & set(agg)) | (staff_meal_products - set(agg))
    for pid in fee_ids:
        agg.pop(pid, None)
    if category_id is not None:
        agg = {pid: r for pid, r in agg.items() if pid in facts and facts[pid].category_id == category_id}

    if not agg:
        return _empty_menu(
            store, date_from, date_to,
            "No hay platos vendidos (con producto de carta) en el período"
            + (" para esa categoría" if category_id is not None else ""),
            category_id=category_id, min_units=min_units, excluded=len(excluded_ids),
        )

    min_costed_bp = inventory_hooks.FOOD_COST_MIN_COSTED_BP
    total_qty = sum(r.qty_sold for r in agg.values())
    n_products = len(agg)
    popularity_threshold_bp = (
        _POPULARITY_RULE_NUM * 10000 // (_POPULARITY_RULE_DEN * n_products)
    )

    def _coverage_ok(row: _ProductAgg) -> bool:
        return row.has_cost and row.qty_costed > 0 and row.qty_costed * 10000 >= min_costed_bp * row.qty_sold

    # Margen de contribución promedio POR UNIDAD, ponderado por las unidades
    # con costo, sólo entre los platos con cobertura suficiente (nunca se
    # promedia con `None` como si fuera cero — "el promedio de 'sin dato' no
    # es cero").
    costed_margin_total = 0
    costed_qty_total = 0
    for row in agg.values():
        if _coverage_ok(row):
            costed_margin_total += row.costed_revenue_net - micros_to_pesos(row.cost_micros)
            costed_qty_total += row.qty_costed
    avg_margin_per_unit = (
        _signed_half_up(costed_margin_total, costed_qty_total) if costed_qty_total > 0 else None
    )
    revenue_total = sum(r.revenue_net for r in agg.values())
    costed_revenue_total = sum(r.costed_revenue_net for r in agg.values())
    costed_pct_bp = _half_up(max(costed_revenue_total, 0) * 10000, revenue_total) if revenue_total > 0 else None

    counts = MenuClassCountsOut()
    rows: list[MenuEngineeringRowOut] = []
    for product_id, row in agg.items():
        popularity_share_bp = _half_up(row.qty_sold * 10000, total_qty)
        theoretical_cost = micros_to_pesos(row.cost_micros) if row.has_cost else None
        contribution_margin = (row.costed_revenue_net - theoretical_cost) if theoretical_cost is not None else None
        margin_per_unit = (
            _signed_half_up(contribution_margin, row.qty_costed)
            if contribution_margin is not None and row.qty_costed > 0
            else None
        )
        margin_pct_bp = (
            _signed_pct_bp(contribution_margin, row.costed_revenue_net)
            if contribution_margin is not None and row.costed_revenue_net > 0
            else None
        )
        costed_qty_pct_bp = _half_up(row.qty_costed * 10000, row.qty_sold) if row.qty_sold > 0 else None

        classification: MenuClassLiteral | None
        reason: str
        insufficient = row.qty_sold < min_units
        if insufficient:
            classification = None
            reason = (
                f"vendió {row.qty_sold} unidades en el período; hacen falta al menos {min_units} "
                "para clasificarlo con confianza"
            )
            counts.insufficient_sample += 1
        elif contribution_margin is None or avg_margin_per_unit is None:
            classification = "unclassified"
            reason = "sin costo congelado suficiente para calcular margen en el período"
        elif not _coverage_ok(row):
            classification = "unclassified"
            reason = (
                f"sólo {row.qty_costed} de {row.qty_sold} unidades tenían ficha con costo; "
                f"hace falta al menos el {format_pct_bp(min_costed_bp, decimals=0)} para clasificar"
            )
        else:
            popular = popularity_share_bp >= popularity_threshold_bp
            # Margen UNITARIO del plato contra el promedio unitario, sin
            # dividir (evita comparar dos cifras ya redondeadas):
            # margin/qty_costed >= total/qty_total  <=>  margin*qty_total >= total*qty_costed.
            profitable = contribution_margin * costed_qty_total >= costed_margin_total * row.qty_costed
            if popular and profitable:
                classification, reason = "star", "alta popularidad y margen sobre el promedio"
            elif popular and not profitable:
                classification, reason = "plowhorse", "alta popularidad, margen bajo el promedio"
            elif not popular and profitable:
                classification, reason = "puzzle", "baja popularidad, margen sobre el promedio"
            else:
                classification, reason = "dog", "baja popularidad y margen bajo el promedio"
        if classification is not None:
            setattr(counts, classification, getattr(counts, classification) + 1)

        fact = facts.get(product_id)
        rows.append(
            MenuEngineeringRowOut(
                product_id=product_id,
                product_name=row.name,
                category_id=fact.category_id if fact else None,
                category_name=fact.category_name if fact else None,
                qty_sold=row.qty_sold,
                popularity_share_bp=popularity_share_bp,
                revenue_net=row.revenue_net,
                theoretical_cost=theoretical_cost,
                contribution_margin=contribution_margin,
                contribution_margin_per_unit=margin_per_unit,
                margin_pct_bp=margin_pct_bp,
                costed_qty_pct_bp=costed_qty_pct_bp,
                insufficient_sample=insufficient,
                classification=classification,
                classification_reason=reason,
                recommended_action=_ACTION_BY_CLASS.get(classification) if classification else None,
            )
        )

    rows.sort(key=lambda r: (-r.qty_sold, r.product_id))

    return MenuEngineeringOut(
        store_id=store.id,
        date_from=date_from,
        date_to=date_to,
        available=True,
        reason=None,
        popularity_threshold_bp=popularity_threshold_bp,
        avg_contribution_margin_per_unit=avg_margin_per_unit,
        rows=rows,
        category_id=category_id,
        min_units=min_units,
        min_costed_pct_bp=min_costed_bp,
        costed_pct_bp=costed_pct_bp,
        counts_by_class=counts,
        excluded_products=len(excluded_ids),
    )


# ---------------------------------------------------------------------------
# Espejo de `app.inventory.service` (ver docstring del módulo, arriba):
# `_count_inventory_value`, `_purchases_value`. Usadas por `sostenido` (D-1)
# Y por la varianza por plato.
# ---------------------------------------------------------------------------


def _applied_full_counts_desc(db: Session, *, store_id: int) -> list[StockCount]:
    """Todos los conteos `full` `applied` de la sede, del MÁS RECIENTE al
    más viejo. `app.inventory.hooks` sólo publica el más reciente
    (`last_applied_full_count_at`); esta lectura es de sólo modelo (mismo
    patrón que `app.reports.service` lee `Order`/`FiscalDocument` de otros
    dominios), no reimplementa ninguna lógica de negocio."""
    stmt = (
        select(StockCount)
        .where(
            StockCount.store_id == store_id,
            StockCount.scope == StockCountScope.FULL,
            StockCount.status == StockCountStatus.APPLIED,
        )
        .order_by(StockCount.opened_at.desc())
    )
    return list(db.execute(stmt).scalars().all())


def _count_inventory_value(db: Session, *, store: Store, count: StockCount) -> int:
    """Espejo literal de `app.inventory.service._count_inventory_value`:
    valoriza, en pesos, los renglones CONTADOS de un conteo, al costo
    resuelto de HOY (`hooks.resolve_ingredient_cost`) — valoriza un CONTEO
    (una foto de stock), no una venta, así que no rompe el snapshot de
    venta que protege este módulo."""
    total_micros = 0
    lines = db.execute(select(StockCountLine).where(StockCountLine.count_id == count.id)).scalars()
    for line in lines:
        if not line.was_counted or line.qty_counted is None:
            continue
        ingredient = inventory_hooks.get_ingredient(db, store_id=store.id, ingredient_id=line.ingredient_id)
        if ingredient is None:
            continue
        cost_micros, _source = inventory_hooks.resolve_ingredient_cost(db, ingredient)
        if cost_micros is None:
            continue
        total_micros += line_cost_micros(line.qty_counted, cost_micros)
    return micros_to_pesos(total_micros)


def _purchases_value(db: Session, *, store: Store, window_from: datetime, window_to: datetime) -> int:
    """Espejo literal de `app.inventory.service._purchases_value`."""
    total_micros = 0
    stmt = select(StockMovement).where(
        StockMovement.store_id == store.id,
        StockMovement.cause == MovementCause.PURCHASE,
        StockMovement.at > window_from,
        StockMovement.at <= window_to,
    )
    for movement in db.execute(stmt).scalars():
        if movement.cost_micros is not None:
            total_micros += line_cost_micros(movement.qty_base, movement.cost_micros)
    return micros_to_pesos(total_micros)


# ---------------------------------------------------------------------------
# GET /admin/control-health/sustained (D-1)
# ---------------------------------------------------------------------------

# Fallback si la sede nunca configuró `StoreInventorySettings` (fila
# `lazy` — `app.inventory.service.get_inventory_settings` la crea recién al
# primer `GET`/`PUT` de umbrales de ESE dominio, territorio ajeno que este
# módulo no toca): mismo valor que el `default=400` de la columna
# `variance_red_threshold_bp` en `app.inventory.models.StoreInventorySettings`
# — el mismo "4 puntos" que SPEC-NEGOCIO §5.4 describe como el techo de
# "revisar" / piso de "sostenido rojo". D-1 dice "supera el umbral rojo":
# se reutiliza EL MISMO umbral que la sede ya calibra para la varianza de
# inventario (§5.4 lo describe con el mismo número, `< 2 verde, 2-4 revisar,
# > 4-5 rojo`) en vez de inventar un segundo umbral con otro nombre — dos
# umbrales rojos distintos para "food cost sale de madre" serían la clase de
# ambigüedad que las reglas de plata de este proyecto prohíben. Declarado
# como decisión en el entregable, no asumido en silencio.
_SUSTAINED_RED_THRESHOLD_BP_DEFAULT = 400

_SUSTAINED_WINDOWS_NEEDED = 3
_SUSTAINED_RED_HITS_REQUIRED = 2
_SUSTAINED_MIN_WINDOWS = 2


def _red_threshold_bp(db: Session, *, store_id: int) -> int:
    row = db.execute(
        select(StoreInventorySettings.variance_red_threshold_bp).where(
            StoreInventorySettings.store_id == store_id
        )
    ).scalar_one_or_none()
    return int(row) if row is not None else _SUSTAINED_RED_THRESHOLD_BP_DEFAULT


@dataclass(frozen=True)
class _WindowGap:
    gap_bp: int
    real_pct_bp: int
    theoretical_pct_bp: int
    window_hours: int
    window_days: int
    orders: int
    costed_pct_bp: int


def _purchase_movement_count(db: Session, *, store: Store, window_from: datetime, window_to: datetime) -> int:
    stmt = select(func.count(StockMovement.id)).where(
        StockMovement.store_id == store.id,
        StockMovement.cause == MovementCause.PURCHASE,
        StockMovement.at > window_from,
        StockMovement.at <= window_to,
    )
    return int(db.execute(stmt).scalar_one())


def _window_food_cost_gap_bp(db: Session, *, store: Store, opening: StockCount, closing: StockCount) -> _WindowGap | None:
    """Brecha de food cost (real − teórico, en puntos básicos) para la
    ventana `[opening, closing]` — la MISMA ventana y las MISMAS guardas que
    `app.inventory.service.food_cost_report`: ventas por instante de cobro
    (`app.orders.hooks.sales_in_window`, nunca `business_date` inclusivo),
    teórico escalado a la cobertura de fichas y umbrales de
    `app.inventory.hooks` (ventana mínima, cobertura mínima). `None` —
    "no computable", nunca `0`— cuando la ventana no tiene ventas, es más
    corta que el mínimo, no alcanza la cobertura, tiene compras en $0 con
    recepciones o da un costo real negativo."""
    w_from, w_to = opening.opened_at, closing.opened_at
    if inventory_hooks.window_is_too_short(w_from, w_to):
        return None
    sales = orders_hooks.sales_in_window(db, store_id=store.id, paid_after=w_from, paid_until=w_to)
    if sales.net_sales <= 0:
        return None
    theoretical = inventory_hooks.theoretical_food_cost(
        net_sales=sales.net_sales, costed_net=sales.costed_net, theoretical_cost_micros=sales.theoretical_cost_micros
    )
    if theoretical.pct_bp is None or theoretical.costed_pct_bp is None:
        return None

    opening_value = _count_inventory_value(db, store=store, count=opening)
    closing_value = _count_inventory_value(db, store=store, count=closing)
    purchases_value = _purchases_value(db, store=store, window_from=w_from, window_to=w_to)
    if purchases_value <= 0 and _purchase_movement_count(db, store=store, window_from=w_from, window_to=w_to) > 0:
        return None
    real_cost = opening_value + purchases_value - closing_value
    if real_cost < 0:
        return None
    real_pct_bp = _signed_pct_bp(real_cost, sales.net_sales)
    hours, days = inventory_hooks.window_span(w_from, w_to)

    return _WindowGap(
        gap_bp=real_pct_bp - theoretical.pct_bp,
        real_pct_bp=real_pct_bp,
        theoretical_pct_bp=theoretical.pct_bp,
        window_hours=hours,
        window_days=days,
        orders=sales.orders,
        costed_pct_bp=theoretical.costed_pct_bp,
    )


def control_health_sustained(db: Session, *, store: Store) -> SustainedOut:
    """D-1: `sustained_red` es `True` cuando la brecha de food cost superó
    el umbral rojo en al menos 2 de las últimas 3 ventanas COMPUTABLES
    (con food cost real disponible) — nunca de "las últimas 3 que haya",
    ciegamente: una ventana sin ventas netas, sin costo congelado
    suficiente o más corta que el mínimo no se cuenta ni a favor ni en
    contra, se salta (`windows_skipped`) y se sigue buscando hacia atrás en
    el historial. Con menos de 2 ventanas computables: `None` con `reason`,
    nunca verde."""
    red_threshold_bp = _red_threshold_bp(db, store_id=store.id)
    counts = _applied_full_counts_desc(db, store_id=store.id)  # más reciente primero

    windows_out: list[SustainedWindowOut] = []
    exceed_count = 0
    skipped = 0
    for idx in range(len(counts) - 1):
        if len(windows_out) >= _SUSTAINED_WINDOWS_NEEDED:
            break
        closing, opening = counts[idx], counts[idx + 1]  # counts está en orden descendente
        gap = _window_food_cost_gap_bp(db, store=store, opening=opening, closing=closing)
        if gap is None:
            skipped += 1
            continue
        exceeds = gap.gap_bp > red_threshold_bp
        if exceeds:
            exceed_count += 1
        windows_out.append(
            SustainedWindowOut(
                window_index=len(windows_out) + 1,
                opening_count_id=opening.id,
                closing_count_id=closing.id,
                window_from=opening.opened_at.isoformat(),
                window_to=closing.opened_at.isoformat(),
                real_pct_bp=gap.real_pct_bp,
                theoretical_pct_bp=gap.theoretical_pct_bp,
                gap_bp=gap.gap_bp,
                exceeds_red=exceeds,
                window_hours=gap.window_hours,
                window_days=gap.window_days,
                orders_in_window=gap.orders,
                costed_pct_bp=gap.costed_pct_bp,
            )
        )

    def _out(sustained_red: bool | None, reason: str | None) -> SustainedOut:
        return SustainedOut(
            store_id=store.id,
            sustained_red=sustained_red,
            windows_evaluated=len(windows_out),
            reason=reason,
            red_threshold_bp=red_threshold_bp,
            windows=windows_out,
            min_window_days=inventory_hooks.FOOD_COST_MIN_WINDOW_DAYS,
            min_costed_pct_bp=inventory_hooks.FOOD_COST_MIN_COSTED_BP,
            windows_skipped=skipped,
        )

    if len(windows_out) < _SUSTAINED_MIN_WINDOWS:
        reason = (
            "sin historial suficiente: hacen falta al menos TRES conteos completos "
            "aplicados (dos períodos entre conteos) para saber si la brecha se sostiene"
        )
        if skipped:
            reason += (
                f"; {skipped} período(s) entre conteos no cuentan porque duran menos de "
                f"{inventory_hooks.FOOD_COST_MIN_WINDOW_HOURS} h, no tienen ventas, les falta ficha con costo "
                "a más del "
                f"{format_pct_bp(10000 - inventory_hooks.FOOD_COST_MIN_COSTED_BP, decimals=0)} de lo vendido, "
                "o su food cost real no tiene sentido"
            )
        return _out(None, reason)

    return _out(exceed_count >= _SUSTAINED_RED_HITS_REQUIRED, None)


# ---------------------------------------------------------------------------
# GET /admin/variance/by-dish
# ---------------------------------------------------------------------------


def _count_lines_counted(db: Session, count_id: int) -> dict[int, int]:
    rows = db.execute(
        select(StockCountLine.ingredient_id, StockCountLine.qty_counted, StockCountLine.was_counted).where(
            StockCountLine.count_id == count_id
        )
    ).all()
    return {ing_id: int(qty) for ing_id, qty, was_counted in rows if was_counted and qty is not None}


def _movement_sum(
    db: Session,
    *,
    store_id: int,
    ingredient_id: int,
    window_from: datetime,
    window_to: datetime,
    positive: bool,
    causes: tuple[MovementCause, ...] | None = None,
    exclude_causes: tuple[MovementCause, ...] = (),
) -> int:
    """Espejo de `app.inventory.service._movement_sum` (privada, no
    importada): misma consulta, reconstruida sobre el modelo público
    `StockMovement`."""
    stmt = select(func.coalesce(func.sum(StockMovement.qty_base), 0)).where(
        StockMovement.store_id == store_id,
        StockMovement.ingredient_id == ingredient_id,
        StockMovement.at > window_from,
        StockMovement.at <= window_to,
    )
    if causes is not None:
        stmt = stmt.where(StockMovement.cause.in_(causes))
    if exclude_causes:
        stmt = stmt.where(StockMovement.cause.notin_(exclude_causes))
    stmt = stmt.where(StockMovement.qty_base > 0 if positive else StockMovement.qty_base < 0)
    return int(db.execute(stmt).scalar_one())


@dataclass
class _IngredientVarianceRow:
    ingredient_id: int
    variance_qty: int
    variance_value: int | None
    cost_micros: int | None = None


def _ingredient_variance_rows(db: Session, *, store: Store, opening: StockCount, closing: StockCount) -> list[_IngredientVarianceRow]:
    """Espejo literal de `app.inventory.service.variance_report` (identidad
    `inicial + entradas − final = uso real`, contra teórico = ventas +
    producción) — NO de `_variance_level` (el semáforo, que este territorio
    no toca ni reimplementa). Sólo el valor en pesos y la cantidad, para
    prorratear entre platos; nunca clasifica verde/amarillo/rojo."""
    opening_lines = _count_lines_counted(db, opening.id)
    closing_lines = _count_lines_counted(db, closing.id)
    ingredient_ids = sorted(set(opening_lines) & set(closing_lines))

    rows: list[_IngredientVarianceRow] = []
    for ing_id in ingredient_ids:
        ingredient = inventory_hooks.get_ingredient(db, store_id=store.id, ingredient_id=ing_id)
        if ingredient is None:
            continue
        opening_qty = opening_lines[ing_id]
        closing_qty = closing_lines[ing_id]
        inflow = _movement_sum(
            db, store_id=store.id, ingredient_id=ing_id, window_from=opening.opened_at, window_to=closing.opened_at,
            positive=True, exclude_causes=(MovementCause.COUNT_ADJUSTMENT,),
        )
        real_usage = opening_qty + inflow - closing_qty
        theoretical = -_movement_sum(
            db, store_id=store.id, ingredient_id=ing_id, window_from=opening.opened_at, window_to=closing.opened_at,
            positive=False, causes=(MovementCause.SALE, MovementCause.PRODUCTION_OUT),
        )
        variance_qty = real_usage - theoretical
        if variance_qty == 0:
            continue
        cost_micros, _source = inventory_hooks.resolve_ingredient_cost(db, ingredient)
        variance_value = micros_to_pesos(line_cost_micros(variance_qty, cost_micros)) if cost_micros is not None else None
        rows.append(
            _IngredientVarianceRow(
                ingredient_id=ing_id, variance_qty=variance_qty, variance_value=variance_value, cost_micros=cost_micros
            )
        )
    return rows


def _dish_consumption_weights(
    db: Session, *, store_id: int, ingredient_id: int, window_from: datetime, window_to: datetime
) -> dict[int, int]:
    """`product_id -> Σ|qty_base|` consumido TEÓRICAMENTE por venta
    (`cause=SALE`, `ref_type="order_item"`) de este insumo en la ventana —
    el peso que usa el prorrateo. Un ítem sin `product_id` (no debería
    pasar: `record_movement` siempre se llama con `ref_id=OrderItem.id`)
    queda fuera del reparto, no rompe la consulta."""
    stmt = (
        select(OrderItem.product_id, StockMovement.qty_base)
        .join(OrderItem, StockMovement.ref_id == OrderItem.id)
        .where(
            StockMovement.store_id == store_id,
            StockMovement.ingredient_id == ingredient_id,
            StockMovement.cause == MovementCause.SALE,
            StockMovement.ref_type == "order_item",
            StockMovement.at > window_from,
            StockMovement.at <= window_to,
            StockMovement.qty_base < 0,
        )
    )
    weights: dict[int, int] = {}
    for product_id, qty_base in db.execute(stmt).all():
        if product_id is None:
            continue
        weights[product_id] = weights.get(product_id, 0) + (-int(qty_base))
    return weights


# Menos comandas que esto en la ventana y el reparto por plato es ruido
# (misma regla de «muestra chica» que el informe de visualización pide en
# todo porcentaje o promedio: n < 20).
VARIANCE_BY_DISH_MIN_SALES = 20
# Y una ventana de menos de 3 días también (misma regla del informe: «con n
# < 20 o una ventana de menos de 3 días se muestra en gris»). Es sólo una
# marca: el reparto se publica igual.
VARIANCE_BY_DISH_MIN_WINDOW_DAYS = 3


def variance_by_dish(db: Session, *, store: Store, count_id: int | None) -> VarianceByDishOut:
    """AJUSTE ITERACIÓN 2 (C3/H-3): `count_id` es OPCIONAL. `frontend/src/
    api/analytics.ts::getVarianceByDish` sólo manda `store_id` y documenta
    por escrito que el backend resuelve "el más reciente si se omite" — este
    lado no lo cumplía y la pantalla recibía `422` siempre. Se resuelve acá,
    del lado que sabe cuál fue el último conteo `full` `applied` de la sede
    (`_applied_full_counts_desc`, la MISMA lectura de sólo modelo que ya usa
    D-1 — sin importar `app.inventory.service`, sin tocar `_variance_level`).

    Sede sin NINGÚN conteo aplicado: ni `404` ni `422` — `available: false`
    con `reason` en palabras, la misma regla que ya aplica `control_health_
    sustained` para "sin historial suficiente" (D-1). Un `count_id`
    explícito sigue funcionando exactamente igual que antes: valida que
    exista, sea de esta sede, y sea un conteo `full` `applied`."""
    counts_desc = _applied_full_counts_desc(db, store_id=store.id)  # más reciente primero

    if count_id is None:
        if not counts_desc:
            return VarianceByDishOut(
                store_id=store.id,
                count_id=None,
                method="prorated",
                available=False,
                reason=(
                    "todavía no hay ningún conteo aplicado en esta sede, así que no hay "
                    "ventana contra la cual medir varianza"
                ),
                opening_count_id=None,
                window_from=None,
                window_to=None,
                total_variance_value=None,
                unattributed_variance_value=0,
                rows=[],
            )
        count: StockCount = counts_desc[0]
        resolved_count_id = count.id
    else:
        found = db.get(StockCount, count_id)
        if found is None or found.store_id != store.id:
            raise NotFoundError("El conteo no existe")
        if found.status != StockCountStatus.APPLIED or found.scope != StockCountScope.FULL:
            raise AppError(
                code="COUNT_NOT_APPLIED",
                message="La varianza por plato sólo se calcula sobre un conteo completo ya aplicado",
            )
        count = found
        resolved_count_id = count_id

    idx = next((i for i, c in enumerate(counts_desc) if c.id == count.id), None)
    if idx is None or idx + 1 >= len(counts_desc):
        return VarianceByDishOut(
            store_id=store.id,
            count_id=resolved_count_id,
            method="prorated",
            available=False,
            reason="No hay un conteo completo aplicado anterior contra el cual comparar",
            opening_count_id=None,
            window_from=None,
            window_to=None,
            total_variance_value=None,
            unattributed_variance_value=0,
            rows=[],
        )
    opening = counts_desc[idx + 1]

    ingredient_rows = _ingredient_variance_rows(db, store=store, opening=opening, closing=count)
    product_names = _product_names(db, store_id=store.id)

    per_product_value: dict[int, int] = {}
    per_product_ingredient_count: dict[int, int] = {}
    total_variance_value = 0
    unattributed = 0
    # Peso HOMOGÉNEO para publicar (informe #8): costo teórico consumido por
    # plato, en micros de peso (cantidad teórica × costo del insumo). Antes
    # se sumaban cantidades crudas de insumos con unidades distintas.
    grand_total_weight_micros = 0
    per_product_weight_micros: dict[int, int] = {}

    for irow in ingredient_rows:
        if irow.variance_value is None or irow.cost_micros is None:
            continue  # sin costo resuelto: no hay con qué valorar en pesos, se omite del reparto (declarado)
        total_variance_value += irow.variance_value
        weights = _dish_consumption_weights(
            db, store_id=store.id, ingredient_id=irow.ingredient_id, window_from=opening.opened_at, window_to=count.opened_at
        )
        if not weights:
            unattributed += irow.variance_value
            continue
        product_ids = sorted(weights.keys())
        # El prorrateo de UN insumo sí puede usar cantidades: todas están en
        # la misma unidad base de ese insumo.
        shares = prorate(abs(irow.variance_value), [weights[pid] for pid in product_ids])
        sign = -1 if irow.variance_value < 0 else 1
        for pid, share in zip(product_ids, shares):
            per_product_value[pid] = per_product_value.get(pid, 0) + sign * share
            per_product_ingredient_count[pid] = per_product_ingredient_count.get(pid, 0) + 1
            weight_micros = line_cost_micros(weights[pid], irow.cost_micros)
            per_product_weight_micros[pid] = per_product_weight_micros.get(pid, 0) + weight_micros
            grand_total_weight_micros += weight_micros

    rows: list[VarianceByDishRowOut] = []
    # Faltantes primero (positivo = se usó más de lo esperado), cada grupo
    # por |valor| desc; un reparto en 0 exacto va al final.
    ordered = sorted(
        per_product_value.items(), key=lambda kv: (0 if kv[1] > 0 else 1, -abs(kv[1]), kv[0])
    )
    for pid, value in ordered:
        share_bp = (
            _half_up(per_product_weight_micros.get(pid, 0) * 10000, grand_total_weight_micros)
            if grand_total_weight_micros
            else 0
        )
        rows.append(
            VarianceByDishRowOut(
                product_id=pid,
                product_name=product_names.get(pid, f"Producto #{pid}"),
                theoretical_consumption_share_bp=share_bp,
                variance_value=value,
                ingredients_involved=per_product_ingredient_count.get(pid, 0),
                direction="shortage" if value > 0 else "surplus",
            )
        )

    window_hours, window_days = inventory_hooks.window_span(opening.opened_at, count.opened_at)
    sales = orders_hooks.sales_in_window(
        db, store_id=store.id, paid_after=opening.opened_at, paid_until=count.opened_at
    )
    sample_problems: list[str] = []
    if count.opened_at - opening.opened_at < timedelta(days=VARIANCE_BY_DISH_MIN_WINDOW_DAYS):
        sample_problems.append(
            f"la ventana entre conteos dura {window_hours} h (hacen falta al menos "
            f"{VARIANCE_BY_DISH_MIN_WINDOW_DAYS} días)"
        )
    if sales.orders < VARIANCE_BY_DISH_MIN_SALES:
        sample_problems.append(
            f"se cobraron {sales.orders} comandas en la ventana (hacen falta al menos {VARIANCE_BY_DISH_MIN_SALES})"
        )
    insufficient_reason = (
        "Muestra insuficiente: " + " y ".join(sample_problems) + "; el reparto por plato es orientativo"
        if sample_problems
        else None
    )

    return VarianceByDishOut(
        store_id=store.id,
        count_id=resolved_count_id,
        method="prorated",
        available=True,
        reason=None,
        opening_count_id=opening.id,
        window_from=opening.opened_at.isoformat(),
        window_to=count.opened_at.isoformat(),
        total_variance_value=total_variance_value,
        unattributed_variance_value=unattributed,
        rows=rows,
        window_hours=window_hours,
        window_days=window_days,
        sales_in_window=sales.orders,
        insufficient_sample=bool(sample_problems),
        insufficient_sample_reason=insufficient_reason,
        min_window_days=VARIANCE_BY_DISH_MIN_WINDOW_DAYS,
        min_sales_in_window=VARIANCE_BY_DISH_MIN_SALES,
    )


def _product_names(db: Session, *, store_id: int) -> dict[int, str]:
    """Último nombre CONGELADO (`OrderItem.name`) visto por producto — nunca
    `Product.name` de la carta actual (§ snapshot). Barato: una fila por
    producto, no por venta."""
    stmt = (
        select(OrderItem.product_id, func.max(OrderItem.id))
        .where(OrderItem.store_id == store_id, OrderItem.product_id.is_not(None))
        .group_by(OrderItem.product_id)
    )
    pairs = db.execute(stmt).all()
    if not pairs:
        return {}
    last_ids = [last_id for _pid, last_id in pairs]
    names: dict[int, str] = {
        item_id: name
        for item_id, name in db.execute(
            select(OrderItem.id, OrderItem.name).where(OrderItem.id.in_(last_ids))
        ).all()
    }
    return {pid: names.get(last_id, f"Producto #{pid}") for pid, last_id in pairs}


# ---------------------------------------------------------------------------
# GET /admin/replenishment
# ---------------------------------------------------------------------------

REPLENISHMENT_LOOKBACK_DAYS = 30

_CONSUMPTION_CAUSES = (MovementCause.SALE, MovementCause.PRODUCTION_OUT)


def _daily_consumption(
    db: Session, *, store_id: int, ingredient_id: int, date_from: date, date_to: date
) -> dict[date, int]:
    """`business_date -> consumo` (positivo, milésimas de unidad base) de
    ventas y producción, por FECHA DE NEGOCIO (columna propia)."""
    stmt = (
        select(StockMovement.business_date, func.coalesce(func.sum(StockMovement.qty_base), 0))
        .where(
            StockMovement.store_id == store_id,
            StockMovement.ingredient_id == ingredient_id,
            StockMovement.business_date >= date_from,
            StockMovement.business_date <= date_to,
            StockMovement.cause.in_(_CONSUMPTION_CAUSES),
            StockMovement.qty_base < 0,
        )
        .group_by(StockMovement.business_date)
    )
    return {d: -int(total) for d, total in db.execute(stmt).all()}


def _first_movement_date(db: Session, *, store_id: int, ingredient_id: int) -> date | None:
    return db.execute(
        select(func.min(StockMovement.business_date)).where(
            StockMovement.store_id == store_id, StockMovement.ingredient_id == ingredient_id
        )
    ).scalar_one_or_none()


def _median_half_up(values: list[int]) -> int:
    ordered = sorted(values)
    n = len(ordered)
    mid = n // 2
    if n % 2:
        return ordered[mid]
    return _half_up(ordered[mid - 1] + ordered[mid], 2)


def replenishment(db: Session, *, store: Store) -> ReplenishmentOut:
    """Informe #17: el consumo diario se divide por los días REALES con
    historial dentro de la ventana (desde el primer movimiento del insumo, o
    el inicio de la ventana si es anterior, hasta hoy inclusive — 30 días en
    total, no los 31 que daba `today − 30`), no por 30 fijos: con 14 días
    de historia el promedio salía a la mitad. Se publica además la mediana
    diaria (días sin consumo cuentan como 0)."""
    ingredients = list(
        db.execute(
            select(Ingredient).where(Ingredient.store_id == store.id, Ingredient.active.is_(True))
        ).scalars()
    )
    if not ingredients:
        return ReplenishmentOut(
            store_id=store.id,
            available=False,
            reason="No hay insumos activos en la sede",
            lookback_days=REPLENISHMENT_LOOKBACK_DAYS,
            rows=[],
        )

    from app.core import tz as tz_module

    today = tz_module.today_business_date(store.cutoff_hour)
    since_date = today - timedelta(days=REPLENISHMENT_LOOKBACK_DAYS - 1)

    rows: list[ReplenishmentRowOut] = []
    for ing in ingredients:
        current = inventory_hooks.current_stock(db, store_id=store.id, ingredient_id=ing.id)
        suggested_qty_base = max(0, ing.min_stock - current)

        first = _first_movement_date(db, store_id=store.id, ingredient_id=ing.id)
        history_start = max(since_date, first) if first is not None else None
        history_days = (today - history_start).days + 1 if history_start is not None and history_start <= today else 0

        if ing.consumption_untracked:
            rows.append(
                ReplenishmentRowOut(
                    ingredient_id=ing.id,
                    ingredient_name=ing.name,
                    base_unit=ing.base_unit.value,  # type: ignore[attr-defined]
                    current_stock=format_qty_base(current),
                    min_stock=format_qty_base(ing.min_stock),
                    avg_daily_consumption=None,
                    median_daily_consumption=None,
                    history_days=history_days,
                    lead_time_days=ing.lead_time_days,
                    suggested_qty=format_qty_base(suggested_qty_base),
                    suggested_min=None,
                    based_on=f"consumo de los últimos {REPLENISHMENT_LOOKBACK_DAYS} días",
                    reason="insumo marcado como consumo no medido automáticamente (consumption_untracked)",
                )
            )
            continue

        daily: dict[date, int] = {}
        if history_start is not None and history_days > 0:
            daily = _daily_consumption(
                db, store_id=store.id, ingredient_id=ing.id, date_from=history_start, date_to=today
            )
        total_consumed = sum(daily.values())

        avg_daily_consumption: str | None = None
        median_daily_consumption: str | None = None
        suggested_min: str | None = None
        reason: str | None = None
        based_on = f"consumo de {history_days} día(s) con historial (de los últimos {REPLENISHMENT_LOOKBACK_DAYS})"

        if total_consumed <= 0 or history_days <= 0:
            reason = f"sin consumo registrado en los últimos {REPLENISHMENT_LOOKBACK_DAYS} días"
        else:
            assert history_start is not None  # history_days > 0 lo garantiza
            series = [daily.get(history_start + timedelta(days=i), 0) for i in range(history_days)]
            avg_daily_consumption = format_qty_base(_half_up(total_consumed, history_days))
            median_daily_consumption = format_qty_base(_median_half_up(series))
            if ing.lead_time_days is None:
                reason = "sin lead_time_days configurado para este insumo"
            else:
                suggested_min_base = _half_up(total_consumed * ing.lead_time_days, history_days)
                suggested_min = format_qty_base(suggested_min_base)
                based_on = f"{based_on} × lead_time_days ({ing.lead_time_days} días)"

        rows.append(
            ReplenishmentRowOut(
                ingredient_id=ing.id,
                ingredient_name=ing.name,
                base_unit=ing.base_unit.value,  # type: ignore[attr-defined]
                current_stock=format_qty_base(current),
                min_stock=format_qty_base(ing.min_stock),
                avg_daily_consumption=avg_daily_consumption,
                median_daily_consumption=median_daily_consumption,
                history_days=history_days,
                lead_time_days=ing.lead_time_days,
                suggested_qty=format_qty_base(suggested_qty_base),
                suggested_min=suggested_min,
                based_on=based_on,
                reason=reason,
            )
        )

    rows.sort(key=lambda r: r.ingredient_name)
    return ReplenishmentOut(
        store_id=store.id, available=True, reason=None, lookback_days=REPLENISHMENT_LOOKBACK_DAYS, rows=rows
    )
