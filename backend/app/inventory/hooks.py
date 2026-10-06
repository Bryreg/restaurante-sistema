"""Contrato publicado de `inventory` (`features/fase-2-costo-inventario/spec.md`):
lo que otros dominios (`recipes`, `orders`, y desde 2b `purchases`) llaman
tal cual, sin reimplementar nada de esto. **`record_movement` es la única
escritura de inventario del sistema entero** — ni siquiera otro archivo de
este mismo dominio hace `db.add(StockMovement(...))` fuera de acá; lo mismo
rige para `StockBatch`: sólo `create_stock_batch`/`reverse_stock_batch`/
`consume_lots_fefo` la tocan.

Firmas vinculantes (no se renombran ni se reordenan los parámetros):

    record_movement(db, *, organization_id, store_id, ingredient_id=None,
                     preparation_id=None, qty_base, cause, cost_micros,
                     cost_source, actor, business_date, at,
                     ref_type=None, ref_id=None, note=None) -> StockMovement

    resolve_ingredient_cost(db, ingredient) -> tuple[int | None, CostSource]
    current_stock(db, *, store_id, ingredient_id=None, preparation_id=None,
                  as_of=None) -> int
    get_ingredient(db, *, store_id, ingredient_id) -> Ingredient | None
    low_stock_alerts(db, *, store_id) -> list[dict]
    negative_stock_alerts(db, *, store_id) -> list[dict]
    resolve_consumption_target(db, ingredient, qty_base) -> list[tuple[Ingredient, int]]

Contrato NUEVO del pedido 2b (§ "CONTRATO VINCULANTE que PUBLICÁS"; otro
agente —`purchases`— ya programa contra estas firmas):

    create_stock_batch(db, *, organization_id, store_id, ingredient_id, qty_base,
                        unit_cost_micros, cost_source, lot_code=None, expires_at=None,
                        received_at, business_date, source_type, source_id) -> StockBatch
    reverse_stock_batch(db, *, batch_id) -> None   # AppError("LOT_CONSUMED", status=409) si ya se consumió en parte
    consume_lots_fefo(db, *, store_id, ingredient_id, qty_base) -> list[tuple[StockBatch, int]]
    weighted_average_cost_micros(db, *, store_id, ingredient_id) -> int | None
    last_purchase_cost_micros(db, *, store_id, ingredient_id) -> int | None
    last_applied_full_count_at(db, *, store_id) -> datetime | None

Contrato nuevo de la RONDA 2 (hallazgo H-4: una sola matemática para "cuántos
días sin conteo completo" -- antes vivía duplicada, con el mismo `14` escrito
dos veces, en `service.control_health` y `service.food_cost_report`):

    inventory_staleness(db, *, store_id, cutoff_hour) -> InventoryStaleness

`InventoryStaleness` es un `dataclass` congelado con `days_since_last_full_
count: int | None`, `unreliable: bool` y `stale_days: int`.
`app.inventory.service.control_health` y `app.inventory.service.
food_cost_report` LEEN esta función, no recalculan; `app.reports` (territorio
ajeno) también la va a consumir para `GET /admin/today` -- si esta firma
cambia alguna vez, avisar en el entregable, es contrato publicado.

Además, una lectura auxiliar (no vinculante, pero publicada para que
`app.reports` —territorio ajeno— arme `GET /admin/today` sin reimplementar
el cálculo, mismo patrón que `low_stock_alerts`/`negative_stock_alerts`):

    expiring_or_expired_lots(db, *, store_id, today) -> list[dict]

Rutina del turno (2026-09-25), dos lecturas nuevas:

    explained_outflow_qty(db, *, store_id, ingredient_id, window_from, window_to) -> int
    pending_incoming_transfers(db, *, store_id) -> int

La primera es lo que salió EXPLICADO de un insumo en la ventana `(from, to]`
(consumo interno y traslados, `EXPLAINED_WASTE_TYPES`): la varianza lo
descuenta del uso real para que no aparezca como faltante —
`app.inventory.service.variance_report` y su espejo de `app.analytics` leen
esta función, ninguno filtra tipos de merma por su cuenta. La segunda cuenta
los traslados que llegan a la sede y nadie recibió (para la bandeja de Hoy).

(La salud del control completa, para `GET /admin/control-health`, vive en
`app.inventory.service.control_health` — no en `hooks`, porque cruza a
`app.purchases`/`app.recipes` con `find_spec_safe` y eso es orquestación de
service, no un contrato de lectura de bajo nivel.)
"""

from __future__ import annotations

from collections import Counter
from typing import TYPE_CHECKING
from dataclasses import dataclass
from datetime import date, datetime

import sqlalchemy as sa
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.deps import Actor
from app.core import clock, tz
from app.core.errors import AppError, NotFoundError
from app.core.quantity import line_cost_micros, micros_to_pesos
from app.inventory.models import (
    CostSource,
    Ingredient,
    MovementCause,
    StockBatch,
    StockCount,
    StockCountLine,
    StockCountScope,
    StockCountStatus,
    StockMovement,
    StoreInventorySettings,
    Waste,
    WasteType,
    EXPLAINED_WASTE_TYPES,
)

if TYPE_CHECKING:
    from app.inventory.area_counts import AreaCountsToday
    from app.stores.models import Store


