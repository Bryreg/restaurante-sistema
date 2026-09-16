"""Lógica de negocio de `inventory`: insumos, stock teórico, mermas y
ajustes manuales. Toda escritura al libro de movimientos pasa por
`app.inventory.hooks.record_movement` (importado como `hooks`, nunca
`db.add(StockMovement(...))` acá tampoco).
"""

from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth import service as auth_service
from app.auth.deps import Actor
from app.auth.models import Employee
from app.core import clock, tz
from app.core.errors import AppError, NotFoundError
from app.core.quantity import format_cost_micros, format_qty_base, parse_cost_micros, parse_qty_base
from app.core.security import verify_secret
from app.inventory import hooks
from app.inventory.models import BaseUnit, CostSource, Ingredient, MovementCause, StockMovement, Waste, WasteType
from app.inventory.schemas import (
    AdjustmentIn,
    AdjustmentOut,
    IngredientIn,
    IngredientOut,
    IngredientUpdateIn,
    StockMovementOut,
    StockRowOut,
    WasteAdminOut,
    WasteIn,
    WasteKpiOut,
    WasteOut,
)
from app.notifications.service import notify
from app.stores.models import Store

# Alerta si la merma de un insumo supera 1,5x la de la semana anterior
# (SPEC-NEGOCIO §5.5). Constante en código a propósito: el umbral
# configurable llega en 2b junto con la varianza (no hay `StoreSettings`
# nuevo en este pedido — ver gaps del entregable).
WASTE_SPIKE_NUMERATOR = 3
WASTE_SPIKE_DENOMINATOR = 2  # 3/2 == 1.5, sin float


# ---------------------------------------------------------------------------
# Insumos.
# ---------------------------------------------------------------------------


def ingredient_or_404(db: Session, actor: Actor, ingredient_id: int) -> Ingredient:
    ingredient = db.get(Ingredient, ingredient_id)
    if ingredient is None or ingredient.organization_id != actor.organization_id:
        raise NotFoundError("El insumo no existe")
    return ingredient


def list_ingredients(db: Session, *, store: Store, active_only: bool = True) -> list[Ingredient]:
    stmt = select(Ingredient).where(Ingredient.store_id == store.id)
    if active_only:
        stmt = stmt.where(Ingredient.active.is_(True))
    return list(db.execute(stmt.order_by(Ingredient.name)).scalars().all())


def _parsed_min_stock(raw: str) -> int:
    min_stock = parse_qty_base(raw, field="min_stock")
    if min_stock <= 0:
        raise AppError(
            code="MIN_STOCK_REQUIRED",
            message="min_stock: definí un umbral mínimo mayor a cero; sin él, el motor de alertas de este insumo queda apagado",
        )
    return min_stock


def create_ingredient(db: Session, *, organization_id: int, store_id: int, data: IngredientIn) -> Ingredient:
    min_stock = _parsed_min_stock(data.min_stock)
    official_cost_micros = (
        parse_cost_micros(data.official_cost, field="official_cost") if data.official_cost is not None else None
    )
    estimated_cost_micros = (
        parse_cost_micros(data.estimated_cost, field="estimated_cost") if data.estimated_cost is not None else None
    )

    if data.substitute_ingredient_id is not None:
        substitute = hooks.get_ingredient(db, store_id=store_id, ingredient_id=data.substitute_ingredient_id)
        if substitute is None:
            raise NotFoundError("El insumo sustituto no existe")

    now = clock.now_utc()
    ingredient = Ingredient(
        organization_id=organization_id,
        store_id=store_id,
        name=data.name,
        category=data.category,
        base_unit=BaseUnit(data.base_unit),
        purchase_unit=data.purchase_unit,
        purchase_factor=data.purchase_factor,
        yield_pct=data.yield_pct,
        official_cost_micros=official_cost_micros,
        estimated_cost_micros=estimated_cost_micros,
        min_stock=min_stock,
        lead_time_days=data.lead_time_days,
        perishable=data.perishable,
        key_item=data.key_item,
        active=data.active,
        consumption_untracked=data.consumption_untracked,
        substitute_ingredient_id=data.substitute_ingredient_id,
        supplier_id=data.supplier_id,
        created_at=now,
        updated_at=now,
    )
    db.add(ingredient)
    db.flush()
    return ingredient


