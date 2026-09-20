"""Lógica de negocio de `inventory`: insumos, stock teórico, mermas y
ajustes manuales. Toda escritura al libro de movimientos pasa por
`app.inventory.hooks.record_movement` (importado como `hooks`, nunca
`db.add(StockMovement(...))` acá tampoco).
"""

from __future__ import annotations

import logging

import importlib
from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth import service as auth_service
from app.auth.deps import Actor
from app.auth.models import Employee
from app.core import clock, features, tz
from app.core.errors import AppError, NotFoundError
from app.core.modules import find_spec_safe
from app.core.quantity import (
    format_cost_micros,
    format_qty_base,
    line_cost_micros,
    micros_to_pesos,
    parse_cost_micros,
    parse_qty_base,
)
from app.core.security import verify_secret
from app.inventory import hooks
from app.inventory.models import (
    BaseUnit,
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
)
from app.inventory.schemas import (
    AdjustmentIn,
    AdjustmentOut,
    ControlHealthOut,
    CountApplyLineOut,
    CountApplyOut,
    CountDetailOut,
    CountLineOut,
    CountLinesIn,
    CountLinesSaveOut,
    CountOut,
    FoodCostOut,
    IngredientIn,
    IngredientOut,
    IngredientUpdateIn,
    InventorySettingsIn,
    InventorySettingsOut,
    LotOut,
    StockMovementOut,
    StockRowOut,
    VarianceOut,
    VarianceRowOut,
    WasteAdminOut,
    WasteIn,
    WasteKpiOut,
    WasteOut,
)
from app.notifications.service import notify
from app.stores.models import Store

logger = logging.getLogger("app.inventory")

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
    """Primero se valida TODO, después se escribe.

    `get_db` hace `commit()` cuando se levanta un `AppError`, así que una
    actualización que se rechaza a mitad de camino deja escrito lo que
    alcanzó a asignar antes del rechazo: la API responde 400 y el insumo
    quedó con el nombre nuevo y el costo oficial nuevo igual. Por eso el
    parseo de costos, el `min_stock` y el sustituto se resuelven arriba, en
    variables locales, y las asignaciones van todas juntas al final.
    """
    # --- validación: nada de esto toca `ingredient` -----------------------
    official_cost_micros: int | None = None
    if data.clear_official_cost:
        official_cost_micros = None
    elif data.official_cost is not None:
        official_cost_micros = parse_cost_micros(data.official_cost, field="official_cost")

    estimated_cost_micros: int | None = None
    if data.clear_estimated_cost:
        estimated_cost_micros = None
    elif data.estimated_cost is not None:
        estimated_cost_micros = parse_cost_micros(data.estimated_cost, field="estimated_cost")

    min_stock = _parsed_min_stock(data.min_stock) if data.min_stock is not None else None

    substitute_id: int | None = None
    if not data.clear_substitute and data.substitute_ingredient_id is not None:
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
        substitute_id = data.substitute_ingredient_id

    base_unit = BaseUnit(data.base_unit) if data.base_unit is not None else None

    # --- a partir de acá ya no queda nada que pueda decir que no ----------
    if data.name is not None:
        ingredient.name = data.name
    if data.category is not None:
        ingredient.category = data.category
    if base_unit is not None:
        ingredient.base_unit = base_unit
    if data.purchase_unit is not None:
        ingredient.purchase_unit = data.purchase_unit
    if data.purchase_factor is not None:
        ingredient.purchase_factor = data.purchase_factor
    if data.yield_pct is not None:
        ingredient.yield_pct = data.yield_pct

    if data.clear_official_cost or data.official_cost is not None:
        ingredient.official_cost_micros = official_cost_micros
    if data.clear_estimated_cost or data.estimated_cost is not None:
        ingredient.estimated_cost_micros = estimated_cost_micros
    if min_stock is not None:
        ingredient.min_stock = min_stock

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
    elif substitute_id is not None:
        ingredient.substitute_ingredient_id = substitute_id

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