def record_movement(
    db: Session,
    *,
    organization_id: int,
    store_id: int,
    ingredient_id: int | None = None,
    preparation_id: int | None = None,
    qty_base: int,
    cause: MovementCause,
    cost_micros: int | None,
    cost_source: CostSource,
    actor: Actor,
    business_date: date,
    at: datetime,
    ref_type: str | None = None,
    ref_id: int | None = None,
    note: str | None = None,
) -> StockMovement:
    """LA única escritura de inventario. Nadie hace `db.add(StockMovement(...))`
    fuera de acá — ni siquiera este dominio.

    - Insumo **o** preparación, exactamente uno (mismo `CheckConstraint` de la
      tabla; acá se valida antes de escribir porque `get_db` comitea también
      ante un `AppError` — validar antes de escribir es la única manera de
      que una validación fallida no deje basura).
    - `qty_base` nunca `0`; negativo = salida, positivo = entrada.
    - `cause` es SIEMPRE el enum — nunca se infiere de `note`, que es texto
      libre para un humano, no una fuente de verdad.
    - `cost_micros`/`cost_source` viajan siempre juntos: sin costo es
      `(None, CostSource.NONE)`, nunca `(0, ...)`.
    - **No bloquea por stock**: vender con stock en cero o negativo no es un
      error de esta función (SPEC-NEGOCIO §5.2); el negativo es deuda de
      registro, no una regla que cortar acá.
    - **Fusión**: si `ref_type`/`ref_id` vienen los dos, y ya existe un
      movimiento con el mismo `(organization_id, store_id, ingredient_id o
      preparation_id, cause, ref_type, ref_id)`, esta llamada se fusiona en
      esa fila (`qty_base` se suma) en vez de crear una fila nueva —
      "consumos del mismo insumo en una comanda se fusionan en un
      movimiento" (SPEC-NEGOCIO §5.3) sin que cada llamador tenga que
      pre-agregar por su cuenta.
    - **FEFO adentro, no en cada llamador** (decisión de arquitectura #3 del
      pedido 2b): si `qty_base < 0`, hay `ingredient_id` y
      `inventory.lots` está encendida para la sede, esta función descuenta
      de los lotes vía `consume_lots_fefo` con el `qty_base` de ESTA
      llamada (el delta, no el acumulado de la fila fusionada) — así las
      salidas que YA existen (venta al enviar, merma, producción, ajuste)
      consumen lotes sin que `app/orders/**` ni `app/recipes/**` tengan que
      llamar nada nuevo. **Excepción declarada**: `cause=RECEPTION_REVERSAL`
      NUNCA dispara FEFO acá — quien revierte una recepción ya vació el lote
      exacto con `reverse_stock_batch` antes de escribir este movimiento;
      si FEFO corriera de nuevo acá, consumiría de un lote *distinto* (el
      que hoy esté más próximo a vencer), dejando la contabilidad de lotes
      inconsistente con la de la recepción que se está anulando. FEFO no
      bloquea por falta de stock en los lotes (igual que esta función nunca
      bloquea por stock): si no alcanza, se consume lo que haya y el resto
      quede sin lote asociado — es exactamente el mismo "no bloquea"
      documentado más abajo.
    """
    if (ingredient_id is None) == (preparation_id is None):
        raise AppError(
            code="VALIDATION_ERROR",
            message="record_movement: indicá exactamente un insumo o una preparación, nunca los dos ni ninguno",
        )
    if qty_base == 0:
        raise AppError(code="VALIDATION_ERROR", message="qty_base: un movimiento no puede ser de cantidad cero")
    if (cost_micros is None) != (cost_source is CostSource.NONE):
        raise AppError(
            code="VALIDATION_ERROR",
            message="cost_source tiene que ser 'none' si y sólo si no hay cost_micros",
        )
    if actor.employee_id is None or not actor.employee_name:
        raise AppError(
            code="VALIDATION_ERROR",
            message="No hay una persona identificada para atribuir el movimiento de inventario",
        )

    existing: StockMovement | None = None
    if ref_type is not None and ref_id is not None:
        stmt = select(StockMovement).where(
            StockMovement.organization_id == organization_id,
            StockMovement.store_id == store_id,
            StockMovement.cause == cause,
            StockMovement.ref_type == ref_type,
            StockMovement.ref_id == ref_id,
        )
        stmt = stmt.where(
            StockMovement.ingredient_id == ingredient_id
            if ingredient_id is not None
            else StockMovement.preparation_id == preparation_id
        )
        existing = db.execute(stmt).scalars().first()

    if existing is not None:
        existing.qty_base = existing.qty_base + qty_base
        existing.cost_micros = cost_micros
        existing.cost_source = cost_source
        existing.at = at
        existing.business_date = business_date
        if note is not None:
            existing.note = note
        db.flush()
        _maybe_consume_fefo(
            db,
            organization_id=organization_id,
            store_id=store_id,
            ingredient_id=ingredient_id,
            qty_base=qty_base,
            cause=cause,
        )
        if ingredient_id is not None:
            evaluate_stock_alerts(db, organization_id=organization_id, store_id=store_id, ingredient_id=ingredient_id)
        return existing

    movement = StockMovement(
        organization_id=organization_id,
        store_id=store_id,
        ingredient_id=ingredient_id,
        preparation_id=preparation_id,
        qty_base=qty_base,
        cause=cause,
        cost_micros=cost_micros,
        cost_source=cost_source,
        employee_id=actor.employee_id,
        employee_name=actor.employee_name,
        at=at,
        business_date=business_date,
        ref_type=ref_type,
        ref_id=ref_id,
        note=note,
    )
    db.add(movement)
    db.flush()
    _maybe_consume_fefo(
        db,
        organization_id=organization_id,
        store_id=store_id,
        ingredient_id=ingredient_id,
        qty_base=qty_base,
        cause=cause,
    )
    if ingredient_id is not None:
        evaluate_stock_alerts(db, organization_id=organization_id, store_id=store_id, ingredient_id=ingredient_id)
    return movement


# Causas cuyo efecto sobre los lotes ya lo maneja explícitamente quien las
# produce, así que `record_movement` NO dispara FEFO para ellas (ver el
# docstring de `record_movement` arriba: `RECEPTION_REVERSAL` es el caso
# declarado — `reverse_stock_batch` ya vació el lote exacto).
_FEFO_EXCLUDED_CAUSES = frozenset({MovementCause.RECEPTION_REVERSAL})


def _maybe_consume_fefo(
    db: Session,
    *,
    organization_id: int,
    store_id: int,
    ingredient_id: int | None,
    qty_base: int,
    cause: MovementCause,
) -> None:
    """El gancho de FEFO dentro de `record_movement` (decisión de
    arquitectura #3, ver docstring de `record_movement`). Import local de
    `app.core.features` para mantener a `hooks.py` sin una dependencia de
    import a nivel de módulo hacia `app.core.features` (que a su vez importa
    `app.stores.models`) — mismo estilo defensivo que el resto del archivo,
    aunque acá no hay ciclo real: es sólo para que quede claro que esta es
    la ÚNICA razón por la que `inventory.hooks` conoce `features`."""
    if qty_base >= 0 or ingredient_id is None or cause in _FEFO_EXCLUDED_CAUSES:
        return
    from app.core import features

    if not features.is_enabled(db, organization_id, store_id, "inventory.lots"):
        return
    consume_lots_fefo(db, store_id=store_id, ingredient_id=ingredient_id, qty_base=-qty_base)


def _qty_text(ingredient: Ingredient, qty_base: int) -> str:
    """«-0,4 kg», «12 unidad»: la cantidad del libro en la unidad cómoda del
    insumo (`units.entry_spec`, la misma del conteo), para el texto del aviso."""
    from app.core.quantity import format_qty_base
    from app.inventory.units import base_to_entry_milli, entry_spec

    milli = base_to_entry_milli(ingredient, qty_base)
    return f"{format_qty_base(milli).replace('.', ',')} {entry_spec(ingredient).unit}"


def evaluate_stock_alerts(db: Session, *, organization_id: int, store_id: int, ingredient_id: int) -> None:
    """El motor de las reglas `ingredient_below_min` e `ingredient_negative`
    (declaradas en `app.notifications.service.NOTIFICATION_TYPES` desde 2a,
    configurables en Notificaciones, y que hasta acá nadie evaluaba).

    Corre después de cada movimiento de un insumo (`record_movement`) y
    cuando cambia su mínimo o se activa/desactiva (`app.inventory.service.
    update_ingredient`/`deactivate_ingredient`). Usa LAS MISMAS condiciones
    que las tarjetas de Hoy (`low_stock_alerts`: saldo < mínimo;
    `negative_stock_alerts`: saldo < 0), así el aviso de la campana y la
    tarjeta no pueden decir cosas distintas. Son alertas distintas: un
    insumo en negativo también está bajo el mínimo, y salen las dos.

    - **Sin spam**: un aviso por insumo mientras la condición siga
      (`dedupe_while_open`): vender diez veces un insumo bajo el mínimo no
      repite el aviso ni cada día.
    - **Se resuelve solo** cuando el insumo se recupera (o se desactiva): el
      aviso sale de «Requiere tu atención» firmado por «Sistema». Si vuelve a
      caer, sale uno nuevo.
    - Con `inventory.perpetual` apagada no hace nada: no hay inventario que
      vigilar (mismo criterio que `app.reports.service._hooks_if_enabled`).
    - La regla apagada en Notificaciones no emite, pero lo abierto igual se
      resuelve cuando la condición se apaga.
    """
    from app.core import features
    from app.notifications import service as notifications

    if not features.is_enabled(db, organization_id, store_id, "inventory.perpetual"):
        return
    ingredient = get_ingredient(db, store_id=store_id, ingredient_id=ingredient_id)
    if ingredient is None:
        return
    qty = current_stock(db, store_id=store_id, ingredient_id=ingredient_id)
    below_key = f"ingredient_below_min:{ingredient_id}"
    negative_key = f"ingredient_negative:{ingredient_id}"
    below = ingredient.active and qty < ingredient.min_stock
    negative = ingredient.active and qty < 0

    if below:
        notifications.notify(
            db,
            organization_id=organization_id,
            store_id=store_id,
            type="ingredient_below_min",
            level=notifications.default_level("ingredient_below_min"),
            title="Insumo bajo el mínimo",
            body=(
                f'"{ingredient.name}" quedó en {_qty_text(ingredient, qty)}, por debajo de su mínimo de '
                f"{_qty_text(ingredient, ingredient.min_stock)}: hay que reponer."
            ),
            payload={"ingredient_id": ingredient.id, "qty_base": qty, "min_stock": ingredient.min_stock},
            dedupe_key=below_key,
            dedupe_while_open=True,
        )
    else:
        notifications.resolve_open(db, store_id=store_id, type="ingredient_below_min", dedupe_key=below_key)

    if negative:
        notifications.notify(
            db,
            organization_id=organization_id,
            store_id=store_id,
            type="ingredient_negative",
            level=notifications.default_level("ingredient_negative"),
            title="Insumo en negativo",
            body=(
                f'"{ingredient.name}" quedó en {_qty_text(ingredient, qty)}: se descontó más de lo que había. '
                "Falta registrar una compra o hay un error de receta."
            ),
            payload={"ingredient_id": ingredient.id, "qty_base": qty},
            dedupe_key=negative_key,
            dedupe_while_open=True,
        )
    else:
        notifications.resolve_open(db, store_id=store_id, type="ingredient_negative", dedupe_key=negative_key)


