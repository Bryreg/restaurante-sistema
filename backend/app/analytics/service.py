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
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.analytics.schemas import (
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
from app.core.errors import AppError, NotFoundError
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
from app.orders.models import Order, OrderItem, OrderItemStatus, OrderStatus
from app.orders.money import prorate
from app.stores.models import Store

# ---------------------------------------------------------------------------
# Compartido.
# ---------------------------------------------------------------------------

# Mismo criterio que `app.reports.service.SALE_DOCUMENT_TYPES` y
# `app.inventory.service._sale_document_types()`: documentos que representan
# una venta real cobrada. Redeclarado acá EN VEZ DE importar `app.reports`
# (territorio ajeno de este pedido, y un módulo que otro agente no está
# editando, pero cuyo import cruzado no aporta nada que `app.fiscal.models`
# no dé ya) — mismo patrón que `app.inventory.service` ya sigue por el mismo
# motivo ("no acoplar un dominio a un módulo que otro agente edita en
# paralelo en este mismo pedido").
def _sale_document_types() -> tuple[Any, ...]:
    from app.fiscal.models import FiscalDocumentType

    return (
        FiscalDocumentType.POS_EQUIVALENT,
        FiscalDocumentType.INVOICE,
        FiscalDocumentType.INTERNAL_RECEIPT,
    )


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


def _net_sales(db: Session, *, store_id: int, date_from: date, date_to: date) -> int:
    from app.fiscal.models import FiscalDocument

    stmt = select(func.coalesce(func.sum(FiscalDocument.total - FiscalDocument.tax_total), 0)).where(
        FiscalDocument.store_id == store_id,
        FiscalDocument.business_date >= date_from,
        FiscalDocument.business_date <= date_to,
        FiscalDocument.document_type.in_(_sale_document_types()),
        FiscalDocument.status == "issued",
    )
    return int(db.execute(stmt).scalar_one())


def _theoretical_cost_pesos(db: Session, *, store_id: int, date_from: date, date_to: date) -> int | None:
    """Costo TEÓRICO (congelado) de lo vendido en `[date_from, date_to]`,
    sobre comandas pagadas, ítems no anulados. Se acumula en MICROS a través
    de TODOS los ítems y se redondea a pesos una sola vez, al final —misma
    regla que protege el food cost teórico en `app.reports.service`. `None`
    cuando NINGÚN ítem vendido en el rango tenía costo congelado (nunca `0`
    mudo)."""
    stmt = (
        select(OrderItem.unit_cost_micros, OrderItem.qty)
        .join(Order, OrderItem.order_id == Order.id)
        .where(
            Order.store_id == store_id,
            Order.business_date >= date_from,
            Order.business_date <= date_to,
            Order.status == OrderStatus.PAID,
            OrderItem.status != OrderItemStatus.VOIDED,
        )
    )
    total_micros = 0
    any_costed = False
    for unit_cost_micros, qty in db.execute(stmt).all():
        if unit_cost_micros is None:
            continue
        any_costed = True
        total_micros += int(unit_cost_micros) * int(qty)
    if not any_costed:
        return None
    return micros_to_pesos(total_micros)


# ---------------------------------------------------------------------------
# GET /admin/menu-engineering
# ---------------------------------------------------------------------------

# Regla del 70 % (Kasavana–Smith): un plato es "popular" si su participación
# en las unidades vendidas es al menos el 70 % de la participación pareja
# ("si todos los platos vendieran igual"). En bp para no usar float.
_POPULARITY_RULE_NUM = 7
_POPULARITY_RULE_DEN = 10


@dataclass
class _ProductAgg:
    name: str = ""
    qty_sold: int = 0
    revenue_net: int = 0
    cost_micros: int = 0
    qty_costed: int = 0
    has_cost: bool = False


def menu_engineering(db: Session, *, store: Store, date_from: date, date_to: date) -> MenuEngineeringOut:
    _validate_range(date_from, date_to)

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
        return MenuEngineeringOut(
            store_id=store.id,
            date_from=date_from,
            date_to=date_to,
            available=False,
            reason="No hay ventas cobradas en el período",
            popularity_threshold_bp=None,
            avg_contribution_margin_per_unit=None,
            rows=[],
        )

    agg: dict[int, _ProductAgg] = {}
    for order in orders:
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
            row.revenue_net += base_by_item.get(item.id, 0)
            if item.unit_cost_micros is not None:
                row.has_cost = True
                row.cost_micros += int(item.unit_cost_micros) * item.qty
                row.qty_costed += item.qty

    if not agg:
        return MenuEngineeringOut(
            store_id=store.id,
            date_from=date_from,
            date_to=date_to,
            available=False,
            reason="No hay platos vendidos (con producto de carta) en el período",
            popularity_threshold_bp=None,
            avg_contribution_margin_per_unit=None,
            rows=[],
        )

    total_qty = sum(r.qty_sold for r in agg.values())
    n_products = len(agg)
    popularity_threshold_bp = (
        _POPULARITY_RULE_NUM * 10000 // (_POPULARITY_RULE_DEN * n_products)
    )

    # Margen de contribución promedio, PONDERADO por unidad vendida, sólo
    # entre los platos con costo (nunca se promedia con `None` como si fuera
    # cero — "el promedio de 'sin dato' no es cero").
    costed_margin_total = 0
    costed_qty_total = 0
    for row in agg.values():
        if row.has_cost:
            margin = row.revenue_net - micros_to_pesos(row.cost_micros)
            costed_margin_total += margin
            costed_qty_total += row.qty_sold
    avg_margin_per_unit = (
        _signed_half_up(costed_margin_total, costed_qty_total) if costed_qty_total > 0 else None
    )

    rows: list[MenuEngineeringRowOut] = []
    for product_id, row in agg.items():
        popularity_share_bp = _half_up(row.qty_sold * 10000, total_qty)
        theoretical_cost = micros_to_pesos(row.cost_micros) if row.has_cost else None
        contribution_margin = (row.revenue_net - theoretical_cost) if theoretical_cost is not None else None
        margin_pct_bp = (
            _signed_pct_bp(contribution_margin, row.revenue_net)
            if contribution_margin is not None and row.revenue_net > 0
            else None
        )
        costed_qty_pct_bp = _half_up(row.qty_costed * 10000, row.qty_sold) if row.qty_sold > 0 else None

        classification: MenuClassLiteral
        reason: str
        if contribution_margin is None or avg_margin_per_unit is None:
            classification = "unclassified"
            reason = "sin costo congelado suficiente para calcular margen en el período"
        else:
            popular = popularity_share_bp >= popularity_threshold_bp
            profitable = contribution_margin >= avg_margin_per_unit * row.qty_sold if row.qty_sold else False
            # Compara el margen TOTAL del plato contra lo que el promedio
            # por unidad hubiera dado con sus mismas unidades — equivalente
            # a comparar el margen unitario, sin dividir (evita crear otra
            # cantidad intermedia con redondeo).
            if popular and profitable:
                classification, reason = "star", "alta popularidad y margen sobre el promedio"
            elif popular and not profitable:
                classification, reason = "plowhorse", "alta popularidad, margen bajo el promedio"
            elif not popular and profitable:
                classification, reason = "puzzle", "baja popularidad, margen sobre el promedio"
            else:
                classification, reason = "dog", "baja popularidad y margen bajo el promedio"

        rows.append(
            MenuEngineeringRowOut(
                product_id=product_id,
                product_name=row.name,
                qty_sold=row.qty_sold,
                popularity_share_bp=popularity_share_bp,
                revenue_net=row.revenue_net,
                theoretical_cost=theoretical_cost,
                contribution_margin=contribution_margin,
                margin_pct_bp=margin_pct_bp,
                costed_qty_pct_bp=costed_qty_pct_bp,
                classification=classification,
                classification_reason=reason,
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


def _window_food_cost_gap_bp(db: Session, *, store: Store, opening: StockCount, closing: StockCount) -> _WindowGap | None:
    """Brecha de food cost (real − teórico, en puntos básicos) para la
    ventana `[opening, closing]` — la MISMA ventana que `app.inventory.
    service.food_cost_report` usa para el food cost real (entre dos conteos
    completos aplicados consecutivos), extendida acá con el food cost
    TEÓRICO de la misma ventana (que ninguna función publicada calcula
    todavía). `None` cuando la ventana no tiene ventas netas o ningún ítem
    con costo congelado — "no computable", nunca `0`."""
    net_sales = _net_sales(db, store_id=store.id, date_from=opening.business_date, date_to=closing.business_date)
    if net_sales <= 0:
        return None

    opening_value = _count_inventory_value(db, store=store, count=opening)
    closing_value = _count_inventory_value(db, store=store, count=closing)
    purchases_value = _purchases_value(db, store=store, window_from=opening.opened_at, window_to=closing.opened_at)
    real_cost = opening_value + purchases_value - closing_value
    real_pct_bp = _signed_pct_bp(real_cost, net_sales)

    theoretical_cost = _theoretical_cost_pesos(
        db, store_id=store.id, date_from=opening.business_date, date_to=closing.business_date
    )
    if theoretical_cost is None:
        return None
    theoretical_pct_bp = _signed_pct_bp(theoretical_cost, net_sales)

    return _WindowGap(
        gap_bp=real_pct_bp - theoretical_pct_bp, real_pct_bp=real_pct_bp, theoretical_pct_bp=theoretical_pct_bp
    )


def control_health_sustained(db: Session, *, store: Store) -> SustainedOut:
    """D-1: `sustained_red` es `True` cuando la brecha de food cost superó
    el umbral rojo en al menos 2 de las últimas 3 ventanas COMPUTABLES
    (con food cost real disponible) — nunca de "las últimas 3 que haya",
    ciegamente: una ventana sin ventas netas o sin costo congelado no se
    cuenta ni a favor ni en contra, se salta y se sigue buscando hacia atrás
    en el historial. Con menos de 2 ventanas computables: `None` con
    `reason`, nunca verde."""
    red_threshold_bp = _red_threshold_bp(db, store_id=store.id)
    counts = _applied_full_counts_desc(db, store_id=store.id)  # más reciente primero

    windows_out: list[SustainedWindowOut] = []
    exceed_count = 0
    for idx in range(len(counts) - 1):
        if len(windows_out) >= _SUSTAINED_WINDOWS_NEEDED:
            break
        closing, opening = counts[idx], counts[idx + 1]  # counts está en orden descendente
        gap = _window_food_cost_gap_bp(db, store=store, opening=opening, closing=closing)
        if gap is None:
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
            )
        )

    if len(windows_out) < _SUSTAINED_MIN_WINDOWS:
        return SustainedOut(
            store_id=store.id,
            sustained_red=None,
            windows_evaluated=len(windows_out),
            reason="sin historial suficiente: hacen falta al menos dos conteos completos aplicados",
            red_threshold_bp=red_threshold_bp,
            windows=windows_out,
        )

    return SustainedOut(
        store_id=store.id,
        sustained_red=exceed_count >= _SUSTAINED_RED_HITS_REQUIRED,
        windows_evaluated=len(windows_out),
        reason=None,
        red_threshold_bp=red_threshold_bp,
        windows=windows_out,
    )


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
        rows.append(_IngredientVarianceRow(ingredient_id=ing_id, variance_qty=variance_qty, variance_value=variance_value))
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
    grand_total_weight = 0
    per_product_grand_weight: dict[int, int] = {}

    for irow in ingredient_rows:
        if irow.variance_value is None:
            continue  # sin costo resuelto: no hay con qué valorar en pesos, se omite del reparto (declarado)
        total_variance_value += irow.variance_value
        weights = _dish_consumption_weights(
            db, store_id=store.id, ingredient_id=irow.ingredient_id, window_from=opening.opened_at, window_to=count.opened_at
        )
        if not weights:
            unattributed += irow.variance_value
            continue
        product_ids = sorted(weights.keys())
        shares = prorate(abs(irow.variance_value), [weights[pid] for pid in product_ids])
        sign = -1 if irow.variance_value < 0 else 1
        for pid, share, w in zip(product_ids, shares, [weights[pid] for pid in product_ids]):
            per_product_value[pid] = per_product_value.get(pid, 0) + sign * share
            per_product_ingredient_count[pid] = per_product_ingredient_count.get(pid, 0) + 1
            per_product_grand_weight[pid] = per_product_grand_weight.get(pid, 0) + w
            grand_total_weight += w

    rows: list[VarianceByDishRowOut] = []
    for pid, value in sorted(per_product_value.items(), key=lambda kv: -abs(kv[1])):
        share_bp = _half_up(per_product_grand_weight.get(pid, 0) * 10000, grand_total_weight) if grand_total_weight else 0
        rows.append(
            VarianceByDishRowOut(
                product_id=pid,
                product_name=product_names.get(pid, f"Producto #{pid}"),
                theoretical_consumption_share_bp=share_bp,
                variance_value=value,
                ingredients_involved=per_product_ingredient_count.get(pid, 0),
            )
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


def replenishment(db: Session, *, store: Store) -> ReplenishmentOut:
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
    since_date = today - timedelta(days=REPLENISHMENT_LOOKBACK_DAYS)

    rows: list[ReplenishmentRowOut] = []
    for ing in ingredients:
        current = inventory_hooks.current_stock(db, store_id=store.id, ingredient_id=ing.id)
        suggested_qty_base = max(0, ing.min_stock - current)

        if ing.consumption_untracked:
            rows.append(
                ReplenishmentRowOut(
                    ingredient_id=ing.id,
                    ingredient_name=ing.name,
                    base_unit=ing.base_unit.value,  # type: ignore[attr-defined]
                    current_stock=format_qty_base(current),
                    min_stock=format_qty_base(ing.min_stock),
                    avg_daily_consumption=None,
                    lead_time_days=ing.lead_time_days,
                    suggested_qty=format_qty_base(suggested_qty_base),
                    suggested_min=None,
                    based_on=f"consumo de los últimos {REPLENISHMENT_LOOKBACK_DAYS} días",
                    reason="insumo marcado como consumo no medido automáticamente (consumption_untracked)",
                )
            )
            continue

        consumed_negative = _movement_sum_by_business_date(
            db, store_id=store.id, ingredient_id=ing.id, date_from=since_date, date_to=today,
            positive=False, causes=_CONSUMPTION_CAUSES,
        )
        total_consumed = -consumed_negative if consumed_negative < 0 else 0

        avg_daily_consumption: str | None = None
        suggested_min: str | None = None
        reason: str | None = None
        based_on = f"consumo de los últimos {REPLENISHMENT_LOOKBACK_DAYS} días"

        if total_consumed <= 0:
            reason = f"sin consumo registrado en los últimos {REPLENISHMENT_LOOKBACK_DAYS} días"
        else:
            avg_daily_consumption = format_qty_base(_half_up(total_consumed, REPLENISHMENT_LOOKBACK_DAYS))
            if ing.lead_time_days is None:
                reason = "sin lead_time_days configurado para este insumo"
            else:
                suggested_min_base = _half_up(total_consumed * ing.lead_time_days, REPLENISHMENT_LOOKBACK_DAYS)
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


def _movement_sum_by_business_date(
    db: Session,
    *,
    store_id: int,
    ingredient_id: int,
    date_from: date,
    date_to: date,
    positive: bool,
    causes: tuple[MovementCause, ...] | None = None,
) -> int:
    """Igual que `_movement_sum`, pero acotado por FECHA DE NEGOCIO (columna
    propia, nunca derivada de `at`) en vez de instante UTC — correcto para
    "los últimos N días de negocio", que es lo que pide reposición (una
    ventana operativa, no un instante puntual como la de un conteo)."""
    stmt = select(func.coalesce(func.sum(StockMovement.qty_base), 0)).where(
        StockMovement.store_id == store_id,
        StockMovement.ingredient_id == ingredient_id,
        StockMovement.business_date >= date_from,
        StockMovement.business_date <= date_to,
    )
    if causes is not None:
        stmt = stmt.where(StockMovement.cause.in_(causes))
    stmt = stmt.where(StockMovement.qty_base > 0 if positive else StockMovement.qty_base < 0)
    return int(db.execute(stmt).scalar_one())
