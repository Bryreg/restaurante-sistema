"""Lógica de la carta plana: CRUD con aislamiento por organización/sede,
`schedule` de combos, agotados y contador, y el ensamblado de `GET /catalog`.

Ningún helper de este módulo calcula plata ni construye un esquema con
`cost`/`margin`/`unit_cost` — no existen hasta `catalog.recipes` (fase 2).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.deps import Actor
from app.catalog.models import (
    TAX_CODE_VALUES,
    Category,
    Combo,
    ComboGroup,
    ComboOption,
    ModifierGroup,
    ModifierOption,
    Product,
)
from app.catalog.schemas import (
    CatalogComboOut,
    CatalogOut,
    CatalogProductOut,
    CategoryIn,
    CategoryOut,
    CategoryUpdateIn,
    ComboAdminOut,
    ComboGroupAdminOut,
    ComboGroupIn,
    ComboGroupOut,
    ComboIn,
    ComboOptionAdminOut,
    ComboOptionOut,
    ComboUpdateIn,
    ModifierGroupIn,
    ModifierGroupOut,
    ModifierGroupUpdateIn,
    ModifierOptionOut,
    ProductAdminOut,
    ProductIn,
    ProductPricesRawOut,
    ProductPricesResolvedOut,
    ProductUpdateIn,
)
from app.core import clock, tz
from app.core.errors import AppError, ConflictError, NotFoundError
from app.notifications.service import notify
from app.stores import service as stores_service

# ---------------------------------------------------------------------------
# Aislamiento por organización y sede.
#
# Toda tabla de este módulo lleva `organization_id` y `store_id` propios (no
# hace falta un join a `stores` para el 404): un id de otra organización, o
# de otra sede cuando quien pregunta es un dispositivo (que sólo puede ver la
# suya), responde siempre `NotFoundError`, nunca `403` (no delata que existe).
# ---------------------------------------------------------------------------


def _scoped_or_404(row: Any, actor: Actor, *, message: str) -> Any:
    if row is None or row.organization_id != actor.organization_id:
        raise NotFoundError(message)
    if actor.kind == "device" and row.store_id != actor.store_id:
        raise NotFoundError(message)
    return row


def category_or_404(db: Session, actor: Actor, category_id: int) -> Category:
    return _scoped_or_404(db.get(Category, category_id), actor, message="La categoría no existe")


def product_or_404(db: Session, actor: Actor, product_id: int) -> Product:
    return _scoped_or_404(db.get(Product, product_id), actor, message="El producto no existe")


def modifier_group_or_404(db: Session, actor: Actor, group_id: int) -> ModifierGroup:
    return _scoped_or_404(
        db.get(ModifierGroup, group_id), actor, message="El grupo de modificadores no existe"
    )


def modifier_option_or_404(db: Session, actor: Actor, option_id: int) -> ModifierOption:
    return _scoped_or_404(
        db.get(ModifierOption, option_id), actor, message="La opción de modificador no existe"
    )


def combo_or_404(db: Session, actor: Actor, combo_id: int) -> Combo:
    return _scoped_or_404(db.get(Combo, combo_id), actor, message="El combo no existe")


def combo_option_or_404(db: Session, actor: Actor, option_id: int) -> ComboOption:
    return _scoped_or_404(db.get(ComboOption, option_id), actor, message="La opción del combo no existe")


# ---------------------------------------------------------------------------
# Categorías.
# ---------------------------------------------------------------------------


def category_out(category: Category) -> CategoryOut:
    return CategoryOut(
        id=category.id,
        name=category.name,
        sort_order=category.sort_order,
        default_course=category.default_course,
        default_station=category.default_station,
        active=category.active,
    )


def create_category(db: Session, *, organization_id: int, store_id: int, data: CategoryIn) -> Category:
    row = Category(
        organization_id=organization_id,
        store_id=store_id,
        name=data.name,
        sort_order=data.sort_order,
        default_course=data.default_course,
        default_station=data.default_station,
        active=True,
    )
    db.add(row)
    db.flush()
    return row


def update_category(db: Session, category: Category, data: CategoryUpdateIn) -> Category:
    if data.name is not None:
        category.name = data.name
    if data.sort_order is not None:
        category.sort_order = data.sort_order
    if data.default_course is not None:
        category.default_course = data.default_course
    if data.default_station is not None:
        category.default_station = data.default_station
    if data.active is not None:
        category.active = data.active
    db.flush()
    return category


# ---------------------------------------------------------------------------
# Productos.
# ---------------------------------------------------------------------------


def resolve_tax_code(db: Session, store_id: int, tax_code: str | None) -> str:
    """`tax_code` explícito, o el `default_tax` de la fiscal vigente de la
    sede; si todavía no hay fiscal configurada, `inc_8` (régimen general del
    supuesto declarado en `docs/SPEC-NEGOCIO.md §1.1`)."""
    if tax_code is not None:
        return tax_code
    fiscal = stores_service.current_fiscal(db, store_id)
    return fiscal.default_tax if fiscal is not None else TAX_CODE_VALUES[0]


def _product_prices_raw(product: Product) -> ProductPricesRawOut:
    return ProductPricesRawOut(
        dine_in=product.price_dine_in,
        takeout=product.price_takeout,
        delivery=product.price_delivery,
        platform=product.price_platform,
    )


def _product_prices_resolved(product: Product) -> ProductPricesResolvedOut:
    return ProductPricesResolvedOut(
        dine_in=product.price_dine_in,
        takeout=product.price_takeout if product.price_takeout is not None else product.price_dine_in,
        delivery=product.price_delivery if product.price_delivery is not None else product.price_dine_in,
        platform=product.price_platform if product.price_platform is not None else product.price_dine_in,
    )


def modifier_groups_out(db: Session, product_id: int) -> list[ModifierGroupOut]:
    groups = (
        db.execute(
            select(ModifierGroup)
            .where(ModifierGroup.product_id == product_id)
            .order_by(ModifierGroup.sort_order, ModifierGroup.id)
        )
        .scalars()
        .all()
    )
    out: list[ModifierGroupOut] = []
    for group in groups:
        options = (
            db.execute(
                select(ModifierOption)
                .where(ModifierOption.modifier_group_id == group.id)
                .order_by(ModifierOption.sort_order, ModifierOption.id)
            )
            .scalars()
            .all()
        )
        out.append(
            ModifierGroupOut(
                id=group.id,
                product_id=group.product_id,
                name=group.name,
                required=group.required,
                min=group.min,
                max=group.max,
                sort_order=group.sort_order,
                options=[
                    ModifierOptionOut(
                        id=o.id, name=o.name, price_delta=o.price_delta, available=o.available
                    )
                    for o in options
                ],
            )
        )
    return out


def product_admin_out(db: Session, product: Product) -> ProductAdminOut:
    return ProductAdminOut(
        id=product.id,
        category_id=product.category_id,
        name=product.name,
        description=product.description,
        station=product.station,
        default_course=product.default_course,
        prices=_product_prices_raw(product),
        tax_code=product.tax_code,  # type: ignore[arg-type]
        active=product.active,
        available=product.available,
        daily_count=product.daily_count,
        daily_remaining=product.daily_remaining,
        is_delivery_fee=product.is_delivery_fee,
        modifier_groups=modifier_groups_out(db, product.id),
    )


def _assert_single_delivery_fee(db: Session, store_id: int, *, exclude_product_id: int | None = None) -> None:
    """A lo sumo un producto `is_delivery_fee` ACTIVO por sede (pedido 2c,
    §4.3): `app.orders.service.create_order` busca uno solo
    (`get_delivery_fee_product`) y no tiene con qué desempatar dos."""
    stmt = select(func.count()).select_from(Product).where(
        Product.store_id == store_id,
        Product.is_delivery_fee.is_(True),
        Product.active.is_(True),
    )
    if exclude_product_id is not None:
        stmt = stmt.where(Product.id != exclude_product_id)
    if db.execute(stmt).scalar_one() > 0:
        raise ConflictError(
            "Ya hay un producto marcado como cargo de domicilio para esta sede: desactivalo antes de crear otro",
            code="DELIVERY_FEE_ALREADY_CONFIGURED",
        )


def get_delivery_fee_product(db: Session, store_id: int) -> Product | None:
    """El producto real (§4.3) que `app.orders.service.create_order` agrega
    como línea al crear una comanda `delivery`. `None` si la sede todavía no
    configuró uno — el llamador corta con `400 DELIVERY_FEE_NOT_CONFIGURED`,
    nunca inventa un monto."""
    return (
        db.execute(
            select(Product).where(
                Product.store_id == store_id,
                Product.is_delivery_fee.is_(True),
                Product.active.is_(True),
            )
        )
        .scalars()
        .first()
    )


def create_product(db: Session, *, organization_id: int, store_id: int, data: ProductIn) -> Product:
    category = db.get(Category, data.category_id)
    if category is None or category.organization_id != organization_id:
        raise NotFoundError("La categoría no existe")
    if category.store_id != store_id:
        raise NotFoundError("La categoría no existe en esta sede")
    if data.is_delivery_fee:
        _assert_single_delivery_fee(db, store_id)

    now = clock.now_utc()
    tax_code = resolve_tax_code(db, store_id, data.tax_code)
    daily_count = data.daily_count
    row = Product(
        organization_id=organization_id,
        store_id=store_id,
        category_id=category.id,
        name=data.name,
        description=data.description,
        station=data.station if data.station is not None else category.default_station,
        default_course=data.default_course if data.default_course is not None else category.default_course,
        price_dine_in=data.prices.dine_in,
        price_takeout=data.prices.takeout,
        price_delivery=data.prices.delivery,
        price_platform=data.prices.platform,
        tax_code=tax_code,
        is_delivery_fee=data.is_delivery_fee,
        active=True,
        available=True,
        daily_count=daily_count,
        daily_remaining=daily_count,
        unavailable_by_employee_id=None,
        unavailable_by_employee_name=None,
        unavailable_at=None,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.flush()
    return row


def update_product(db: Session, product: Product, data: ProductUpdateIn) -> Product:
    if data.category_id is not None:
        category = db.get(Category, data.category_id)
        if category is None or category.organization_id != product.organization_id:
            raise NotFoundError("La categoría no existe")
        if category.store_id != product.store_id:
            raise NotFoundError("La categoría no existe en esta sede")
        product.category_id = category.id
    if data.name is not None:
        product.name = data.name
    if data.description is not None:
        product.description = data.description
    if data.station is not None:
        product.station = data.station
    if data.default_course is not None:
        product.default_course = data.default_course
    if data.prices is not None:
        product.price_dine_in = data.prices.dine_in
        product.price_takeout = data.prices.takeout
        product.price_delivery = data.prices.delivery
        product.price_platform = data.prices.platform
    if data.tax_code is not None:
        product.tax_code = data.tax_code
    if data.active is not None:
        product.active = data.active
    if data.is_delivery_fee is not None:
        product.is_delivery_fee = data.is_delivery_fee
    if product.is_delivery_fee and product.active:
        _assert_single_delivery_fee(db, product.store_id, exclude_product_id=product.id)
    product.updated_at = clock.now_utc()
    db.flush()
    return product


def set_product_availability(
    db: Session, product: Product, *, available: bool, daily_count: int | None, actor: Actor
) -> Product:
    product.available = available
    if daily_count is not None:
        product.daily_count = daily_count
        product.daily_remaining = daily_count
    if available:
        product.unavailable_by_employee_id = None
        product.unavailable_by_employee_name = None
        product.unavailable_at = None
    else:
        product.unavailable_by_employee_id = actor.employee_id
        product.unavailable_by_employee_name = actor.employee_name
        product.unavailable_at = clock.now_utc()
        notify(
            db,
            organization_id=product.organization_id,
            store_id=product.store_id,
            type="product_unavailable",
            level="info",
            title=f'"{product.name}" agotado',
            body=(
                f'{actor.employee_name or "Alguien"} marcó "{product.name}" sin disponibilidad.'
            ),
            payload={"product_id": product.id},
            dedupe_key=f"product_unavailable:{product.id}",
        )
    db.flush()
    return product


# ---------------------------------------------------------------------------
# Grupos y opciones de modificadores.
# ---------------------------------------------------------------------------


def modifier_group_out(db: Session, group: ModifierGroup) -> ModifierGroupOut:
    options = (
        db.execute(
            select(ModifierOption)
            .where(ModifierOption.modifier_group_id == group.id)
            .order_by(ModifierOption.sort_order, ModifierOption.id)
        )
        .scalars()
        .all()
    )
    return ModifierGroupOut(
        id=group.id,
        product_id=group.product_id,
        name=group.name,
        required=group.required,
        min=group.min,
        max=group.max,
        sort_order=group.sort_order,
        options=[
            ModifierOptionOut(id=o.id, name=o.name, price_delta=o.price_delta, available=o.available)
            for o in options
        ],
    )


def _upsert_modifier_options(db: Session, group: ModifierGroup, options_in: list[Any]) -> None:
    """Crea o actualiza (por `id`) las opciones que vienen en la lista.

    No borra ni desactiva las que quedaron afuera: en 1a no hay un campo de
    baja lógica en `ModifierOption` (su `available` significa "agotado hoy",
    no "existe"); quitar opciones de un grupo queda para una iteración
    posterior (declarado en `gaps`).
    """
    existing = {
        o.id: o
        for o in db.execute(
            select(ModifierOption).where(ModifierOption.modifier_group_id == group.id)
        ).scalars().all()
    }
    for opt_in in options_in:
        if opt_in.id is not None and opt_in.id in existing:
            row = existing[opt_in.id]
            row.name = opt_in.name
            row.price_delta = opt_in.price_delta
        else:
            db.add(
                ModifierOption(
                    organization_id=group.organization_id,
                    store_id=group.store_id,
                    modifier_group_id=group.id,
                    name=opt_in.name,
                    price_delta=opt_in.price_delta,
                    available=True,
                )
            )
    db.flush()


def create_modifier_group(db: Session, *, product: Product, data: ModifierGroupIn) -> ModifierGroup:
    group = ModifierGroup(
        organization_id=product.organization_id,
        store_id=product.store_id,
        product_id=product.id,
        name=data.name,
        required=data.required,
        min=data.min,
        max=data.max,
        sort_order=data.sort_order,
    )
    db.add(group)
    db.flush()
    _upsert_modifier_options(db, group, data.options)
    return group


def update_modifier_group(db: Session, group: ModifierGroup, data: ModifierGroupUpdateIn) -> ModifierGroup:
    if data.name is not None:
        group.name = data.name
    if data.required is not None:
        group.required = data.required
    if data.min is not None:
        group.min = data.min
    if data.max is not None:
        group.max = data.max
    if data.sort_order is not None:
        group.sort_order = data.sort_order
    db.flush()
    if data.options is not None:
        _upsert_modifier_options(db, group, data.options)
    return group


def set_modifier_option_availability(
    db: Session, option: ModifierOption, *, available: bool, actor: Actor
) -> ModifierOption:
    option.available = available
    if available:
        option.unavailable_by_employee_id = None
        option.unavailable_by_employee_name = None
        option.unavailable_at = None
    else:
        option.unavailable_by_employee_id = actor.employee_id
        option.unavailable_by_employee_name = actor.employee_name
        option.unavailable_at = clock.now_utc()
    db.flush()
    return option


# ---------------------------------------------------------------------------
# Combos y menú del día.
# ---------------------------------------------------------------------------


def _is_hhmm(value: Any) -> bool:
    if not isinstance(value, str) or value.count(":") != 1:
        return False
    hour_str, minute_str = value.split(":")
    if not (hour_str.isdigit() and minute_str.isdigit()):
        return False
    hour, minute = int(hour_str), int(minute_str)
    return 0 <= hour <= 23 and 0 <= minute <= 59


def validate_schedule(raw: dict[str, Any]) -> dict[str, Any]:
    """Valida `{"days": [0..6], "from": "HH:MM", "to": "HH:MM"}`. `days` usa
    la convención de `date.weekday()`: 0 = lunes ... 6 = domingo."""
    days = raw.get("days")
    start = raw.get("from")
    end = raw.get("to")
    if (
        not isinstance(days, list)
        or not days
        or any(not isinstance(d, int) or isinstance(d, bool) or d < 0 or d > 6 for d in days)
    ):
        raise AppError(
            code="VALIDATION_ERROR",
            message="schedule.days: lista de enteros 0 (lunes) a 6 (domingo)",
        )
    if not _is_hhmm(start) or not _is_hhmm(end):
        raise AppError(
            code="VALIDATION_ERROR",
            message="schedule.from / schedule.to: formato HH:MM",
        )
    return {"days": sorted({int(d) for d in days}), "from": start, "to": end}


def _minutes(hhmm: str) -> int:
    hour_str, minute_str = hhmm.split(":")
    return int(hour_str) * 60 + int(minute_str)


def combo_active_now(schedule: dict[str, Any], now_utc: datetime) -> bool:
    """`True` si el instante (convertido a Bogotá) cae dentro de los días y la
    franja horaria del combo. Franjas que cruzan medianoche (`from` > `to`,
    p. ej. 22:00 a 02:00) también se resuelven acá."""
    local = tz.to_bogota(now_utc)
    weekday = local.weekday()  # 0 = lunes ... 6 = domingo
    current = local.hour * 60 + local.minute
    start = _minutes(schedule["from"])
    end = _minutes(schedule["to"])
    days = set(schedule.get("days", []))

    if start <= end:
        return weekday in days and start <= current <= end

    previous_weekday = (weekday - 1) % 7
    return (weekday in days and current >= start) or (previous_weekday in days and current < end)


def combo_out(db: Session, combo: Combo, *, only_active_today: bool) -> CatalogComboOut:
    return CatalogComboOut(
        id=combo.id,
        name=combo.name,
        price=combo.price,
        active_now=combo_active_now(combo.schedule, clock.now_utc()),
        schedule=combo.schedule,
        groups=combo_groups_out(db, combo.id, only_active_today=only_active_today),
    )


def combo_admin_out(db: Session, combo: Combo) -> ComboAdminOut:
    return ComboAdminOut(
        id=combo.id,
        name=combo.name,
        price=combo.price,
        active=combo.active,
        active_now=combo_active_now(combo.schedule, clock.now_utc()),
        schedule=combo.schedule,
        groups=combo_groups_admin_out(db, combo.id),
    )


def combo_groups_out(db: Session, combo_id: int, *, only_active_today: bool) -> list[ComboGroupOut]:
    groups = (
        db.execute(
            select(ComboGroup).where(ComboGroup.combo_id == combo_id).order_by(ComboGroup.sort_order, ComboGroup.id)
        )
        .scalars()
        .all()
    )
    out: list[ComboGroupOut] = []
    for group in groups:
        stmt = (
            select(ComboOption, Product.name)
            .join(Product, ComboOption.product_id == Product.id)
            .where(ComboOption.combo_group_id == group.id)
        )
        if only_active_today:
            stmt = stmt.where(ComboOption.active_today.is_(True))
        rows = db.execute(stmt.order_by(ComboOption.id)).all()
        out.append(
            ComboGroupOut(
                id=group.id,
                name=group.name,
                sort_order=group.sort_order,
                options=[
                    ComboOptionOut(id=opt.id, name=name, product_id=opt.product_id, available_today=opt.available_today)
                    for opt, name in rows
                ],
            )
        )
    return out


def combo_groups_admin_out(db: Session, combo_id: int) -> list[ComboGroupAdminOut]:
    groups = (
        db.execute(
            select(ComboGroup).where(ComboGroup.combo_id == combo_id).order_by(ComboGroup.sort_order, ComboGroup.id)
        )
        .scalars()
        .all()
    )
    out: list[ComboGroupAdminOut] = []
    for group in groups:
        stmt = (
            select(ComboOption, Product.name)
            .join(Product, ComboOption.product_id == Product.id)
            .where(ComboOption.combo_group_id == group.id)
            .order_by(ComboOption.id)
        )
        rows = db.execute(stmt).all()
        out.append(
            ComboGroupAdminOut(
                id=group.id,
                name=group.name,
                sort_order=group.sort_order,
                options=[
                    ComboOptionAdminOut(
                        id=opt.id,
                        name=name,
                        product_id=opt.product_id,
                        available_today=opt.available_today,
                        active_today=opt.active_today,
                    )
                    for opt, name in rows
                ],
            )
        )
    return out


def assert_combo_sellable(db: Session, combo: Combo) -> None:
    """`COMBO_WITHOUT_GROUPS` (SPEC-NEGOCIO §4.3: "un combo sin grupos no es
    vendible") — se exige al activarlo; pedirlo en una comanda es del 1b."""
    count = db.execute(
        select(func.count()).select_from(ComboGroup).where(ComboGroup.combo_id == combo.id)
    ).scalar_one()
    if not count:
        raise AppError(
            code="COMBO_WITHOUT_GROUPS",
            message="Agregale al menos un grupo de opciones antes de activar el combo",
        )


def _upsert_combo_options(db: Session, group: ComboGroup, options_in: list[Any]) -> None:
    existing = {
        o.id: o
        for o in db.execute(
            select(ComboOption).where(ComboOption.combo_group_id == group.id)
        ).scalars().all()
    }
    for opt_in in options_in:
        product = db.get(Product, opt_in.product_id)
        if product is None or product.organization_id != group.organization_id:
            raise NotFoundError("El producto no existe")
        if product.store_id != group.store_id:
            raise NotFoundError("El producto no existe en esta sede")
        if opt_in.id is not None and opt_in.id in existing:
            existing[opt_in.id].product_id = product.id
        else:
            db.add(
                ComboOption(
                    organization_id=group.organization_id,
                    store_id=group.store_id,
                    combo_group_id=group.id,
                    product_id=product.id,
                    active_today=True,
                    available_today=True,
                )
            )
    db.flush()


def _create_combo_group(db: Session, combo: Combo, data: ComboGroupIn) -> ComboGroup:
    group = ComboGroup(
        organization_id=combo.organization_id,
        store_id=combo.store_id,
        combo_id=combo.id,
        name=data.name,
        sort_order=data.sort_order,
    )
    db.add(group)
    db.flush()
    _upsert_combo_options(db, group, data.options)
    return group


def _upsert_combo_groups(db: Session, combo: Combo, groups_in: list[ComboGroupIn]) -> None:
    """Crea o actualiza (por `id`) los grupos del combo, igual que las
    opciones de modificadores: no borra los grupos que queden afuera de la
    lista (declarado en `gaps`)."""
    existing = {
        g.id: g
        for g in db.execute(select(ComboGroup).where(ComboGroup.combo_id == combo.id)).scalars().all()
    }
    for group_in in groups_in:
        if group_in.id is not None and group_in.id in existing:
            group = existing[group_in.id]
            group.name = group_in.name
            group.sort_order = group_in.sort_order
            db.flush()
            _upsert_combo_options(db, group, group_in.options)
        else:
            _create_combo_group(db, combo, group_in)


def create_combo(db: Session, *, organization_id: int, store_id: int, data: ComboIn) -> Combo:
    schedule = validate_schedule(data.schedule)
    now = clock.now_utc()
    combo = Combo(
        organization_id=organization_id,
        store_id=store_id,
        name=data.name,
        price=data.price,
        active=False,
        schedule=schedule,
        created_at=now,
        updated_at=now,
    )
    db.add(combo)
    db.flush()
    for group_in in data.groups:
        _create_combo_group(db, combo, group_in)
    if data.active:
        assert_combo_sellable(db, combo)
        combo.active = True
    db.flush()
    return combo


def update_combo(db: Session, combo: Combo, data: ComboUpdateIn) -> Combo:
    if data.name is not None:
        combo.name = data.name
    if data.price is not None:
        combo.price = data.price
    if data.schedule is not None:
        combo.schedule = validate_schedule(data.schedule)
    if data.groups is not None:
        _upsert_combo_groups(db, combo, data.groups)
    if data.active is not None:
        if data.active:
            assert_combo_sellable(db, combo)
        combo.active = data.active
    combo.updated_at = clock.now_utc()
    db.flush()
    return combo


def set_combo_today(db: Session, combo: Combo, active_option_ids: list[int]) -> Combo:
    """«Armar el menú de hoy»: prende `active_today` en las opciones pedidas
    y lo apaga en el resto del combo (reemplazo completo, no incremental)."""
    wanted = set(active_option_ids)
    rows = (
        db.execute(
            select(ComboOption)
            .join(ComboGroup, ComboOption.combo_group_id == ComboGroup.id)
            .where(ComboGroup.combo_id == combo.id)
        )
        .scalars()
        .all()
    )
    for row in rows:
        row.active_today = row.id in wanted
    db.flush()
    return combo


def set_combo_option_availability(
    db: Session, option: ComboOption, *, available: bool, actor: Actor
) -> ComboOption:
    option.available_today = available
    if available:
        option.unavailable_by_employee_id = None
        option.unavailable_by_employee_name = None
        option.unavailable_at = None
    else:
        option.unavailable_by_employee_id = actor.employee_id
        option.unavailable_by_employee_name = actor.employee_name
        option.unavailable_at = clock.now_utc()
    db.flush()
    return option


# ---------------------------------------------------------------------------
# Agotados del día: se limpian al abrir el día operativo (lo llama
# `app.shifts.service` vía `find_spec`, `CONTRATO-INTERNO.md §2`).
# ---------------------------------------------------------------------------


def reset_daily_availability(db: Session, *, store_id: int) -> None:
    for product in db.execute(select(Product).where(Product.store_id == store_id)).scalars().all():
        product.available = True
        if product.daily_count is not None:
            product.daily_remaining = product.daily_count
        product.unavailable_by_employee_id = None
        product.unavailable_by_employee_name = None
        product.unavailable_at = None

    for modifier_option in db.execute(
        select(ModifierOption).where(ModifierOption.store_id == store_id)
    ).scalars().all():
        modifier_option.available = True
        modifier_option.unavailable_by_employee_id = None
        modifier_option.unavailable_by_employee_name = None
        modifier_option.unavailable_at = None

    # `active_today` vuelve a `True` (todo incluido) y es el admin quien
    # recorta con "armar el menú de hoy" lo que no se sirve; así un combo
    # simple (sin curaduría diaria) sigue vendible sin acción del admin.
    for combo_option in db.execute(
        select(ComboOption).where(ComboOption.store_id == store_id)
    ).scalars().all():
        combo_option.active_today = True
        combo_option.available_today = True
        combo_option.unavailable_by_employee_id = None
        combo_option.unavailable_by_employee_name = None
        combo_option.unavailable_at = None

    db.flush()


# ---------------------------------------------------------------------------
# `GET /catalog`.
# ---------------------------------------------------------------------------


def get_catalog(
    db: Session, *, organization_id: int, store_id: int, feature_flags: dict[str, bool]
) -> CatalogOut:
    categories = (
        db.execute(
            select(Category)
            .where(Category.store_id == store_id, Category.active.is_(True))
            .order_by(Category.sort_order, Category.name)
        )
        .scalars()
        .all()
    )
    products = (
        db.execute(
            select(Product)
            # `is_delivery_fee`: pedido 2c, no es un plato del menú — se
            # agrega solo al crear una comanda `delivery`
            # (`app.orders.service.create_order`), nunca lo elige el
            # operador desde la carta.
            .where(
                Product.store_id == store_id,
                Product.active.is_(True),
                Product.is_delivery_fee.is_(False),
            )
            .order_by(Product.name)
        )
        .scalars()
        .all()
    )

    modifiers_enabled = feature_flags.get("pos.modifiers", False)
    daily_count_enabled = feature_flags.get("pos.daily_count", False)

    product_outs: list[CatalogProductOut] = []
    for product in products:
        product_outs.append(
            CatalogProductOut(
                id=product.id,
                category_id=product.category_id,
                name=product.name,
                description=product.description,
                station=product.station,
                default_course=product.default_course,
                prices=_product_prices_resolved(product),
                tax_code=product.tax_code,  # type: ignore[arg-type]
                available=product.available,
                daily_count=product.daily_count if daily_count_enabled else None,
                daily_remaining=product.daily_remaining if daily_count_enabled else None,
                modifier_groups=modifier_groups_out(db, product.id) if modifiers_enabled else [],
            )
        )

    combos_out: list[CatalogComboOut] = []
    if feature_flags.get("pos.combos", False):
        combos = (
            db.execute(
                select(Combo)
                .where(Combo.store_id == store_id, Combo.active.is_(True))
                .order_by(Combo.name)
            )
            .scalars()
            .all()
        )
        combos_out = [combo_out(db, combo, only_active_today=True) for combo in combos]

    return CatalogOut(
        categories=[category_out(c) for c in categories],
        products=product_outs,
        combos=combos_out,
    )