def resolve_ingredient_cost(db: Session, ingredient: Ingredient) -> tuple[int | None, CostSource]:
    """Jerarquía de costo COMPLETA (SPEC-NEGOCIO §4.1), cinco escalones:

        official -> weighted_average -> last_purchase -> estimated -> none

    En 2a sólo estaban `official` y `estimated` (nunca había compras que
    alimentaran los otros dos). 2b agrega los dos del medio, en este orden
    exacto: con costo oficial puesto, el promedio NO manda (el oficial lo
    fija el dueño y pisa cualquier derivado); sin oficial, manda el promedio
    ponderado de las compras desde el último conteo completo aplicado
    (`weighted_average_cost_micros`); si no hay compras desde ese conteo
    (o nunca hubo conteo, pero tampoco compras), manda la última compra
    (`last_purchase_cost_micros`, sin el corte del conteo — es el respaldo
    de "algo es mejor que nada" cuando el promedio reciente no tiene con
    qué calcularse); si tampoco hay compras nunca, `estimated`; sin nada,
    `null` con origen `none` — **nunca `0`**."""
    if ingredient.official_cost_micros is not None:
        return ingredient.official_cost_micros, CostSource.OFFICIAL

    weighted_average = weighted_average_cost_micros(
        db, store_id=ingredient.store_id, ingredient_id=ingredient.id
    )
    if weighted_average is not None:
        return weighted_average, CostSource.WEIGHTED_AVERAGE

    last_purchase = last_purchase_cost_micros(db, store_id=ingredient.store_id, ingredient_id=ingredient.id)
    if last_purchase is not None:
        return last_purchase, CostSource.LAST_PURCHASE

    if ingredient.estimated_cost_micros is not None:
        return ingredient.estimated_cost_micros, CostSource.ESTIMATED
    return None, CostSource.NONE


def current_stock(
    db: Session,
    *,
    store_id: int,
    ingredient_id: int | None = None,
    preparation_id: int | None = None,
    as_of: datetime | None = None,
) -> int:
    """Stock teórico = Σ `qty_base` de todos los movimientos (el libro es
    append-only: nunca hay que "restar lo borrado"). Puede ser negativo — eso
    no es un error de esta función, es exactamente lo que SPEC-NEGOCIO §5.2
    pide poder representar.

    `as_of` (nuevo en 2b, kwarg agregado al final — no rompe ningún llamador
    de 2a) acota la suma a movimientos con `at <= as_of`: es "el stock según
    el libro EN ESE INSTANTE", la pieza que hace que
    `app.inventory.service.apply_count` no invente un faltante con los
    movimientos que pasaron entre el instante del conteo y el instante de
    aplicarlo (ver docstring de `apply_count`)."""
    if (ingredient_id is None) == (preparation_id is None):
        raise AppError(
            code="VALIDATION_ERROR",
            message="current_stock: indicá exactamente un insumo o una preparación",
        )
    stmt = select(func.coalesce(func.sum(StockMovement.qty_base), 0)).where(
        StockMovement.store_id == store_id
    )
    stmt = stmt.where(
        StockMovement.ingredient_id == ingredient_id
        if ingredient_id is not None
        else StockMovement.preparation_id == preparation_id
    )
    if as_of is not None:
        stmt = stmt.where(StockMovement.at <= as_of)
    return int(db.execute(stmt).scalar_one())


def get_ingredient(db: Session, *, store_id: int, ingredient_id: int) -> Ingredient | None:
    stmt = select(Ingredient).where(Ingredient.id == ingredient_id, Ingredient.store_id == store_id)
    return db.execute(stmt).scalar_one_or_none()


def low_stock_alerts(db: Session, *, store_id: int) -> list[dict]:
    """Insumos activos por debajo de su `min_stock` (SPEC-NEGOCIO §4.1/§5.2).
    Distinta función y distinta forma que `negative_stock_alerts`: "bajo
    mínimo" y "negativo" son alertas diferentes con causas diferentes, nunca
    la misma pregunta hecha dos veces."""
    ingredients = (
        db.execute(select(Ingredient).where(Ingredient.store_id == store_id, Ingredient.active.is_(True)))
        .scalars()
        .all()
    )
    alerts: list[dict] = []
    for ingredient in ingredients:
        qty = current_stock(db, store_id=store_id, ingredient_id=ingredient.id)
        if qty < ingredient.min_stock:
            alerts.append(
                {
                    "ingredient_id": ingredient.id,
                    "name": ingredient.name,
                    "qty_base": qty,
                    "min_stock": ingredient.min_stock,
                    "base_unit": ingredient.base_unit.value,
                }
            )
    return alerts


def _negative_streak(
    db: Session, *, store_id: int, ingredient_id: int
) -> tuple[datetime | None, str | None]:
    """Desde cuándo el saldo está en su racha negativa actual, y qué causa
    concentra más cantidad de salida dentro de esa racha (SPEC-NEGOCIO §5.2:
    "la causa probable del negativo se deriva de las causas de sus
    movimientos, no de un texto libre"). Si el saldo se recuperó a >= 0 en
    algún punto, la racha se reinicia desde ahí — `negative_since` es
    siempre desde la última vez que cruzó a negativo, no la primera vez en
    la historia del insumo."""
    movements = (
        db.execute(
            select(StockMovement)
            .where(StockMovement.store_id == store_id, StockMovement.ingredient_id == ingredient_id)
            .order_by(StockMovement.at, StockMovement.id)
        )
        .scalars()
        .all()
    )
    running = 0
    since: datetime | None = None
    causes_in_streak: Counter[str] = Counter()
    for movement in movements:
        previous = running
        running += movement.qty_base
        if previous >= 0 and running < 0:
            since = movement.at
            causes_in_streak = Counter()
        if running < 0 and movement.qty_base < 0:
            causes_in_streak[movement.cause.value] += -movement.qty_base
        if running >= 0:
            since = None
            causes_in_streak = Counter()
    probable_cause = causes_in_streak.most_common(1)[0][0] if causes_in_streak else None
    return since, probable_cause


def negative_stock_alerts(db: Session, *, store_id: int) -> list[dict]:
    """Insumos activos con stock teórico negativo (SPEC-NEGOCIO §5.2).
    **Negativo no es agotado**: son alertas distintas, con mensajes
    distintos, porque la causa probable es otra (un insumo en cero por venta
    normal no es lo mismo que un insumo que lleva tres meses en -400 g
    porque tres recetas lo descuentan y nadie lo compra)."""
    ingredients = (
        db.execute(select(Ingredient).where(Ingredient.store_id == store_id, Ingredient.active.is_(True)))
        .scalars()
        .all()
    )
    alerts: list[dict] = []
    for ingredient in ingredients:
        qty = current_stock(db, store_id=store_id, ingredient_id=ingredient.id)
        if qty < 0:
            negative_since, probable_cause = _negative_streak(db, store_id=store_id, ingredient_id=ingredient.id)
            alerts.append(
                {
                    "ingredient_id": ingredient.id,
                    "name": ingredient.name,
                    "qty_base": qty,
                    "min_stock": ingredient.min_stock,
                    "base_unit": ingredient.base_unit.value,
                    "negative_since": negative_since.isoformat() if negative_since else None,
                    "probable_cause": probable_cause,
                }
            )
    return alerts


