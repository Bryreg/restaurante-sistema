"""Contrato publicado de `inventory` (`features/fase-2-costo-inventario/spec.md`):
lo que otros dominios (`recipes`, `orders`) llaman tal cual, sin reimplementar
nada de esto. **`record_movement` es la única escritura de inventario del
sistema entero** — ni siquiera otro archivo de este mismo dominio hace
`db.add(StockMovement(...))` fuera de acá.

Firmas vinculantes (no se renombran ni se reordenan los parámetros):

    record_movement(db, *, organization_id, store_id, ingredient_id=None,
                     preparation_id=None, qty_base, cause, cost_micros,
                     cost_source, actor, business_date, at,
                     ref_type=None, ref_id=None, note=None) -> StockMovement

    resolve_ingredient_cost(db, ingredient) -> tuple[int | None, CostSource]
    current_stock(db, *, store_id, ingredient_id=None, preparation_id=None) -> int
    get_ingredient(db, *, store_id, ingredient_id) -> Ingredient | None
    low_stock_alerts(db, *, store_id) -> list[dict]
    negative_stock_alerts(db, *, store_id) -> list[dict]
    resolve_consumption_target(db, ingredient, qty_base) -> list[tuple[Ingredient, int]]
"""

from __future__ import annotations

from collections import Counter
from datetime import date, datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.deps import Actor
from app.core.errors import AppError
from app.inventory.models import CostSource, Ingredient, MovementCause, StockMovement


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
    return movement


def resolve_ingredient_cost(db: Session, ingredient: Ingredient) -> tuple[int | None, CostSource]:
    """Jerarquía de costo en 2a (SPEC-NEGOCIO §4.1): oficial > estimado > sin
    costo. `weighted_average` y `last_purchase` son los otros dos escalones
    de la jerarquía completa; 2b los llena con las compras — acá nunca se
    devuelven porque todavía no hay compras."""
    if ingredient.official_cost_micros is not None:
        return ingredient.official_cost_micros, CostSource.OFFICIAL
    if ingredient.estimated_cost_micros is not None:
        return ingredient.estimated_cost_micros, CostSource.ESTIMATED
    return None, CostSource.NONE


def current_stock(
    db: Session,
    *,
    store_id: int,
    ingredient_id: int | None = None,
    preparation_id: int | None = None,
) -> int:
    """Stock teórico = Σ `qty_base` de todos los movimientos (el libro es
    append-only: nunca hay que "restar lo borrado"). Puede ser negativo — eso
    no es un error de esta función, es exactamente lo que SPEC-NEGOCIO §5.2
    pide poder representar."""
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