def weekly_waste_kpi(db: Session, *, store: Store, business_date: date) -> WasteKpiOut:
    """Mermas ÷ compras de la semana que termina en `business_date`
    (SPEC-NEGOCIO §5.5). **Deuda cerrada en 2b** (`outputs-2a/ENTREGA.md § 5`,
    O-6): las compras salen del LIBRO (`cause=PURCHASE`, valorizadas con su
    `cost_micros` propio — nunca de importar `purchases`, una sola fuente de
    verdad). `null` con `label` legible cuando no hay compras en la semana
    (mermas ÷ 0 no es `0`, es "sin datos"); `ratio` en puntos básicos
    (× 10.000), **el único número no entero de la fase — ya no lo es**."""
    week_start = business_date - timedelta(days=6)

    waste_micros = 0
    for waste in db.execute(
        select(Waste).where(
            Waste.store_id == store.id, Waste.business_date >= week_start, Waste.business_date <= business_date
        )
    ).scalars():
        if waste.cost_micros is not None:
            waste_micros += line_cost_micros(waste.qty_base, waste.cost_micros)

    purchases_micros = 0
    for movement in db.execute(
        select(StockMovement).where(
            StockMovement.store_id == store.id,
            StockMovement.cause == MovementCause.PURCHASE,
            StockMovement.business_date >= week_start,
            StockMovement.business_date <= business_date,
        )
    ).scalars():
        if movement.cost_micros is not None:
            purchases_micros += line_cost_micros(movement.qty_base, movement.cost_micros)

    if purchases_micros <= 0:
        # Mismo texto que 2a (`tests/inventory/test_waste.py`, heredado):
        # "sin datos" es el contrato ya publicado para "no hay con qué
        # dividir" -- 2b lo sigue devolviendo tal cual cuando no hay
        # compras en la semana, sólo que ahora también deja de devolverlo
        # en cuanto SÍ las hay.
        return WasteKpiOut(ratio=None, label="sin datos")

    waste_pesos = micros_to_pesos(waste_micros)
    purchases_pesos = micros_to_pesos(purchases_micros)
    if purchases_pesos <= 0:
        return WasteKpiOut(ratio=None, label="sin datos")
    ratio_bp = (waste_pesos * 10000 + purchases_pesos // 2) // purchases_pesos
    # Formateo sin `float`: `ratio_bp` son puntos básicos (1 % == 100); se
    # arma el texto a mano, mismo estilo que `format_cost_micros`.
    whole_pct, frac_bp = divmod(ratio_bp, 100)
    label = f"{whole_pct}.{frac_bp:02d} % de las compras de la semana"
    return WasteKpiOut(ratio=ratio_bp, label=label)


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


# ---------------------------------------------------------------------------
# Umbrales de varianza (configuración de sede; pedido 2b). Vive en
# `inventory` a propósito (ver docstring de `StoreInventorySettings`):
# `PUT/GET /admin/stores/{store_id}/inventory-settings` las sirve el router
# de este dominio, no `app.stores`.
# ---------------------------------------------------------------------------

DEFAULT_VARIANCE_YELLOW_BP = 200  # 2,00 puntos porcentuales
DEFAULT_VARIANCE_RED_BP = 400  # 4,00 puntos porcentuales


def get_inventory_settings(db: Session, store: Store) -> StoreInventorySettings:
    """Devuelve la fila de la sede, creándola con los defaults de industria
    (SPEC-NEGOCIO §5.4) la primera vez que se pide — así una sede recién
    creada, antes de que nadie toque `PUT`, ya tiene semáforo con qué
    calcular en vez de romper con `NotFoundError`."""
    row = db.get(StoreInventorySettings, store.id)
    if row is None:
        row = StoreInventorySettings(
            store_id=store.id,
            variance_yellow_threshold_bp=DEFAULT_VARIANCE_YELLOW_BP,
            variance_red_threshold_bp=DEFAULT_VARIANCE_RED_BP,
            updated_at=clock.now_utc(),
        )
        db.add(row)
        db.flush()
    return row


def update_inventory_settings(db: Session, store: Store, data: InventorySettingsIn) -> StoreInventorySettings:
    if data.variance_red_threshold_bp <= data.variance_yellow_threshold_bp:
        raise AppError(
            code="VALIDATION_ERROR",
            message="variance_red_threshold_bp: tiene que ser mayor que variance_yellow_threshold_bp",
        )
    row = get_inventory_settings(db, store)
    row.variance_yellow_threshold_bp = data.variance_yellow_threshold_bp
    row.variance_red_threshold_bp = data.variance_red_threshold_bp
    row.updated_at = clock.now_utc()
    db.flush()
    return row


def inventory_settings_out(row: StoreInventorySettings) -> InventorySettingsOut:
    return InventorySettingsOut(
        store_id=row.store_id,
        variance_yellow_threshold_bp=row.variance_yellow_threshold_bp,
        variance_red_threshold_bp=row.variance_red_threshold_bp,
    )


# ---------------------------------------------------------------------------
# Lotes y vencimientos (SPEC-NEGOCIO §5.7; pedido 2b).
# ---------------------------------------------------------------------------

LOT_EXPIRING_WINDOW_DAYS = 7


def lot_status(batch: StockBatch, today: date) -> str:
    """`active`/`expiring` (`<= 7` días)/`expired`/`depleted`. Un lote SIN
    vencimiento nunca es `expiring` ni `expired` (SPEC-NEGOCIO §5.7): queda
    `active` para siempre, hasta que se consuma."""
    if batch.qty_remaining <= 0:
        return "depleted"
    if batch.expires_at is None:
        return "active"
    if batch.expires_at < today:
        return "expired"
    if (batch.expires_at - today).days <= LOT_EXPIRING_WINDOW_DAYS:
        return "expiring"
    return "active"


def _lot_sort_key(batch: StockBatch) -> tuple[int, date, datetime, int]:
    # FEFO para LISTAR (no para consumir -- eso es `hooks.consume_lots_fefo`,
    # que hace exactamente este mismo orden en SQL): vencimiento ascendente,
    # sin vencimiento AL FINAL, recepción ascendente como desempate.
    return (
        1 if batch.expires_at is None else 0,
        batch.expires_at or date.max,
        batch.received_at,
        batch.id,
    )


def list_lots(
    db: Session,
    *,
    store: Store,
    ingredient_id: int | None = None,
    status: str | None = None,
    expiring_within_days: int | None = None,
) -> list[tuple[StockBatch, str]]:
    stmt = select(StockBatch).where(StockBatch.store_id == store.id, StockBatch.reversed_at.is_(None))
    if ingredient_id is not None:
        stmt = stmt.where(StockBatch.ingredient_id == ingredient_id)
    batches = db.execute(stmt).scalars().all()
    today = tz.today_business_date(store.cutoff_hour)

    rows: list[tuple[StockBatch, str]] = []
    for batch in sorted(batches, key=_lot_sort_key):
        this_status = lot_status(batch, today)
        if status is not None and this_status != status:
            continue
        if expiring_within_days is not None:
            if batch.expires_at is None or (batch.expires_at - today).days > expiring_within_days:
                continue
        rows.append((batch, this_status))
    return rows


def lot_out(db: Session, batch: StockBatch, status: str) -> LotOut:
    ingredient = db.get(Ingredient, batch.ingredient_id)
    return LotOut(
        id=batch.id,
        ingredient_id=batch.ingredient_id,
        ingredient_name=ingredient.name if ingredient is not None else "?",
        lot_code=batch.lot_code,
        qty_received=format_qty_base(batch.qty_received),
        qty_remaining=format_qty_base(batch.qty_remaining),
        unit_cost=format_cost_micros(batch.unit_cost_micros),
        cost_source=batch.cost_source.value,  # type: ignore[arg-type]
        expires_at=batch.expires_at.isoformat() if batch.expires_at is not None else None,
        received_at=batch.received_at,
        status=status,  # type: ignore[arg-type]
        source_type=batch.source_type,
        source_id=batch.source_id,
    )


# ---------------------------------------------------------------------------
# Conteos a ciegas (SPEC-NEGOCIO §5.4).
# ---------------------------------------------------------------------------


def _ingredients_for_count_scope(db: Session, store: Store, scope: StockCountScope) -> list[Ingredient]:
    rows = list_ingredients(db, store=store, active_only=True)
    if scope == StockCountScope.KEY_ITEMS:
        rows = [i for i in rows if i.key_item]
    return rows


def open_count(db: Session, *, store: Store, actor: Actor, scope: StockCountScope) -> StockCount:
    """Abre un conteo **a ciegas**: crea un renglón por insumo del alcance
    (`key_items` -> `Ingredient.key_item`; `full` -> todos los activos), sin
    `qty_counted`. Ninguna función de este archivo que sirva el flujo de
    captura (acá, o `count_line_out`/`save_count_lines`) lee ni publica el
    stock teórico -- es la garantía "a ciegas" de la spec."""
    if actor.employee_id is None or not actor.employee_name:
        raise AppError(code="VALIDATION_ERROR", message="No hay una persona identificada para abrir el conteo")
    now = clock.now_utc()
    business_date = tz.business_date_for(now, store.cutoff_hour)
    count = StockCount(
        organization_id=store.organization_id,
        store_id=store.id,
        scope=scope,
        status=StockCountStatus.OPEN,
        opened_at=now,
        business_date=business_date,
        opened_by_employee_id=actor.employee_id,
        opened_by_employee_name=actor.employee_name,
        applied_at=None,
        applied_by_employee_id=None,
        applied_by_employee_name=None,
    )
    db.add(count)
    db.flush()
    for ingredient in _ingredients_for_count_scope(db, store, scope):
        db.add(
            StockCountLine(
                count_id=count.id, ingredient_id=ingredient.id, qty_counted=None, was_counted=False, counted_at=None
            )
        )
    db.flush()
    return count


def count_or_404(db: Session, store: Store, count_id: int) -> StockCount:
    count = db.get(StockCount, count_id)
    if count is None or count.store_id != store.id:
        raise NotFoundError("El conteo no existe")
    return count


def _count_lines(db: Session, count: StockCount) -> list[StockCountLine]:
    stmt = select(StockCountLine).where(StockCountLine.count_id == count.id).order_by(StockCountLine.id)
    return list(db.execute(stmt).scalars().all())


def count_lines_summary(db: Session, count: StockCount) -> tuple[int, int]:
    """`(lines_total, lines_counted)` -- lo que necesita `GET /admin/counts`
    (el listado) sin traer el detalle completo de cada renglón."""
    lines = _count_lines(db, count)
    return len(lines), sum(1 for l in lines if l.was_counted)


def _previous_line_qty(
    db: Session, *, store_id: int, ingredient_id: int, before_opened_at: datetime, exclude_count_id: int
) -> int | None:
    """El valor de la ÚLTIMA vez que se contó (con `was_counted = True`) este
    insumo, en un conteo abierto ANTES de `before_opened_at` -- "la
    referencia en pantalla es el conteo anterior" (SPEC-NEGOCIO §5.4), nunca
    el stock teórico. Cualquier `scope` cuenta como antecedente: un insumo
    crítico contado el martes es la referencia válida el jueves, sea el
    conteo del jueves `key_items` o `full`."""
    stmt = (
        select(StockCountLine.qty_counted)
        .join(StockCount, StockCount.id == StockCountLine.count_id)
        .where(
            StockCount.store_id == store_id,
            StockCount.id != exclude_count_id,
            StockCountLine.ingredient_id == ingredient_id,
            StockCountLine.was_counted.is_(True),
            StockCount.opened_at < before_opened_at,
        )
        .order_by(StockCount.opened_at.desc(), StockCount.id.desc())
        .limit(1)
    )
    return db.execute(stmt).scalar_one_or_none()


def count_line_out(db: Session, count: StockCount, line: StockCountLine, ingredient: Ingredient) -> CountLineOut:
    previous = _previous_line_qty(
        db,
        store_id=count.store_id,
        ingredient_id=line.ingredient_id,
        before_opened_at=count.opened_at,
        exclude_count_id=count.id,
    )
    return CountLineOut(
        ingredient_id=line.ingredient_id,
        ingredient_name=ingredient.name,
        base_unit=ingredient.base_unit.value,  # type: ignore[arg-type]
        qty_counted=format_qty_base(line.qty_counted) if line.qty_counted is not None else None,
        was_counted=line.was_counted,
        previous_qty_counted=format_qty_base(previous) if previous is not None else None,
    )


def _ingredient_map(db: Session, ingredient_ids: list[int]) -> dict[int, Ingredient]:
    if not ingredient_ids:
        return {}
    rows = db.execute(select(Ingredient).where(Ingredient.id.in_(ingredient_ids))).scalars().all()
    return {i.id: i for i in rows}


def count_detail_out(db: Session, count: StockCount) -> CountDetailOut:
    lines = _count_lines(db, count)
    ingredients = _ingredient_map(db, [l.ingredient_id for l in lines])
    line_outs = [count_line_out(db, count, l, ingredients[l.ingredient_id]) for l in lines if l.ingredient_id in ingredients]
    counted = sum(1 for l in lines if l.was_counted)
    return CountDetailOut(
        id=count.id,
        scope=count.scope.value,  # type: ignore[arg-type]
        status=count.status.value,  # type: ignore[arg-type]
        opened_at=count.opened_at,
        business_date=count.business_date.isoformat(),
        opened_by_employee_id=count.opened_by_employee_id,
        opened_by_employee_name=count.opened_by_employee_name,
        applied_at=count.applied_at,
        applied_by_employee_id=count.applied_by_employee_id,
        applied_by_employee_name=count.applied_by_employee_name,
        lines_total=len(lines),
        lines_counted=counted,
        lines=line_outs,
    )


def count_out(count: StockCount, *, lines_total: int, lines_counted: int) -> CountOut:
    return CountOut(
        id=count.id,
        scope=count.scope.value,  # type: ignore[arg-type]
        status=count.status.value,  # type: ignore[arg-type]
        opened_at=count.opened_at,
        business_date=count.business_date.isoformat(),
        opened_by_employee_id=count.opened_by_employee_id,
        opened_by_employee_name=count.opened_by_employee_name,
        applied_at=count.applied_at,
        applied_by_employee_id=count.applied_by_employee_id,
        applied_by_employee_name=count.applied_by_employee_name,
        lines_total=lines_total,
        lines_counted=lines_counted,
    )


def list_counts(
    db: Session,
    *,
    store: Store,
    scope: StockCountScope | None,
    date_from: date | None,
    date_to: date | None,
) -> list[StockCount]:
    stmt = select(StockCount).where(StockCount.store_id == store.id)
    if scope is not None:
        stmt = stmt.where(StockCount.scope == scope)
    if date_from is not None:
        stmt = stmt.where(StockCount.business_date >= date_from)
    if date_to is not None:
        stmt = stmt.where(StockCount.business_date <= date_to)
    return list(db.execute(stmt.order_by(StockCount.opened_at.desc())).scalars().all())


def save_count_lines(db: Session, *, count: StockCount, data: CountLinesIn) -> CountLinesSaveOut:
    """`PUT /admin/counts/{id}/lines`. **No existe "todo coincide"**: cada
    renglón se escribe individualmente, con su propio `was_counted`; no hay
    ningún parámetro ni atajo acá que marque todos los renglones de una sola
    vez. Un guardado parcial (menos líneas que `lines_total`) es válido y se
    dice en la respuesta (`partial=True`). Un `was_counted=False` entrante
    (un borrador) NUNCA pisa un renglón que ya tenía `was_counted=True` (una
    confirmación anterior) -- se ignora esa línea en particular, en silencio,
    sin abortar el resto del guardado."""
    if count.status != StockCountStatus.OPEN:
        raise AppError(
            code="COUNT_ALREADY_APPLIED",
            message="Este conteo ya se aplicó; no se puede seguir capturando",
            status=409,
        )

    now = clock.now_utc()
    lines_by_ingredient = {l.ingredient_id: l for l in _count_lines(db, count)}
    for line_in in data.lines:
        row = lines_by_ingredient.get(line_in.ingredient_id)
        if row is None:
            raise AppError(
                code="VALIDATION_ERROR",
                message=f"ingredient_id {line_in.ingredient_id}: no está en el alcance de este conteo",
            )
        qty = parse_qty_base(line_in.qty_counted, field="qty_counted")
        if row.was_counted and not line_in.was_counted:
            continue
        row.qty_counted = qty
        row.was_counted = line_in.was_counted
        if line_in.was_counted:
            row.counted_at = now
    db.flush()

    lines = _count_lines(db, count)
    ingredients = _ingredient_map(db, [l.ingredient_id for l in lines])
    line_outs = [count_line_out(db, count, l, ingredients[l.ingredient_id]) for l in lines if l.ingredient_id in ingredients]
    counted = sum(1 for l in lines if l.was_counted)
    return CountLinesSaveOut(lines=line_outs, lines_counted=counted, lines_total=len(lines), partial=counted < len(lines))


def apply_count(db: Session, *, count: StockCount, store: Store, actor: Actor, authorizer_pin: str) -> CountApplyOut:
    """`POST /admin/counts/{id}/apply`. **El test que más importa de la
    misión**: aplica `stock = contado + (entradas - salidas DESDE EL
    INSTANTE DEL CONTEO)`, nunca desde el instante de aplicar.

    La cuenta se resuelve con `hooks.current_stock(..., as_of=count.
    opened_at)` en vez de sumar entradas/salidas a mano, porque los dos
    caminos dan el MISMO resultado por álgebra (y este evita reimplementar
    la suma): si `target = contado + movimientos_desde_el_conteo` y
    `ahora = stock_al_conteo + movimientos_desde_el_conteo` (el libro es
    aditivo), entonces `ajuste = target - ahora = contado -
    stock_al_conteo`. Los movimientos que pasaron entre el conteo y el
    `apply` se CANCELAN en el álgebra -- por eso un conteo de las 13:07
    aplicado a las 15:42 no puede "inventar un faltante" con lo que vendió
    el restaurante en el medio.

    `409 COUNT_ALREADY_APPLIED` si ya estaba `status="applied"` -- funciona
    tanto si el reintento llega con la MISMA `Idempotency-Key` (la capa de
    idempotencia lo resuelve con un replay antes de llegar acá) como con una
    distinta (esta guarda de negocio corta antes de tocar el libro)."""
    if count.status == StockCountStatus.APPLIED:
        raise AppError(
            code="COUNT_ALREADY_APPLIED", message="Este conteo ya se aplicó; no se puede aplicar dos veces", status=409
        )

    authorizer = _verify_self_authorizer(db, actor=actor, pin=authorizer_pin)
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

    scope_label = "crítico" if count.scope == StockCountScope.KEY_ITEMS else "completo"
    out_lines: list[CountApplyLineOut] = []
    for line in _count_lines(db, count):
        if not line.was_counted or line.qty_counted is None:
            continue
        ingredient = hooks.get_ingredient(db, store_id=store.id, ingredient_id=line.ingredient_id)
        if ingredient is None:
            continue

        stock_at_count_instant = hooks.current_stock(
            db, store_id=store.id, ingredient_id=ingredient.id, as_of=count.opened_at
        )
        stock_now = hooks.current_stock(db, store_id=store.id, ingredient_id=ingredient.id)
        adjustment = line.qty_counted - stock_at_count_instant

        if adjustment != 0:
            cost_micros, cost_source = hooks.resolve_ingredient_cost(db, ingredient)
            hooks.record_movement(
                db,
                organization_id=store.organization_id,
                store_id=store.id,
                ingredient_id=ingredient.id,
                qty_base=adjustment,
                cause=MovementCause.COUNT_ADJUSTMENT,
                cost_micros=cost_micros,
                cost_source=cost_source,
                actor=authorizer_actor,
                business_date=business_date,
                at=now,
                ref_type="stock_count",
                ref_id=count.id,
                note=f"Conteo #{count.id} ({scope_label})",
            )

        out_lines.append(
            CountApplyLineOut(
                ingredient_id=ingredient.id,
                ingredient_name=ingredient.name,
                qty_counted=format_qty_base(line.qty_counted),
                stock_before=format_qty_base(stock_now),
                adjustment=format_qty_base(adjustment),
                stock_after=format_qty_base(stock_now + adjustment),
            )
        )

    count.status = StockCountStatus.APPLIED
    count.applied_at = now
    count.applied_by_employee_id = authorizer.id
    count.applied_by_employee_name = authorizer.name
    db.flush()

    return CountApplyOut(
        id=count.id, applied_at=now, applied_by_employee_id=authorizer.id, applied_by_employee_name=authorizer.name,
        lines=out_lines,
    )


# ---------------------------------------------------------------------------
# Varianza (SPEC-NEGOCIO §5.4).
# ---------------------------------------------------------------------------


def _previous_applied_count(
    db: Session, *, store_id: int, before_opened_at: datetime, exclude_count_id: int
) -> StockCount | None:
    stmt = (
        select(StockCount)
        .where(
            StockCount.store_id == store_id,
            StockCount.status == StockCountStatus.APPLIED,
            StockCount.id != exclude_count_id,
            StockCount.opened_at < before_opened_at,
        )
        .order_by(StockCount.opened_at.desc(), StockCount.id.desc())
        .limit(1)
    )
    return db.execute(stmt).scalars().first()


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


def _variance_level(
    *, pct_bp: int | None, theoretical: int, variance_qty: int, settings: StoreInventorySettings
) -> str:
    """Semáforo de varianza. Con `theoretical > 0`, `pct_bp` (ya calculado
    por el llamador) manda contra los umbrales configurados de sede.

    RONDA 2, hallazgo H-5: con `theoretical == 0` el porcentaje es
    matemáticamente indefinido (`variance_pct_bp` sigue siendo `None` -- no
    se inventa un `100 %`), pero eso NO puede pintarse siempre verde: si
    `variance_qty` también es `0` no pasó nada (verde); si es POSITIVO
    (`variance_qty = uso_real - uso_teórico`, `schemas.VarianceRowOut.
    variance_qty`: "positivo = se usó más de lo esperado") desapareció stock
    sin una sola venta ni producción que lo explique -- fuga pura -- y eso es
    ROJO aunque no haya con qué dividir; si es NEGATIVO (se contó MÁS stock
    del que el libro explica: opening + inflow < closing) es un error de
    conteo del otro signo, AMARILLO.

    **Nota sobre el signo, para quien audite este hallazgo contra el mandato
    original**: el mandato describe la rama roja como "`variance_qty < 0`" y
    la amarilla como "`variance_qty > 0`", con el mismo ejemplo verbal
    ("faltante" = rojo) que acá. Ese mapeo de signo choca con la convención
    YA establecida y YA probada en la ronda 1
    (`schemas.VarianceRowOut.variance_qty`: "positivo = se usó más de lo
    esperado"; `test_variance_identity_closes_with_a_hand_built_case`: 3 kg
    "de más consumidos que lo esperado" = `variance_qty=+3`): con esa
    convención, un faltante físico (opening 400, sin ventas, closing 0) da
    `real_usage=400`, `variance_qty=+400` -- POSITIVO, nunca negativo. Un
    faltante no puede dar `variance_qty < 0` bajo esta fórmula sin importar
    los números que se elijan. Implementé el signo que hace cierta la
    ORACIÓN del mandato ("400 unidades faltantes ... salen en rojo") en vez
    de su fórmula literal, porque las dos no pueden ser ciertas a la vez con
    la convención ya publicada y ya probada -- cambiar la convención de
    `variance_qty` en la ronda 2 habría roto el test de la ronda 1 y el
    contrato ya publicado del campo. Documentado también en el entregable,
    § Ronda 2, para que el Maestro lo revise."""
    if theoretical == 0:
        if variance_qty == 0:
            return "green"
        return "red" if variance_qty > 0 else "yellow"
    if pct_bp is None:
        return "green"
    if pct_bp < settings.variance_yellow_threshold_bp:
        return "green"
    if pct_bp < settings.variance_red_threshold_bp:
        return "yellow"
    return "red"


def variance_report(db: Session, *, store: Store, count_id: int) -> VarianceOut:
    """`GET /admin/variance?count_id`. Identidad `inicial + entradas - final
    = uso real`, contra el uso teórico que ya está en el libro
    (`cause=SALE` + `cause=PRODUCTION_OUT`, SPEC-NEGOCIO §5.3). `entradas`
    EXCLUYE `count_adjustment` a propósito: el ajuste del conteo ANTERIOR ya
    quedó absorbido en `inicial` (que es el valor CONTADO, no el del libro),
    así que sumarlo de nuevo acá lo contaría dos veces."""
    count = count_or_404(db, store, count_id)
    settings = get_inventory_settings(db, store)
    if count.status != StockCountStatus.APPLIED:
        raise AppError(
            code="COUNT_NOT_APPLIED", message="La varianza sólo se calcula sobre un conteo ya aplicado"
        )

    previous = _previous_applied_count(db, store_id=store.id, before_opened_at=count.opened_at, exclude_count_id=count.id)
    if previous is None:
        return VarianceOut(
            count_id=count.id,
            opening_count_id=None,
            window_from=None,
            window_to=count.opened_at,
            available=False,
            reason="No hay un conteo anterior aplicado contra el cual comparar",
            rows=[],
            yellow_threshold_bp=settings.variance_yellow_threshold_bp,
            red_threshold_bp=settings.variance_red_threshold_bp,
        )

    previous_lines = {
        l.ingredient_id: l.qty_counted
        for l in _count_lines(db, previous)
        if l.was_counted and l.qty_counted is not None
    }
    current_lines = {
        l.ingredient_id: l.qty_counted for l in _count_lines(db, count) if l.was_counted and l.qty_counted is not None
    }
    ingredient_ids = sorted(set(previous_lines) & set(current_lines))

    rows: list[VarianceRowOut] = []
    for ing_id in ingredient_ids:
        ingredient = hooks.get_ingredient(db, store_id=store.id, ingredient_id=ing_id)
        if ingredient is None:
            continue
        opening = previous_lines[ing_id]
        closing = current_lines[ing_id]
        inflow = _movement_sum(
            db, store_id=store.id, ingredient_id=ing_id, window_from=previous.opened_at, window_to=count.opened_at,
            positive=True, exclude_causes=(MovementCause.COUNT_ADJUSTMENT,),
        )
        real_usage = opening + inflow - closing
        theoretical = -_movement_sum(
            db, store_id=store.id, ingredient_id=ing_id, window_from=previous.opened_at, window_to=count.opened_at,
            positive=False, causes=(MovementCause.SALE, MovementCause.PRODUCTION_OUT),
        )
        variance_qty = real_usage - theoretical

        cost_micros, cost_source = hooks.resolve_ingredient_cost(db, ingredient)
        variance_value = micros_to_pesos(line_cost_micros(variance_qty, cost_micros)) if cost_micros is not None else None

        if theoretical > 0:
            numerator = abs(variance_qty) * 10000
            variance_pct_bp: int | None = (numerator + theoretical // 2) // theoretical
        else:
            variance_pct_bp = None
        level = _variance_level(
            pct_bp=variance_pct_bp, theoretical=theoretical, variance_qty=variance_qty, settings=settings
        )

        rows.append(
            VarianceRowOut(
                ingredient_id=ing_id,
                ingredient_name=ingredient.name,
                base_unit=ingredient.base_unit.value,  # type: ignore[arg-type]
                opening_qty=format_qty_base(opening),
                inflow_qty=format_qty_base(inflow),
                closing_qty=format_qty_base(closing),
                real_usage_qty=format_qty_base(real_usage),
                theoretical_usage_qty=format_qty_base(theoretical),
                variance_qty=format_qty_base(variance_qty),
                variance_value=variance_value,
                cost_source=cost_source.value,  # type: ignore[arg-type]
                variance_pct_bp=variance_pct_bp,
                level=level,  # type: ignore[arg-type]
            )
        )

    return VarianceOut(
        count_id=count.id,
        opening_count_id=previous.id,
        window_from=previous.opened_at,
        window_to=count.opened_at,
        available=True,
        reason=None,
        rows=rows,
        yellow_threshold_bp=settings.variance_yellow_threshold_bp,
        red_threshold_bp=settings.variance_red_threshold_bp,
    )


# ---------------------------------------------------------------------------
# Food cost real (SPEC-NEGOCIO §4.1/§5.4).
# ---------------------------------------------------------------------------


def _sale_document_types() -> tuple[Any, ...]:
    from app.fiscal.models import FiscalDocumentType

    # Mismo criterio que `app.reports.service.SALE_DOCUMENT_TYPES`
    # (documentos que representan una venta real cobrada; las notas quedan
    # fuera). Se declara acá en vez de importarlo de `app.reports` para no
    # acoplar `inventory` a un módulo que otro agente edita en paralelo en
    # este mismo pedido -- son dos dominios leyendo la misma tabla con el
    # mismo criterio documentado, no una segunda fuente de verdad sobre CÓMO
    # se calcula (el criterio en sí -- qué tipos de documento son "venta" --
    # está fijado por SPEC-NEGOCIO §8.2, no inventado acá).
    return (
        FiscalDocumentType.POS_EQUIVALENT,
        FiscalDocumentType.INVOICE,
        FiscalDocumentType.INTERNAL_RECEIPT,
    )


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


def _two_most_recent_consecutive_full_counts(
    db: Session, *, store: Store, date_from: date, date_to: date
) -> tuple[StockCount, StockCount] | None:
    stmt = (
        select(StockCount)
        .where(
            StockCount.store_id == store.id,
            StockCount.scope == StockCountScope.FULL,
            StockCount.status == StockCountStatus.APPLIED,
            StockCount.business_date >= date_from,
            StockCount.business_date <= date_to,
        )
        .order_by(StockCount.opened_at.asc())
    )
    counts = list(db.execute(stmt).scalars().all())
    if len(counts) < 2:
        return None
    return counts[-2], counts[-1]


def _count_inventory_value(db: Session, *, store: Store, count: StockCount) -> int:
    """Valoriza, en pesos, los renglones CONTADOS de un conteo al costo
    resuelto de HOY (`resolve_ingredient_cost`). No revalora una VENTA
    pasada (prohibido por `AGENTS.md`): esto valoriza un CONTEO, que es una
    foto de stock, no una venta -- el snapshot que la spec protege es el de
    `order_items`, no éste."""
    total_micros = 0
    for line in _count_lines(db, count):
        if not line.was_counted or line.qty_counted is None:
            continue
        ingredient = hooks.get_ingredient(db, store_id=store.id, ingredient_id=line.ingredient_id)
        if ingredient is None:
            continue
        cost_micros, _source = hooks.resolve_ingredient_cost(db, ingredient)
        if cost_micros is None:
            continue
        total_micros += line_cost_micros(line.qty_counted, cost_micros)
    return micros_to_pesos(total_micros)


def _purchases_value(db: Session, *, store: Store, window_from: datetime, window_to: datetime) -> int:
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


def food_cost_report(db: Session, *, store: Store, date_from: date, date_to: date) -> FoodCostOut:
    """`GET /admin/food-cost?from&to`: `(inicial + compras - final) ÷ ventas
    netas`, **sólo entre dos conteos completos consecutivos** dentro del
    rango. Sin ellos, o con "inventario no confiable" (`hooks.
    inventory_staleness` -- RONDA 2, H-4: misma fuente que `control_health`,
    ninguno de los dos vuelve a sumar días por su cuenta), `null` **con
    motivo** -- jamás `0`."""
    staleness = hooks.inventory_staleness(db, store_id=store.id, cutoff_hour=store.cutoff_hour)
    if staleness.unreliable:
        if staleness.days_since_last_full_count is None:
            reason = (
                "Inventario no confiable: nunca se aplicó un conteo completo "
                f"(hacen falta uno hace menos de {staleness.stale_days} días)"
            )
        else:
            reason = (
                f"Inventario no confiable: {staleness.days_since_last_full_count} días desde el último "
                f"conteo completo aplicado (más de {staleness.stale_days})"
            )
        return FoodCostOut(
            available=False,
            reason=reason,
            opening_count_id=None, closing_count_id=None, window_from=None, window_to=None,
            opening_value=None, purchases_value=None, closing_value=None, net_sales=None, pct_bp=None,
        )

    pair = _two_most_recent_consecutive_full_counts(db, store=store, date_from=date_from, date_to=date_to)
    if pair is None:
        return FoodCostOut(
            available=False,
            reason="Hacen falta dos conteos completos aplicados y consecutivos en el período para calcular el food cost real",
            opening_count_id=None, closing_count_id=None, window_from=None, window_to=None,
            opening_value=None, purchases_value=None, closing_value=None, net_sales=None, pct_bp=None,
        )
    opening_count, closing_count = pair

    opening_value = _count_inventory_value(db, store=store, count=opening_count)
    closing_value = _count_inventory_value(db, store=store, count=closing_count)
    purchases_value = _purchases_value(db, store=store, window_from=opening_count.opened_at, window_to=closing_count.opened_at)
    net_sales = _net_sales(db, store_id=store.id, date_from=opening_count.business_date, date_to=closing_count.business_date)

    window_from = opening_count.opened_at.isoformat()
    window_to = closing_count.opened_at.isoformat()

    if net_sales <= 0:
        return FoodCostOut(
            available=False,
            reason="No hay ventas netas registradas en el período entre los dos conteos",
            opening_count_id=opening_count.id, closing_count_id=closing_count.id,
            window_from=window_from, window_to=window_to,
            opening_value=opening_value, purchases_value=purchases_value, closing_value=closing_value,
            net_sales=net_sales, pct_bp=None,
        )

    food_cost_pesos = opening_value + purchases_value - closing_value
    pct_bp = (abs(food_cost_pesos) * 10000 + net_sales // 2) // net_sales
    if food_cost_pesos < 0:
        pct_bp = -pct_bp

    return FoodCostOut(
        available=True,
        reason=None,
        opening_count_id=opening_count.id, closing_count_id=closing_count.id,
        window_from=window_from, window_to=window_to,
        opening_value=opening_value, purchases_value=purchases_value, closing_value=closing_value,
        net_sales=net_sales, pct_bp=pct_bp,
    )


# ---------------------------------------------------------------------------
# Salud del control (SPEC-NEGOCIO §5.4/§9.3).
# ---------------------------------------------------------------------------


def _reception_invoice_ratio(db: Session, *, store: Store, date_from: date, date_to: date) -> tuple[int | None, str | None]:
    """Lee `app.purchases.hooks.reception_invoice_ratio` con `find_spec_safe`
    -- NUNCA `importlib.util.find_spec` crudo (`app.purchases` puede no
    tener ni carpeta en un checkout que no incluya ese territorio). Firma
    publicada por `purchases` (`app/purchases/hooks.py`, confirmada contra
    su código, no asumida): `(db, *, store_id, date_from, date_to) ->
    tuple[int, int]` = `(con_factura, total)` -- una razón en dos enteros,
    no un porcentaje ya calculado (mismo principio de "una sola
    matemática": el `round`/la escala los hace quien PUBLICA el número, acá,
    no cada consumidor por su cuenta). `total == 0` es "sin recepciones en
    el período", `null` con motivo -- nunca `0`."""
    if find_spec_safe("app.purchases.hooks") is None:
        return None, "compras (purchases) todavía no está disponible en este árbol"
    module = importlib.import_module("app.purchases.hooks")
    fn = getattr(module, "reception_invoice_ratio", None)
    if not callable(fn):
        return None, "compras (purchases) todavía no está disponible en este árbol"
    try:
        with_invoice, total = fn(db, store_id=store.id, date_from=date_from, date_to=date_to)
    except TypeError:
        logger.warning("reception_invoice_ratio no acepta la firma esperada (store_id, date_from, date_to)")
        return None, "el porcentaje de recepciones con factura no se pudo calcular en este momento"
    if total <= 0:
        return None, "sin recepciones en el período"
    ratio_bp = (with_invoice * 10000 + total // 2) // total
    return ratio_bp, None


def _batch_preps_produced_ratio(
    db: Session, *, store: Store, week_start: date, week_end: date
) -> tuple[int | None, str | None]:
    if find_spec_safe("app.recipes.models") is None:
        return None, "recetas (recipes) todavía no está disponible en este árbol"
    if not features.is_enabled(db, store.organization_id, store.id, "catalog.preps"):
        return None, 'la función "catalog.preps" está apagada'

    from app.recipes.models import PrepBatch, PrepMode, Preparation

    total = db.execute(
        select(func.count(Preparation.id)).where(
            Preparation.store_id == store.id, Preparation.active.is_(True), Preparation.mode == PrepMode.BATCH
        )
    ).scalar_one()
    if total == 0:
        return None, "no hay preparaciones activas en modo lote"

    produced = db.execute(
        select(func.count(func.distinct(PrepBatch.preparation_id))).where(
            PrepBatch.store_id == store.id,
            PrepBatch.business_date >= week_start,
            PrepBatch.business_date <= week_end,
        )
    ).scalar_one()
    ratio_bp = (produced * 10000 + total // 2) // total
    return ratio_bp, None


def control_health(db: Session, *, store: Store) -> ControlHealthOut:
    """`GET /admin/control-health`. `inventory_unreliable` es la señal que
    apaga el food cost real -- `hooks.inventory_staleness` es la ÚNICA
    fuente de esa cuenta (RONDA 2, H-4): `food_cost_report` lee la MISMA
    función, ninguno de los dos vuelve a sumar días por su cuenta."""
    today = tz.today_business_date(store.cutoff_hour)
    week_start = today - timedelta(days=6)

    staleness = hooks.inventory_staleness(db, store_id=store.id, cutoff_hour=store.cutoff_hour)
    last_full = hooks.last_applied_full_count_at(db, store_id=store.id)
    days_since = staleness.days_since_last_full_count
    unreliable = staleness.unreliable

    invoice_ratio, invoice_reason = _reception_invoice_ratio(db, store=store, date_from=week_start, date_to=today)
    batch_ratio, batch_reason = _batch_preps_produced_ratio(db, store=store, week_start=week_start, week_end=today)

    waste_count = db.execute(
        select(func.count(Waste.id)).where(
            Waste.store_id == store.id, Waste.business_date >= week_start, Waste.business_date <= today
        )
    ).scalar_one()

    return ControlHealthOut(
        days_since_full_count=days_since,
        last_full_count_at=last_full,
        inventory_unreliable=unreliable,
        reception_invoice_ratio_bp=invoice_ratio,
        reception_invoice_ratio_reason=invoice_reason,
        batch_preps_produced_ratio_bp=batch_ratio,
        batch_preps_produced_reason=batch_reason,
        waste_entries_this_week=int(waste_count),
    )


# ---------------------------------------------------------------------------
# NOTA (ronda 2, H-2): `order_consumption` (la fusión de lectura de §5.3)
# vivió acá en la ronda 1 y se SACÓ por decisión del Maestro -- ver la nota
# equivalente en `app.inventory.schemas`, sección de arriba de
# `InventorySettingsOut`, y `outputs-2b/backend-inventario-espejo.md § Ronda
# 2` para el motivo completo.
# ---------------------------------------------------------------------------