def update_ingredient(db: Session, ingredient: Ingredient, data: IngredientUpdateIn) -> Ingredient:
    if data.name is not None:
        ingredient.name = data.name
    if data.category is not None:
        ingredient.category = data.category
    if data.base_unit is not None:
        ingredient.base_unit = BaseUnit(data.base_unit)
    if data.purchase_unit is not None:
        ingredient.purchase_unit = data.purchase_unit
    if data.purchase_factor is not None:
        ingredient.purchase_factor = data.purchase_factor
    if data.yield_pct is not None:
        ingredient.yield_pct = data.yield_pct

    if data.clear_official_cost:
        ingredient.official_cost_micros = None
    elif data.official_cost is not None:
        ingredient.official_cost_micros = parse_cost_micros(data.official_cost, field="official_cost")

    if data.clear_estimated_cost:
        ingredient.estimated_cost_micros = None
    elif data.estimated_cost is not None:
        ingredient.estimated_cost_micros = parse_cost_micros(data.estimated_cost, field="estimated_cost")

    if data.min_stock is not None:
        ingredient.min_stock = _parsed_min_stock(data.min_stock)

    if data.lead_time_days is not None:
        ingredient.lead_time_days = data.lead_time_days
    if data.perishable is not None:
        ingredient.perishable = data.perishable
    if data.key_item is not None:
        ingredient.key_item = data.key_item
    if data.consumption_untracked is not None:
        ingredient.consumption_untracked = data.consumption_untracked

    if data.clear_substitute:
        ingredient.substitute_ingredient_id = None
    elif data.substitute_ingredient_id is not None:
        if data.substitute_ingredient_id == ingredient.id:
            raise AppError(
                code="VALIDATION_ERROR",
                message="substitute_ingredient_id: un insumo no puede ser su propio sustituto",
            )
        substitute = hooks.get_ingredient(
            db, store_id=ingredient.store_id, ingredient_id=data.substitute_ingredient_id
        )
        if substitute is None:
            raise NotFoundError("El insumo sustituto no existe")
        ingredient.substitute_ingredient_id = data.substitute_ingredient_id

    if data.supplier_id is not None:
        ingredient.supplier_id = data.supplier_id
    if data.active is not None:
        ingredient.active = data.active

    ingredient.updated_at = clock.now_utc()
    db.flush()
    return ingredient


def deactivate_ingredient(db: Session, ingredient: Ingredient) -> Ingredient:
    """Baja lógica: nunca se borra una fila de inventario."""
    ingredient.active = False
    ingredient.updated_at = clock.now_utc()
    db.flush()
    return ingredient


def ingredient_out(db: Session, ingredient: Ingredient) -> IngredientOut:
    cost_micros, cost_source = hooks.resolve_ingredient_cost(db, ingredient)
    return IngredientOut(
        id=ingredient.id,
        name=ingredient.name,
        category=ingredient.category,
        base_unit=ingredient.base_unit.value,  # type: ignore[arg-type]
        purchase_unit=ingredient.purchase_unit,
        purchase_factor=ingredient.purchase_factor,
        yield_pct=ingredient.yield_pct,
        official_cost=(
            format_cost_micros(ingredient.official_cost_micros)
            if ingredient.official_cost_micros is not None
            else None
        ),
        estimated_cost=(
            format_cost_micros(ingredient.estimated_cost_micros)
            if ingredient.estimated_cost_micros is not None
            else None
        ),
        cost=format_cost_micros(cost_micros) if cost_micros is not None else None,
        cost_source=cost_source.value,  # type: ignore[arg-type]
        min_stock=format_qty_base(ingredient.min_stock),
        lead_time_days=ingredient.lead_time_days,
        perishable=ingredient.perishable,
        key_item=ingredient.key_item,
        consumption_untracked=ingredient.consumption_untracked,
        substitute_ingredient_id=ingredient.substitute_ingredient_id,
        supplier_id=ingredient.supplier_id,
        active=ingredient.active,
    )


# ---------------------------------------------------------------------------
# Movimientos.
# ---------------------------------------------------------------------------


def list_movements(
    db: Session,
    *,
    ingredient: Ingredient,
    date_from: date | None,
    date_to: date | None,
    cause: MovementCause | None,
) -> list[StockMovement]:
    stmt = select(StockMovement).where(
        StockMovement.ingredient_id == ingredient.id, StockMovement.store_id == ingredient.store_id
    )
    if date_from is not None:
        stmt = stmt.where(StockMovement.business_date >= date_from)
    if date_to is not None:
        stmt = stmt.where(StockMovement.business_date <= date_to)
    if cause is not None:
        stmt = stmt.where(StockMovement.cause == cause)
    return list(db.execute(stmt.order_by(StockMovement.at.desc())).scalars().all())