def resolve_consumption_target(
    db: Session, ingredient: Ingredient, qty_base: int
) -> list[tuple[Ingredient, int]]:
    """Un solo camino de consumo con cascada al sustituto (SPEC-NEGOCIO
    §4.1). Venta, cortesía, `staff_meal` y producción llaman esta MISMA
    función — nunca cada uno decide por su cuenta cuál insumo descontar, que
    es exactamente el bug de la referencia (leche entera en -4 y
    deslactosada en +19, porque dos caminos independientes cada uno
    "resolvía" el sustituto a su manera).

    Reparte `qty_base` entre el insumo y su cadena de sustitutos: toma de
    cada insumo hasta su stock disponible (nunca negativo) antes de caer al
    siguiente. Lo que sobra al final de la cadena (sin más sustituto, o un
    ciclo detectado) se apila en el último insumo de la cadena, que sí puede
    quedar negativo — vender no bloquea (SPEC-NEGOCIO §5.2): la cantidad
    total consumida jamás se pierde, siempre queda en alguna fila.

    Devuelve pares `(insumo, cantidad)` cuya suma de cantidades es siempre
    exactamente `qty_base` (o lista vacía si `qty_base <= 0`).
    """
    if qty_base <= 0:
        return []

    chain: list[tuple[Ingredient, int]] = []
    current: Ingredient | None = ingredient
    remaining = qty_base
    visited: set[int] = set()

    while current is not None and current.id not in visited and remaining > 0:
        visited.add(current.id)
        if current.substitute_ingredient_id is None:
            chain.append((current, remaining))
            remaining = 0
            break

        available = current_stock(db, store_id=current.store_id, ingredient_id=current.id)
        take = max(0, min(remaining, available))
        if take > 0:
            chain.append((current, take))
            remaining -= take
        if remaining <= 0:
            break
        current = get_ingredient(
            db, store_id=current.store_id, ingredient_id=current.substitute_ingredient_id
        )

    if remaining > 0:
        if chain:
            last_ingredient, last_qty = chain[-1]
            chain[-1] = (last_ingredient, last_qty + remaining)
        else:
            chain.append((ingredient, remaining))

    return chain


# ---------------------------------------------------------------------------
# Lotes de compra (SPEC-NEGOCIO §5.7; pedido 2b, contrato vinculante).
# ---------------------------------------------------------------------------


def create_stock_batch(
    db: Session,
    *,
    organization_id: int,
    store_id: int,
    ingredient_id: int,
    qty_base: int,
    unit_cost_micros: int,
    cost_source: CostSource,
    lot_code: str | None = None,
    expires_at: date | None = None,
    received_at: datetime,
    business_date: date,
    source_type: str,
    source_id: int,
) -> StockBatch:
    """La única escritura de `StockBatch` (mismo principio que
    `record_movement` para `StockMovement`). Crea un lote con
    `qty_remaining = qty_base` (nace intacto). **No** escribe nada al libro
    de movimientos: quien llama (`app.purchases`, al confirmar una
    recepción) llama esto Y `record_movement(cause=PURCHASE, ...)` por
    separado, en la MISMA transacción — son dos libros distintos con
    propósitos distintos (el saldo agregado vs. la trazabilidad por lote), no
    dos escrituras del mismo hecho compitiendo entre sí."""
    if qty_base <= 0:
        raise AppError(
            code="VALIDATION_ERROR", message="qty_base: la cantidad recibida en el lote tiene que ser mayor a cero"
        )
    if unit_cost_micros < 0:
        raise AppError(code="VALIDATION_ERROR", message="unit_cost_micros: el costo de un lote no puede ser negativo")
    batch = StockBatch(
        organization_id=organization_id,
        store_id=store_id,
        ingredient_id=ingredient_id,
        qty_received=qty_base,
        qty_remaining=qty_base,
        unit_cost_micros=unit_cost_micros,
        cost_source=cost_source,
        lot_code=lot_code,
        expires_at=expires_at,
        received_at=received_at,
        business_date=business_date,
        source_type=source_type,
        source_id=source_id,
        reversed_at=None,
    )
    db.add(batch)
    db.flush()
    return batch


def reverse_stock_batch(db: Session, *, batch_id: int) -> None:
    """Revierte un lote (SPEC-NEGOCIO §5.6: "eliminar una recepción es una
    reversa con causa, no un `DELETE` de filas"). Vacía `qty_remaining` a `0`
    y marca `reversed_at` — el lote sigue ahí para auditoría, sólo que deja
    de contar en FEFO, en el promedio ponderado, en "última compra" y en
    `GET /admin/lots`.

    `409 LOT_CONSUMED` si el lote ya se consumió, aunque sea en parte
    (`qty_remaining != qty_received`): revertir una recepción cuyo lote ya
    alimentó una venta, una merma o una producción dejaría esa salida
    apuntando a nada, y esta función no puede "desconsumir" un movimiento ya
    escrito en el libro (eso violaría que el libro es append-only). Quien
    llama tiene que resolver esa venta/merma/producción primero —
    `app.purchases`, al construir `DELETE /admin/receptions/{id}`, decide
    qué mensaje darle al administrador en ese caso.

    Idempotente: revertir un lote YA revertido no hace nada (ni vuelve a
    validar `qty_remaining`, que después de la primera reversa siempre da
    `0` y dispararía `LOT_CONSUMED` sin ser realmente un conflicto nuevo)."""
    batch = db.get(StockBatch, batch_id)
    if batch is None:
        raise NotFoundError("El lote no existe")
    if batch.reversed_at is not None:
        return
    if batch.qty_remaining != batch.qty_received:
        raise AppError(
            code="LOT_CONSUMED",
            message="Este lote ya se consumió, al menos en parte; no se puede revertir la recepción que lo creó",
            status=409,
        )
    batch.qty_remaining = 0
    batch.reversed_at = clock.now_utc()
    db.flush()


def consume_lots_fefo(db: Session, *, store_id: int, ingredient_id: int, qty_base: int) -> list[tuple[StockBatch, int]]:
    """FEFO **declarado**, por escrito (SPEC-NEGOCIO §5.7 dice "el más
    antiguo", que es ambiguo entre fecha de recepción y de vencimiento — acá
    se resuelve la ambigüedad, porque una elección silenciosa mueve plata):

        1. El lote MÁS PRÓXIMO A VENCER primero (`expires_at` ascendente).
        2. A igualdad de vencimiento, el RECIBIDO PRIMERO (`received_at`
           ascendente, y `id` ascendente como desempate final y determinístico).
        3. Un lote SIN vencimiento (`expires_at IS NULL`) nunca vence: se
           ordena AL FINAL (después de todos los que sí tienen fecha), nunca
           al principio — si fuera al principio, un insumo no perecedero se
           consumiría antes que uno a punto de vencer, que es exactamente lo
           que FEFO existe para evitar.

    Sólo mira lotes vigentes (`reversed_at IS NULL`) con `qty_remaining > 0`
    de ESE insumo en ESA sede. Consume hasta `qty_base` (positivo: la
    cantidad a descontar) repartiendo entre lotes en el orden de arriba;
    **no bloquea** si no alcanza — consume lo que haya y devuelve sólo los
    lotes efectivamente tocados. Devuelve pares `(lote, cantidad_tomada)`.
    `qty_base <= 0` devuelve `[]` sin tocar nada (mismo contrato que
    `resolve_consumption_target`)."""
    if qty_base <= 0:
        return []

    stmt = (
        select(StockBatch)
        .where(
            StockBatch.store_id == store_id,
            StockBatch.ingredient_id == ingredient_id,
            StockBatch.reversed_at.is_(None),
            StockBatch.qty_remaining > 0,
        )
        .order_by(
            sa.case((StockBatch.expires_at.is_(None), 1), else_=0),
            StockBatch.expires_at.asc(),
            StockBatch.received_at.asc(),
            StockBatch.id.asc(),
        )
    )
    batches = db.execute(stmt).scalars().all()

    taken: list[tuple[StockBatch, int]] = []
    remaining = qty_base
    for batch in batches:
        if remaining <= 0:
            break
        take = min(batch.qty_remaining, remaining)
        if take <= 0:
            continue
        batch.qty_remaining -= take
        taken.append((batch, take))
        remaining -= take

    if taken:
        db.flush()
    return taken