def movement_out(movement: StockMovement) -> StockMovementOut:
    return StockMovementOut(
        id=movement.id,
        ingredient_id=movement.ingredient_id,
        preparation_id=movement.preparation_id,
        qty_base=format_qty_base(movement.qty_base),
        cause=movement.cause.value,  # type: ignore[arg-type]
        cost=format_cost_micros(movement.cost_micros) if movement.cost_micros is not None else None,
        cost_source=movement.cost_source.value,  # type: ignore[arg-type]
        employee_id=movement.employee_id,
        employee_name=movement.employee_name,
        at=movement.at,
        business_date=movement.business_date.isoformat(),
        ref_type=movement.ref_type,
        ref_id=movement.ref_id,
        note=movement.note,
    )


# ---------------------------------------------------------------------------
# Stock teórico.
# ---------------------------------------------------------------------------


def stock_rows(
    db: Session,
    *,
    store: Store,
    critical_only: bool = False,
    below_min: bool = False,
    negative: bool = False,
) -> list[StockRowOut]:
    stmt = select(Ingredient).where(Ingredient.store_id == store.id, Ingredient.active.is_(True))
    if critical_only:
        stmt = stmt.where(Ingredient.key_item.is_(True))
    ingredients = db.execute(stmt.order_by(Ingredient.name)).scalars().all()

    rows: list[StockRowOut] = []
    for ingredient in ingredients:
        qty = hooks.current_stock(db, store_id=store.id, ingredient_id=ingredient.id)
        is_below_min = qty < ingredient.min_stock
        is_negative = qty < 0
        if below_min and not is_below_min:
            continue
        if negative and not is_negative:
            continue

        cost_micros, cost_source = hooks.resolve_ingredient_cost(db, ingredient)
        negative_since = None
        if is_negative:
            negative_since, _probable_cause = hooks._negative_streak(
                db, store_id=store.id, ingredient_id=ingredient.id
            )

        rows.append(
            StockRowOut(
                ingredient_id=ingredient.id,
                name=ingredient.name,
                base_unit=ingredient.base_unit.value,  # type: ignore[arg-type]
                qty_base=format_qty_base(qty),
                min_stock=format_qty_base(ingredient.min_stock),
                below_min=is_below_min,
                negative=is_negative,
                negative_since=negative_since,
                cost=format_cost_micros(cost_micros) if cost_micros is not None else None,
                cost_source=cost_source.value,  # type: ignore[arg-type]
                key_item=ingredient.key_item,
            )
        )
    return rows


# ---------------------------------------------------------------------------
# Verificación de PIN de "responsable" (merma) y de admin (ajuste manual).
# ---------------------------------------------------------------------------


def _verify_responsible(db: Session, *, organization_id: int, store_id: int, pin: str) -> Employee:
    """Encuentra, por PIN, a la persona responsable de una merma
    (SPEC-NEGOCIO §5.5: "responsable con PIN") entre el personal activo de
    la sede o de toda la organización (los admin, sin sede propia) — mismo
    patrón de búsqueda por PIN que `app.auth.service.verify_authorizer`
    (territorio ajeno, y su matriz de acciones no cubre mermas), sin acotar
    a un id porque el contrato de la API sólo manda `employee_pin`."""
    candidates = (
        db.execute(
            select(Employee).where(Employee.organization_id == organization_id, Employee.active.is_(True))
        )
        .scalars()
        .all()
    )
    in_scope = [e for e in candidates if e.store_id is None or e.store_id == store_id]

    matched: Employee | None = None
    for candidate in in_scope:
        if verify_secret(pin, candidate.pin_hash):
            matched = candidate
            break

    if matched is None:
        raise AppError(code="AUTHORIZATION_INVALID", message="PIN incorrecto; pedí el PIN de la persona responsable")

    now = clock.now_utc()
    if matched.pin_locked_until is not None and matched.pin_locked_until > now:
        raise AppError(
            code="PIN_LOCKED", message="Ese PIN está bloqueado temporalmente tras varios intentos fallidos"
        )
    return matched