def weighted_average_cost_micros(db: Session, *, store_id: int, ingredient_id: int) -> int | None:
    """El promedio ponderado **se deriva, no se guarda** (decisión de
    arquitectura #2 del pedido 2b — misma regla que el saldo de una cuenta
    por pagar y los saldos de caja: una sola matemática, una sola fuente de
    verdad). Lee los `StockBatch` vigentes (`reversed_at IS NULL`) de este
    insumo, **recibidos DESPUÉS del último conteo completo aplicado**
    (`last_applied_full_count_at`) — una compra anterior a ese conteo no lo
    mueve, porque ese conteo ya fijó una verdad física que las compras
    viejas no pueden seguir empujando. Si todavía no hubo NINGÚN conteo
    completo, no hay corte: pondera TODAS las compras históricas (una sede
    recién sembrada, con compras pero sin conteos, tiene que poder mostrar
    un promedio igual).

    Pondera por `qty_received` (lo que entró a ese precio), no por
    `qty_remaining` (lo que queda hoy) — esto es el precio promedio de lo
    QUE SE COMPRÓ en la ventana, no una valoración del stock actual (esa
    cuenta la hace `food-cost`, no acá). `None` si no hay ninguna compra en
    la ventana — nunca `0`."""
    cutoff = last_applied_full_count_at(db, store_id=store_id)
    stmt = select(StockBatch.qty_received, StockBatch.unit_cost_micros).where(
        StockBatch.store_id == store_id,
        StockBatch.ingredient_id == ingredient_id,
        StockBatch.reversed_at.is_(None),
    )
    if cutoff is not None:
        stmt = stmt.where(StockBatch.received_at > cutoff)
    rows = db.execute(stmt).all()
    if not rows:
        return None
    total_qty = sum(int(r[0]) for r in rows)
    if total_qty <= 0:
        return None
    numerator = sum(int(r[0]) * int(r[1]) for r in rows)
    return (numerator + total_qty // 2) // total_qty


def last_purchase_cost_micros(db: Session, *, store_id: int, ingredient_id: int) -> int | None:
    """El costo de la compra más reciente de este insumo, **sin** el corte
    del último conteo completo (a diferencia de `weighted_average_cost_micros`):
    es el respaldo de "algo es mejor que nada" cuando el promedio reciente no
    tiene con qué calcularse — mira TODA la historia de lotes vigentes
    (`reversed_at IS NULL`), ordenados por `received_at` descendente (y `id`
    descendente como desempate). `None` si nunca hubo una compra."""
    stmt = (
        select(StockBatch.unit_cost_micros)
        .where(
            StockBatch.store_id == store_id,
            StockBatch.ingredient_id == ingredient_id,
            StockBatch.reversed_at.is_(None),
        )
        .order_by(StockBatch.received_at.desc(), StockBatch.id.desc())
        .limit(1)
    )
    result = db.execute(stmt).scalar_one_or_none()
    return int(result) if result is not None else None


def last_applied_full_count_at(db: Session, *, store_id: int) -> datetime | None:
    """El `applied_at` del conteo `scope="full"` `status="applied"` más
    reciente de la sede, o `None` si nunca se aplicó uno. Es el corte que usa
    `weighted_average_cost_micros` y la fuente que lee `inventory_staleness`
    para "inventario no confiable" (> `INVENTORY_STALE_DAYS` días sin uno)."""
    stmt = select(func.max(StockCount.applied_at)).where(
        StockCount.store_id == store_id,
        StockCount.scope == StockCountScope.FULL,
        StockCount.status == StockCountStatus.APPLIED,
    )
    return db.execute(stmt).scalar_one_or_none()


# ---------------------------------------------------------------------------
# Umbrales configurables de la sede (Ajustes › Inventario y compras, 0035).
# ---------------------------------------------------------------------------

#: Los valores de fábrica de los umbrales de 0035; son los `server_default`
#: de la migración y los defaults del modelo.
THRESHOLD_DEFAULTS: dict[str, int] = {
    "price_jump_pct": 15,
    "prep_variance_alert_pct": 15,
    "stale_days": 14,
    "lot_expiring_window_days": 7,
    "food_cost_band_min_pct": 28,
    "food_cost_band_max_pct": 35,
    "supplier_received_warning_bp": 9900,
    "supplier_received_critical_bp": 9500,
    "supplier_drift_warning_bp": 500,
    "supplier_drift_critical_bp": 1000,
    "supplier_min_receptions": 5,
}


@dataclass(frozen=True)
class StoreThresholds:
    price_jump_pct: int
    prep_variance_alert_pct: int
    stale_days: int
    lot_expiring_window_days: int
    food_cost_band_min_pct: int
    food_cost_band_max_pct: int
    supplier_received_warning_bp: int
    supplier_received_critical_bp: int
    supplier_drift_warning_bp: int
    supplier_drift_critical_bp: int
    supplier_min_receptions: int


def store_thresholds(db: Session, store_id: int) -> StoreThresholds:
    """Los umbrales que rigen en la sede: los que guardó en Ajustes ›
    Inventario y compras o, sin fila, los de fábrica. Contrato cruzado para
    compras, recetas e informes (no exige `inventory.variance`, que sólo
    cierra la pantalla de varianza). Sólo lee: no crea la fila."""
    row = db.get(StoreInventorySettings, store_id)
    values = {
        name: (getattr(row, name, None) if row is not None else None) or default
        for name, default in THRESHOLD_DEFAULTS.items()
    }
    return StoreThresholds(**values)


# Umbral único de "inventario no confiable" (SPEC-NEGOCIO §5.4/§9.3): más de
# 14 días sin un conteo completo aplicado apaga el food cost real. RONDA 2,
# hallazgo H-4: antes vivía escrito DOS VECES (`CONTROL_HEALTH_STALE_DAYS` en
# `control_health` y `FOOD_COST_STALE_DAYS` en `food_cost_report`, ambas en
# `app.inventory.service`) -- la misma constante conceptual duplicada porque
# dos endpoints independientes la necesitaban, lo que es exactamente el tipo
# de "dos matemáticas" que `AGENTS.md` prohíbe. Ahora vive acá, una sola vez,
# y `service` la consume a través de `inventory_staleness`, nunca
# recalculándola. Desde 0035 es el DEFAULT: la sede lo cambia en Ajustes ›
# Inventario (`StoreInventorySettings.stale_days`) y `inventory_staleness`
# lee el de la sede.
INVENTORY_STALE_DAYS = 14


@dataclass(frozen=True)
class InventoryStaleness:
    """Resultado de `inventory_staleness`. `days_since_last_full_count` es
    `None` cuando NUNCA se aplicó un conteo completo -- nunca un número
    inventado (`0` días sería falso: no hay "desde cuándo"). `unreliable` es
    la señal que apaga el food cost real; `stale_days` viaja en la respuesta
    para que quien la lea no tenga que conocer `INVENTORY_STALE_DAYS` por
    fuera del contrato."""

    days_since_last_full_count: int | None
    unreliable: bool
    stale_days: int


def inventory_staleness(db: Session, *, store_id: int, cutoff_hour: int) -> InventoryStaleness:
    """Contrato nuevo de la ronda 2 (hallazgo H-4). Días desde el último
    conteo completo aplicado, por FECHA DE NEGOCIO (`app.core.tz.
    business_date_for` con `cutoff_hour` de la sede) -- **nunca** restando
    instantes UTC directamente, que es exactamente el error que
    `app.core.tz` existe para evitar (un turno de madrugada movería el
    conteo de día sin que el negocio lo haya cruzado).

    Sin ningún conteo completo aplicado nunca: `days_since_last_full_count
    = None` y `unreliable = True` -- **nunca** un número inventado (no hay
    "desde cuándo" si nunca pasó). Con uno: `unreliable = days > stale_days`.

    `app.inventory.service.control_health` y `app.inventory.service.
    food_cost_report` LEEN esta función -- ninguno de los dos vuelve a sumar
    días por su cuenta (una sola matemática, una sola fuente de verdad, el
    mismo principio que `weighted_average_cost_micros`)."""
    stale_days = store_thresholds(db, store_id).stale_days
    last_full = last_applied_full_count_at(db, store_id=store_id)
    if last_full is None:
        return InventoryStaleness(
            days_since_last_full_count=None, unreliable=True, stale_days=stale_days
        )
    today = tz.today_business_date(cutoff_hour)
    last_full_date = tz.business_date_for(last_full, cutoff_hour)
    days_since = (today - last_full_date).days
    return InventoryStaleness(
        days_since_last_full_count=days_since,
        unreliable=days_since > stale_days,
        stale_days=stale_days,
    )


# ---------------------------------------------------------------------------
# Food cost por VENTANA DE CONTEO — reglas compartidas por `app.inventory.
# service.food_cost_report` (la ventana más reciente) y `app.analytics.
# service` (salud sostenida, ventanas históricas). Viven acá, una sola vez,
# por el mismo motivo que `INVENTORY_STALE_DAYS`: dos endpoints que publican
# el mismo food cost no pueden tener dos umbrales ni dos redondeos.
# ---------------------------------------------------------------------------

# Ventana mínima entre dos conteos completos para publicar un food cost real:
# 24 h. Con menos, la variación de inventario de unas horas no se compensa
# con lo vendido en esas horas (lo sensible es cuándo se descontó el insumo
# contra cuándo se cobró la comanda) y el porcentaje sale absurdo — el caso
# real fue una ventana de 16 h que dio −77,75 % (informe de visualización,
# #3). El informe sugería 3 días, pero las invariantes de conteo de
# `tests/audit/test_counts_invariants.py` (que no se ablandan) fijan que dos
# conteos completos a 24 h publican food cost real: un día de negocio
# completo es el piso. Una ventana de 1-3 días se publica con `window_days`
# al lado para que la pantalla la marque como muestra chica.
FOOD_COST_MIN_WINDOW_HOURS = 24
FOOD_COST_MIN_WINDOW_DAYS = FOOD_COST_MIN_WINDOW_HOURS // 24

# Cobertura mínima de fichas técnicas, en bp de las ventas netas: por debajo
# de 80 % el food cost teórico describe a una minoría de lo vendido, y la
# brecha real − teórico mide la falta de fichas, no la fuga (informe #4).
# Por encima, el teórico se ESCALA a la cobertura (costo teórico ÷ ventas
# netas de lo costeado) para no inflar la brecha con lo que no tiene ficha.
FOOD_COST_MIN_COSTED_BP = 8000


def window_span(window_from: datetime, window_to: datetime) -> tuple[int, int]:
    """`(horas, días)` completos entre dos instantes (truncados, nunca
    redondeados hacia arriba: una ventana de 71 h no son 3 días)."""
    seconds = int((window_to - window_from).total_seconds())
    hours = max(seconds, 0) // 3600
    return hours, hours // 24


def window_is_too_short(window_from: datetime, window_to: datetime) -> bool:
    return (window_to - window_from).total_seconds() < FOOD_COST_MIN_WINDOW_HOURS * 3600


@dataclass(frozen=True)
class TheoreticalFoodCost:
    """Food cost TEÓRICO de lo vendido en una ventana. `pct_bp` es el costo
    congelado de los ítems con ficha ÷ las ventas netas de ESOS MISMOS ítems
    (escalado a la cobertura); `costed_pct_bp` es qué parte de las ventas
    netas tenía ficha. `pct_bp` es `None` con `reason` sin ventas, sin
    ninguna ficha, o con cobertura bajo `FOOD_COST_MIN_COSTED_BP`."""

    pct_bp: int | None
    costed_pct_bp: int | None
    reason: str | None


def _half_up_pos(numerator: int, denominator: int) -> int:
    q, r = divmod(numerator, denominator)
    return q + 1 if r * 2 >= denominator else q


def theoretical_food_cost(*, net_sales: int, costed_net: int, theoretical_cost_micros: int | None) -> TheoreticalFoodCost:
    from app.core.percent import format_pct_bp
    from app.core.quantity import micros_to_pesos

    if net_sales <= 0:
        return TheoreticalFoodCost(None, None, "No hubo ventas cobradas en la ventana")
    costed_pct_bp = _half_up_pos(max(costed_net, 0) * 10000, net_sales)
    if theoretical_cost_micros is None or costed_net <= 0:
        return TheoreticalFoodCost(
            None, 0, "Ninguno de los platos vendidos en la ventana tenía ficha técnica con costo"
        )
    if costed_pct_bp < FOOD_COST_MIN_COSTED_BP:
        return TheoreticalFoodCost(
            None,
            costed_pct_bp,
            f"Sólo el {format_pct_bp(costed_pct_bp)} de lo vendido tiene ficha técnica con costo; "
            f"hace falta al menos el {format_pct_bp(FOOD_COST_MIN_COSTED_BP, decimals=0)} para comparar",
        )
    cost_pesos = micros_to_pesos(theoretical_cost_micros)
    return TheoreticalFoodCost(_half_up_pos(max(cost_pesos, 0) * 10000, costed_net), costed_pct_bp, None)


# ---------------------------------------------------------------------------
# Lecturas auxiliares para `GET /admin/today` (territorio de `app.reports`;
# publicadas acá, mismo patrón que `low_stock_alerts`/`negative_stock_alerts`,
# para que ese dominio no reimplemente el cálculo de estado de un lote ni el
# de salud del control — ver `app.inventory.service.control_health` para la
# versión completa que sirve `GET /admin/control-health`).
# ---------------------------------------------------------------------------


def expiring_or_expired_lots(db: Session, *, store_id: int, today: date) -> list[dict]:
    """Lotes vigentes con stock (`qty_remaining > 0`, `reversed_at IS NULL`)
    que están por vencer (`<= 7` días) o ya vencidos, para que "Hoy" pueda
    alertar sin reimplementar el cálculo de estado de `GET /admin/lots`
    (`app.inventory.service.lot_status`). Un lote vencido **no se da de baja
    solo**: sigue apareciendo acá, con stock, hasta que alguien registre la
    merma (`POST /waste type=expired`)."""
    from datetime import timedelta

    stmt = select(StockBatch).where(
        StockBatch.store_id == store_id,
        StockBatch.reversed_at.is_(None),
        StockBatch.qty_remaining > 0,
        StockBatch.expires_at.is_not(None),
        StockBatch.expires_at <= today + timedelta(days=store_thresholds(db, store_id).lot_expiring_window_days),
    )
    rows = db.execute(stmt.order_by(StockBatch.expires_at.asc())).scalars().all()
    alerts: list[dict] = []
    for batch in rows:
        assert batch.expires_at is not None
        alerts.append(
            {
                "batch_id": batch.id,
                "ingredient_id": batch.ingredient_id,
                "qty_base": batch.qty_remaining,
                "expires_at": batch.expires_at.isoformat(),
                "status": "expired" if batch.expires_at < today else "expiring",
            }
        )
    return alerts


# ---------------------------------------------------------------------------
# Salidas explicadas (consumo interno, traslados) — rutina del turno.
# ---------------------------------------------------------------------------


def explained_outflow_qty(
    db: Session, *, store_id: int, ingredient_id: int, window_from: datetime, window_to: datetime
) -> int:
    """Cantidad (positiva, milésimas de la unidad base) de un insumo que salió
    de la sede en `(window_from, window_to]` como consumo interno o traslado.
    Mismo instante que su movimiento (`Waste.at` y `StockMovement.at` se
    escriben con el mismo `now`), así que la ventana coincide con la de
    `_movement_sum`."""
    stmt = select(func.coalesce(func.sum(Waste.qty_base), 0)).where(
        Waste.store_id == store_id,
        Waste.ingredient_id == ingredient_id,
        Waste.type.in_(EXPLAINED_WASTE_TYPES),
        Waste.at > window_from,
        Waste.at <= window_to,
    )
    return int(db.execute(stmt).scalar_one())


# ---------------------------------------------------------------------------
# Valoración y varianza entre dos conteos: UNA sola implementación.
#
# `app.inventory.service` (varianza por insumo, food cost real) y
# `app.analytics.service` (varianza por plato, salud sostenida) las usan las
# dos. Antes analítica tenía un «espejo literal» de cada función, que podía
# desincronizarse en silencio (limpieza 2026-10).
# ---------------------------------------------------------------------------


def movement_sum(
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
    """Σ `qty_base` de los movimientos de un insumo en `(window_from,
    window_to]`, sólo las entradas (`positive`) o sólo las salidas, con
    filtro opcional de causas."""
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


def counted_quantities(db: Session, *, count_id: int) -> dict[int, int]:
    """`ingredient_id -> cantidad contada` de los renglones CONTADOS de un
    conteo (un renglón sin contar no es 0: no está)."""
    rows = db.execute(
        select(StockCountLine.ingredient_id, StockCountLine.qty_counted, StockCountLine.was_counted).where(
            StockCountLine.count_id == count_id
        )
    ).all()
    return {ing_id: int(qty) for ing_id, qty, was_counted in rows if was_counted and qty is not None}


def count_inventory_value(db: Session, *, store_id: int, count_id: int) -> int:
    """Valoriza, en pesos, los renglones CONTADOS de un conteo al costo
    resuelto de HOY (`resolve_ingredient_cost`). No revalora una VENTA
    pasada (prohibido por `AGENTS.md`): esto valoriza un CONTEO, que es una
    foto de stock, no una venta -- el snapshot que la spec protege es el de
    `order_items`, no éste. Un insumo sin costo no suma (no se inventa)."""
    total_micros = 0
    for ingredient_id, qty in counted_quantities(db, count_id=count_id).items():
        ingredient = get_ingredient(db, store_id=store_id, ingredient_id=ingredient_id)
        if ingredient is None:
            continue
        cost_micros, _source = resolve_ingredient_cost(db, ingredient)
        if cost_micros is None:
            continue
        total_micros += line_cost_micros(qty, cost_micros)
    return micros_to_pesos(total_micros)


def purchases_value(db: Session, *, store_id: int, window_from: datetime, window_to: datetime) -> int:
    """Pesos de las compras (`cause=PURCHASE`, al costo del movimiento) en
    `(window_from, window_to]`."""
    total_micros = 0
    stmt = select(StockMovement).where(
        StockMovement.store_id == store_id,
        StockMovement.cause == MovementCause.PURCHASE,
        StockMovement.at > window_from,
        StockMovement.at <= window_to,
    )
    for movement in db.execute(stmt).scalars():
        if movement.cost_micros is not None:
            total_micros += line_cost_micros(movement.qty_base, movement.cost_micros)
    return micros_to_pesos(total_micros)


def purchase_movement_count(db: Session, *, store_id: int, window_from: datetime, window_to: datetime) -> int:
    """Cuántos movimientos de compra hubo en la ventana (con o sin costo):
    compras en $0 con movimientos es «falta el costo», no «no se compró»."""
    stmt = select(func.count(StockMovement.id)).where(
        StockMovement.store_id == store_id,
        StockMovement.cause == MovementCause.PURCHASE,
        StockMovement.at > window_from,
        StockMovement.at <= window_to,
    )
    return int(db.execute(stmt).scalar_one())


@dataclass(frozen=True)
class IngredientVariance:
    """La identidad de un insumo entre dos conteos, ya resuelta. Signo:
    `variance_qty > 0` = se usó más de lo esperado (faltante)."""

    ingredient: Ingredient
    opening_qty: int
    inflow_qty: int
    closing_qty: int
    real_usage_qty: int
    theoretical_usage_qty: int
    variance_qty: int
    cost_micros: int | None
    cost_source: CostSource
    #: Pesos de la varianza al costo de hoy; `None` sin costo (nunca `0`).
    variance_value: int | None


def ingredient_variance(
    db: Session, *, store_id: int, opening: StockCount, closing: StockCount
) -> list[IngredientVariance]:
    """Identidad `inicial + entradas − final − salidas explicadas = uso real`
    contra el uso teórico del libro (`cause=SALE` + `cause=PRODUCTION_OUT`,
    SPEC-NEGOCIO §5.3), para cada insumo contado en los DOS conteos, en
    orden de id.

    `entradas` EXCLUYE `count_adjustment` a propósito: el ajuste del conteo
    anterior ya quedó absorbido en `inicial` (que es el valor CONTADO), así
    que sumarlo de nuevo lo contaría dos veces. Lo que salió EXPLICADO
    (consumo interno, traslado a otra sede, `explained_outflow_qty`) no es
    uso de la cocina ni pérdida: se descuenta del uso real.

    Sin semáforo: el color lo pone quien publica la varianza por insumo
    (`app.inventory.service.variance_report`); la varianza por plato sólo
    reparte pesos."""
    opening_lines = counted_quantities(db, count_id=opening.id)
    closing_lines = counted_quantities(db, count_id=closing.id)
    w_from, w_to = opening.opened_at, closing.opened_at
    out: list[IngredientVariance] = []
    for ing_id in sorted(set(opening_lines) & set(closing_lines)):
        ingredient = get_ingredient(db, store_id=store_id, ingredient_id=ing_id)
        if ingredient is None:
            continue
        opening_qty = opening_lines[ing_id]
        closing_qty = closing_lines[ing_id]
        inflow = movement_sum(
            db, store_id=store_id, ingredient_id=ing_id, window_from=w_from, window_to=w_to,
            positive=True, exclude_causes=(MovementCause.COUNT_ADJUSTMENT,),
        )
        explained_out = explained_outflow_qty(
            db, store_id=store_id, ingredient_id=ing_id, window_from=w_from, window_to=w_to
        )
        real_usage = opening_qty + inflow - closing_qty - explained_out
        theoretical = -movement_sum(
            db, store_id=store_id, ingredient_id=ing_id, window_from=w_from, window_to=w_to,
            positive=False, causes=(MovementCause.SALE, MovementCause.PRODUCTION_OUT),
        )
        variance_qty = real_usage - theoretical
        cost_micros, cost_source = resolve_ingredient_cost(db, ingredient)
        variance_value = (
            micros_to_pesos(line_cost_micros(variance_qty, cost_micros)) if cost_micros is not None else None
        )
        out.append(
            IngredientVariance(
                ingredient=ingredient,
                opening_qty=opening_qty,
                inflow_qty=inflow,
                closing_qty=closing_qty,
                real_usage_qty=real_usage,
                theoretical_usage_qty=theoretical,
                variance_qty=variance_qty,
                cost_micros=cost_micros,
                cost_source=cost_source,
                variance_value=variance_value,
            )
        )
    return out


# ---------------------------------------------------------------------------
# Varianza de inventario de un PERÍODO de fechas operativas (costo real =
# teórico + varianza, para Utilidad, el costo primo y el estado de
# resultados). La varianza existe entre dos conteos completos aplicados
# (`ingredient_variance`); un período de fechas no coincide con esas
# ventanas, así que cada ventana se reparte por DÍAS OPERATIVOS: a un mes le
# toca la parte de la ventana que cae dentro del mes, en proporción a los
# días. Lo que el período no alcanza a cubrir con ventanas se publica
# (`days_covered` contra `days_in_period`), nunca se rellena.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CountWindowVariance:
    """Una ventana entre dos conteos completos consecutivos: sus fechas
    operativas y la varianza en pesos de los insumos con costo. Signo:
    positivo = faltante (se usó más de lo que las fichas explican)."""

    opening_date: date
    closing_date: date
    value: int
    uncosted_ingredients: int


@dataclass(frozen=True)
class PeriodVariance:
    """La varianza que le toca a un período. `value` es `None` (con
    `reason`) cuando ninguna ventana de conteos lo toca: no es `0`."""

    value: int | None
    days_covered: int
    days_in_period: int
    windows: int
    uncosted_ingredients: int
    reason: str | None


def _signed_half_up(numerator: int, denominator: int) -> int:
    magnitude = _half_up_pos(abs(numerator), denominator)
    return -magnitude if numerator < 0 else magnitude


def count_window_variances(db: Session, *, store_id: int, date_from: date, date_to: date) -> list[CountWindowVariance]:
    """Las ventanas entre conteos completos aplicados consecutivos que tocan
    `[date_from, date_to]`, con su varianza valorizada por
    `ingredient_variance` (la única implementación). Las ventanas más
    cortas que `FOOD_COST_MIN_WINDOW_HOURS` o de un solo día operativo no
    entran: no se pueden repartir por días."""
    counts = list(
        db.execute(
            select(StockCount)
            .where(
                StockCount.store_id == store_id,
                StockCount.scope == StockCountScope.FULL,
                StockCount.status == StockCountStatus.APPLIED,
            )
            .order_by(StockCount.opened_at.asc(), StockCount.id.asc())
        ).scalars()
    )
    out: list[CountWindowVariance] = []
    for opening, closing in zip(counts, counts[1:]):
        if closing.business_date <= opening.business_date or window_is_too_short(opening.opened_at, closing.opened_at):
            continue
        # La ventana cubre los días operativos [apertura, cierre).
        if closing.business_date <= date_from or opening.business_date > date_to:
            continue
        rows = ingredient_variance(db, store_id=store_id, opening=opening, closing=closing)
        out.append(
            CountWindowVariance(
                opening_date=opening.business_date,
                closing_date=closing.business_date,
                value=sum(r.variance_value for r in rows if r.variance_value is not None),
                uncosted_ingredients=sum(1 for r in rows if r.variance_value is None and r.variance_qty != 0),
            )
        )
    return out


def period_variance(
    windows: list[CountWindowVariance], *, date_from: date, date_to: date
) -> PeriodVariance:
    """Reparte `windows` (de `count_window_variances`, leídas una vez para
    un rango más ancho si hace falta: el estado de resultados lee doce meses
    de una sola pasada) sobre `[date_from, date_to]` por días operativos."""
    from datetime import timedelta

    days_in_period = (date_to - date_from).days + 1
    end_exclusive = date_to + timedelta(days=1)
    total = covered = used = uncosted = 0
    for w in windows:
        span = (w.closing_date - w.opening_date).days
        overlap = (min(w.closing_date, end_exclusive) - max(w.opening_date, date_from)).days
        if span <= 0 or overlap <= 0:
            continue
        total += _signed_half_up(w.value * overlap, span)
        covered += overlap
        used += 1
        uncosted += w.uncosted_ingredients
    if used == 0:
        return PeriodVariance(
            value=None,
            days_covered=0,
            days_in_period=days_in_period,
            windows=0,
            uncosted_ingredients=0,
            reason=(
                "No hay dos conteos completos de inventario que encierren días de este período: sin ellos no "
                "se sabe cuánto se usó de verdad. Hacé un conteo completo en Inventario."
            ),
        )
    return PeriodVariance(
        value=total,
        days_covered=min(covered, days_in_period),
        days_in_period=days_in_period,
        windows=used,
        uncosted_ingredients=uncosted,
        reason=None,
    )


def pending_incoming_transfers(db: Session, *, store_id: int) -> int:
    """Traslados que llegan a esta sede y todavía nadie recibió."""
    stmt = select(func.count(Waste.id)).where(
        Waste.destination_store_id == store_id,
        Waste.type == WasteType.TRANSFER_OUT,
        Waste.received_at.is_(None),
    )
    return int(db.execute(stmt).scalar_one())


# ---------------------------------------------------------------------------
# Conteo corto por área (`inventory.shift_counts`) — para Hoy.
# ---------------------------------------------------------------------------


def area_counts_today(db: Session, *, store: Store) -> AreaCountsToday:
    """Qué áreas contaron hoy (apertura y cierre), los artículos fuera del
    umbral —de noche o en el turno— y los recuentos respondidos hoy con su
    diferencia, más cuántos recuentos siguen pendientes. Devuelve
    `app.inventory.area_counts.AreaCountsToday` (dataclasses congeladas):
    `app.reports` arma su esquema con eso, sin recalcular nada. Quien llama
    decide si la función está encendida."""
    from app.inventory import area_counts

    return area_counts.today_summary(db, store=store)


# ---------------------------------------------------------------------------
# El área de quien pide y la unidad cómoda — para las solicitudes del POS.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RequesterArea:
    """El área de conteo que le corresponde a una persona y sus artículos
    clave. `via` dice de dónde salió: `member` (el administrador la asignó
    en Conteo por área), `puesto` (no tiene área asignada, pero su puesto
    —cocina, bar…— se llama como un área activa) o `none` (ninguna)."""

    area_id: int | None
    area_name: str | None
    ingredient_ids: tuple[int, ...]
    via: str


def _fold(text: str) -> str:
    import unicodedata

    return "".join(
        c for c in unicodedata.normalize("NFD", text.strip().lower()) if unicodedata.category(c) != "Mn"
    )


def requester_area(db: Session, *, store: Store, employee_id: int | None) -> RequesterArea:
    """El área de quien pide: la asignada (`member_area`) y, si no tiene,
    la que se llama como su puesto. Lectura pura."""
    from app.auth.models import Employee
    from app.inventory import area_counts
    from app.inventory.models import CountArea

    none = RequesterArea(area_id=None, area_name=None, ingredient_ids=(), via="none")
    if employee_id is None:
        return none
    area = area_counts.member_area(db, store=store, employee_id=employee_id)
    via = "member"
    if area is None:
        employee = db.get(Employee, employee_id)
        puesto = getattr(employee, "puesto", None) if employee is not None else None
        if not puesto:
            return none
        wanted = _fold(str(puesto))
        for candidate in area_counts.list_areas(db, store=store, active_only=True):
            if isinstance(candidate, CountArea) and _fold(candidate.name) == wanted:
                area = candidate
                via = "puesto"
                break
        if area is None:
            return none
    ids = tuple(i.id for i in area_counts.area_ingredients(db, area=area))
    return RequesterArea(area_id=area.id, area_name=area.name, ingredient_ids=ids, via=via)


def entry_unit_of(ingredient: Ingredient) -> tuple[str, str]:
    """`(modo, rótulo)` de la unidad cómoda del insumo (`units.entry_spec`)."""
    from app.inventory.units import entry_spec

    spec = entry_spec(ingredient)
    return spec.mode, spec.unit


def entry_qty_to_base(ingredient: Ingredient, raw: str) -> int:
    """Lo tecleado en la unidad cómoda → milésimas de la unidad base. La
    misma conversión del conteo por área y de la merma."""
    from app.inventory.units import entry_qty_to_base as _convert

    return _convert(ingredient, raw)


def base_to_entry_milli(ingredient: Ingredient, qty_base: int) -> int:
    from app.inventory.units import base_to_entry_milli as _convert

    return _convert(ingredient, qty_base)


def rounded_entry_suggestion(ingredient: Ingredient, qty_base: int) -> tuple[int, int]:
    from app.inventory.units import rounded_entry_suggestion as _round

    return _round(ingredient, qty_base)


def ingredients_by_id(db: Session, *, store_id: int, ids: list[int]) -> dict[int, Ingredient]:
    if not ids:
        return {}
    stmt = select(Ingredient).where(Ingredient.store_id == store_id, Ingredient.id.in_(ids))
    return {i.id: i for i in db.execute(stmt).scalars()}


def lot_statuses(db: Session, *, batch_ids: list[int], today: date) -> dict[int, str]:
    """El estado de cada lote pedido (`active`/`expiring`/`expired`/
    `depleted`), con la MISMA regla que `GET /admin/lots`
    (`app.inventory.service.lot_status`) — Hoy lo usa para marcar qué
    entrada del día vence pronto sin escribir un segundo umbral. Un lote
    revertido no está en el diccionario."""
    from app.inventory import service as inventory_service

    if not batch_ids:
        return {}
    batches = db.execute(
        select(StockBatch).where(StockBatch.id.in_(batch_ids), StockBatch.reversed_at.is_(None))
    ).scalars()
    return {b.id: inventory_service.lot_status(b, today) for b in batches}