def _verify_self_authorizer(db: Session, *, actor: Actor, pin: str) -> Employee:
    """Re-confirma, con PIN, a la persona administradora ya autenticada
    (`current_admin`) que pide un ajuste manual de inventario — un ajuste
    manual siempre es cosa de administrador (nunca de supervisor), así que
    reutiliza `app.auth.service.verify_pin` (con su contador de intentos y
    bloqueo) sobre la MISMA persona de la sesión, en vez de
    `app.auth.service.verify_authorizer` (territorio ajeno), cuya matriz de
    acciones no incluye ajustes de inventario."""
    if actor.employee_id is None:
        raise AppError(code="VALIDATION_ERROR", message="No hay una persona administradora identificada")
    employee = db.get(Employee, actor.employee_id)
    if employee is None:
        raise NotFoundError("La persona administradora no existe")
    if not auth_service.verify_pin(db, employee, pin):
        raise AppError(code="AUTHORIZATION_INVALID", message="PIN de administrador incorrecto")
    return employee


# ---------------------------------------------------------------------------
# Mermas.
# ---------------------------------------------------------------------------


def _sum_waste_qty(db: Session, *, store_id: int, ingredient_id: int, date_from: date, date_to: date) -> int:
    stmt = select(func.coalesce(func.sum(Waste.qty_base), 0)).where(
        Waste.store_id == store_id,
        Waste.ingredient_id == ingredient_id,
        Waste.business_date >= date_from,
        Waste.business_date <= date_to,
    )
    return int(db.execute(stmt).scalar_one())


def _check_waste_spike(db: Session, *, store: Store, ingredient: Ingredient, business_date: date) -> None:
    this_week_start = business_date - timedelta(days=6)
    previous_week_end = this_week_start - timedelta(days=1)
    previous_week_start = previous_week_end - timedelta(days=6)

    this_week_qty = _sum_waste_qty(
        db, store_id=store.id, ingredient_id=ingredient.id, date_from=this_week_start, date_to=business_date
    )
    previous_week_qty = _sum_waste_qty(
        db, store_id=store.id, ingredient_id=ingredient.id, date_from=previous_week_start, date_to=previous_week_end
    )
    if previous_week_qty <= 0:
        return
    if this_week_qty * WASTE_SPIKE_DENOMINATOR > previous_week_qty * WASTE_SPIKE_NUMERATOR:
        notify(
            db,
            organization_id=store.organization_id,
            store_id=store.id,
            type="waste_spike",
            level="warning",
            title="Merma por encima de lo habitual",
            body=f'La merma de "{ingredient.name}" esta semana supera 1,5x la de la semana anterior',
            payload={"ingredient_id": ingredient.id},
            dedupe_key=f"waste_spike:{ingredient.id}:{business_date.isoformat()}",
        )


def register_waste(db: Session, *, store: Store, data: WasteIn) -> Waste:
    if (data.ingredient_id is None) == (data.preparation_id is None):
        raise AppError(
            code="VALIDATION_ERROR", message="Indicá exactamente un insumo o una preparación para la merma"
        )

    qty_base = parse_qty_base(data.qty, field="qty")
    if qty_base <= 0:
        raise AppError(code="VALIDATION_ERROR", message="qty: la cantidad de la merma tiene que ser mayor a cero")

    responsible = _verify_responsible(
        db, organization_id=store.organization_id, store_id=store.id, pin=data.employee_pin
    )

    ingredient: Ingredient | None = None
    cost_micros: int | None = None
    cost_source = CostSource.NONE
    if data.ingredient_id is not None:
        ingredient = hooks.get_ingredient(db, store_id=store.id, ingredient_id=data.ingredient_id)
        if ingredient is None:
            raise NotFoundError("El insumo no existe")
        cost_micros, cost_source = hooks.resolve_ingredient_cost(db, ingredient)
    # `preparation_id`: el costeo de una preparación es de `app.recipes`
    # (territorio ajeno); acá queda `cost_source=none` a propósito — gap
    # declarado en el entregable, nunca un cero mudo.

    now = clock.now_utc()
    business_date = tz.business_date_for(now, store.cutoff_hour)

    waste = Waste(
        organization_id=store.organization_id,
        store_id=store.id,
        type=WasteType(data.type),
        ingredient_id=data.ingredient_id,
        preparation_id=data.preparation_id,
        qty_base=qty_base,
        cost_micros=cost_micros,
        cost_source=cost_source,
        employee_id=responsible.id,
        employee_name=responsible.name,
        note=data.note,
        photo_url=data.photo,
        at=now,
        business_date=business_date,
    )
    db.add(waste)
    db.flush()

    responsible_actor = Actor(
        kind="device",
        organization_id=store.organization_id,
        store_id=store.id,
        employee_id=responsible.id,
        employee_name=responsible.name,
        role=responsible.role,
    )
    movement = hooks.record_movement(
        db,
        organization_id=store.organization_id,
        store_id=store.id,
        ingredient_id=data.ingredient_id,
        preparation_id=data.preparation_id,
        qty_base=-qty_base,
        cause=MovementCause.WASTE,
        cost_micros=cost_micros,
        cost_source=cost_source,
        actor=responsible_actor,
        business_date=business_date,
        at=now,
        ref_type="waste",
        ref_id=waste.id,
    )
    waste.stock_movement_id = movement.id
    db.flush()

    if ingredient is not None:
        _check_waste_spike(db, store=store, ingredient=ingredient, business_date=business_date)

    return waste


def list_waste(
    db: Session,
    *,
    store: Store,
    date_from: date | None,
    date_to: date | None,
    type_: WasteType | None,
    employee_id: int | None,
) -> list[Waste]:
    stmt = select(Waste).where(Waste.store_id == store.id)
    if date_from is not None:
        stmt = stmt.where(Waste.business_date >= date_from)
    if date_to is not None:
        stmt = stmt.where(Waste.business_date <= date_to)
    if type_ is not None:
        stmt = stmt.where(Waste.type == type_)
    if employee_id is not None:
        stmt = stmt.where(Waste.employee_id == employee_id)
    return list(db.execute(stmt.order_by(Waste.at.desc())).scalars().all())


def waste_out(waste: Waste) -> WasteOut:
    return WasteOut(
        id=waste.id,
        ingredient_id=waste.ingredient_id,
        preparation_id=waste.preparation_id,
        qty=format_qty_base(waste.qty_base),
        type=waste.type.value,  # type: ignore[arg-type]
        employee_id=waste.employee_id,
        employee_name=waste.employee_name,
        at=waste.at,
    )


def waste_admin_out(waste: Waste) -> WasteAdminOut:
    return WasteAdminOut(
        **waste_out(waste).model_dump(),
        cost=format_cost_micros(waste.cost_micros) if waste.cost_micros is not None else None,
        cost_source=waste.cost_source.value,  # type: ignore[arg-type]
        note=waste.note,
        photo=waste.photo_url,
    )


def weekly_waste_kpi() -> WasteKpiOut:
    """Mermas ÷ compras semanal. No hay compras todavía (son de 2b): `null`
    con `"sin datos"`, nunca `0` (`0` mentiría "no hay merma")."""
    return WasteKpiOut(ratio=None, label="sin datos")


# ---------------------------------------------------------------------------
# Ajustes manuales.
# ---------------------------------------------------------------------------


def register_adjustment(db: Session, *, store: Store, actor: Actor, data: AdjustmentIn) -> AdjustmentOut:
    authorizer = _verify_self_authorizer(db, actor=actor, pin=data.authorizer_pin)

    qty_delta = parse_qty_base(data.qty_delta, field="qty_delta")
    if qty_delta == 0:
        raise AppError(code="VALIDATION_ERROR", message="qty_delta: el ajuste no puede ser de cantidad cero")

    ingredient = hooks.get_ingredient(db, store_id=store.id, ingredient_id=data.ingredient_id)
    if ingredient is None:
        raise NotFoundError("El insumo no existe")

    cost_micros, cost_source = hooks.resolve_ingredient_cost(db, ingredient)
    now = clock.now_utc()
    business_date = tz.business_date_for(now, store.cutoff_hour)

    authorizer_actor = Actor(
        kind="admin",
        organization_id=store.organization_id,
        store_id=store.id,
        employee_id=authorizer.id,
        employee_name=authorizer.name,
        role=authorizer.role,
    )
    movement = hooks.record_movement(
        db,
        organization_id=store.organization_id,
        store_id=store.id,
        ingredient_id=ingredient.id,
        qty_base=qty_delta,
        cause=MovementCause.MANUAL_ADJUSTMENT,
        cost_micros=cost_micros,
        cost_source=cost_source,
        actor=authorizer_actor,
        business_date=business_date,
        at=now,
        note=data.reason,
    )
    return AdjustmentOut(
        id=movement.id,
        ingredient_id=ingredient.id,
        qty_delta=format_qty_base(qty_delta),
        reason=data.reason,
        employee_id=authorizer.id,
        employee_name=authorizer.name,
        at=movement.at,
    )
