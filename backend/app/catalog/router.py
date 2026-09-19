"""Endpoints de la carta plana (`features/fase-1a-cimientos/spec.md`, sección
Catalog). El prefijo `/api/v1` lo agrega `app.main.create_app`; acá las rutas
se escriben sin él.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.auth.deps import Actor, admin_store, current_actor, current_admin, current_device
from app.catalog import service
from app.catalog.models import Category, Combo, Product
from app.catalog.schemas import (
    CatalogOut,
    CategoryIn,
    CategoryOut,
    CategoryUpdateIn,
    ComboAdminOut,
    ComboIn,
    ComboTodayIn,
    ComboUpdateIn,
    ModifierGroupIn,
    ModifierGroupOut,
    ModifierGroupUpdateIn,
    OptionAvailabilityIn,
    ProductAdminOut,
    ProductAvailabilityIn,
    ProductIn,
    ProductUpdateIn,
)
from app.core import features
from app.core.csv import csv_response, wants_csv
from app.core.db import get_db
from app.core.errors import AppError, UnauthorizedError

router = APIRouter()


# ---------------------------------------------------------------------------
# Helpers de sesión y alcance.
# ---------------------------------------------------------------------------


def _catalog_read_actor(request: Request, db: Session = Depends(get_db)) -> Actor:
    """`GET /catalog` lo lee cualquier dispositivo activado (identificado o
    no: consultar la carta no es una acción sensible, SPEC-NEGOCIO §2.1) o un
    admin — a diferencia de `current_actor`, no exige persona identificada."""
    try:
        return current_admin(request, db)
    except UnauthorizedError:
        return current_device(request, db)


def _target_store_id(db: Session, actor: Actor, store_id: int | None) -> int:
    if actor.kind == "device":
        assert actor.store_id is not None
        return actor.store_id
    if store_id is None:
        raise AppError(code="VALIDATION_ERROR", message="store_id: indicá la sede a consultar")
    admin_store(db, actor, store_id)
    return store_id


# ---------------------------------------------------------------------------
# GET /catalog (dispositivo o admin).
# ---------------------------------------------------------------------------


@router.get("/catalog")
def get_catalog(
    store_id: int | None = None,
    db: Session = Depends(get_db),
    actor: Actor = Depends(_catalog_read_actor),
) -> CatalogOut:
    target_store_id = _target_store_id(db, actor, store_id)
    flags = features.enabled_map(db, actor.organization_id, target_store_id)
    return service.get_catalog(
        db, organization_id=actor.organization_id, store_id=target_store_id, feature_flags=flags
    )


# ---------------------------------------------------------------------------
# Admin: categorías.
# ---------------------------------------------------------------------------


@router.get("/admin/categories")
def list_categories(
    request: Request,
    store_id: int,
    # Deuda declarada en `outputs-2a/ENTREGA.md § 5` (pedido 2b): `format`
    # declarado en el contrato, no sólo leído de `request.query_params` dentro
    # de `wants_csv` — mismo patrón que `app.reports.router.get_sales`.
    format: str | None = Query(None, description='"csv" exporta como CSV'),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
) -> Any:
    del format  # declarado sólo para el OpenAPI; el valor real se lee de `wants_csv(request)`.
    admin_store(db, actor, store_id)
    rows = (
        db.execute(select(Category).where(Category.store_id == store_id).order_by(Category.sort_order, Category.name))
        .scalars()
        .all()
    )
    out = [service.category_out(c) for c in rows]
    if wants_csv(request):
        return csv_response([c.model_dump() for c in out], "categories.csv")
    return out


@router.post("/admin/categories")
def create_category(
    store_id: int, body: CategoryIn, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> CategoryOut:
    admin_store(db, actor, store_id)
    category = service.create_category(db, organization_id=actor.organization_id, store_id=store_id, data=body)
    out = service.category_out(category)
    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=store_id,
        entity="category",
        entity_id=category.id,
        action="create",
        before=None,
        after=out.model_dump(),
    )
    return out


@router.patch("/admin/categories/{category_id}")
def update_category(
    category_id: int, body: CategoryUpdateIn, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> CategoryOut:
    category = service.category_or_404(db, actor, category_id)
    before = service.category_out(category).model_dump()
    category = service.update_category(db, category, body)
    after = service.category_out(category)
    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=category.store_id,
        entity="category",
        entity_id=category.id,
        action="update",
        before=before,
        after=after.model_dump(),
    )
    return after


# ---------------------------------------------------------------------------
# Admin: productos.
# ---------------------------------------------------------------------------


@router.get("/admin/products")
def list_products(
    request: Request,
    store_id: int,
    category_id: int | None = None,
    search: str | None = None,
    # Deuda declarada en `outputs-2a/ENTREGA.md § 5` (pedido 2b): ver
    # `list_categories` arriba, mismo motivo.
    format: str | None = Query(None, description='"csv" exporta como CSV'),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
) -> Any:
    del format  # declarado sólo para el OpenAPI; el valor real se lee de `wants_csv(request)`.
    admin_store(db, actor, store_id)
    stmt = select(Product).where(Product.store_id == store_id)
    if category_id is not None:
        stmt = stmt.where(Product.category_id == category_id)
    if search:
        stmt = stmt.where(Product.name.ilike(f"%{search}%"))
    rows = db.execute(stmt.order_by(Product.name)).scalars().all()
    out = [service.product_admin_out(db, p) for p in rows]
    if wants_csv(request):
        return csv_response([p.model_dump() for p in out], "products.csv")
    return out


@router.post("/admin/products")
def create_product(
    store_id: int, body: ProductIn, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> ProductAdminOut:
    admin_store(db, actor, store_id)
    product = service.create_product(db, organization_id=actor.organization_id, store_id=store_id, data=body)
    out = service.product_admin_out(db, product)
    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=store_id,
        entity="product",
        entity_id=product.id,
        action="create",
        before=None,
        after=out.model_dump(),
    )
    return out


@router.patch("/admin/products/{product_id}")
def update_product(
    product_id: int, body: ProductUpdateIn, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> ProductAdminOut:
    product = service.product_or_404(db, actor, product_id)
    before = service.product_admin_out(db, product).model_dump()
    product = service.update_product(db, product, body)
    after = service.product_admin_out(db, product)
    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=product.store_id,
        entity="product",
        entity_id=product.id,
        action="update",
        before=before,
        after=after.model_dump(),
    )
    return after


@router.post("/products/{product_id}/availability")
def set_product_availability(
    product_id: int,
    body: ProductAvailabilityIn,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_actor),
) -> ProductAdminOut:
    product = service.product_or_404(db, actor, product_id)
    if body.daily_count is not None:
        features.assert_feature(db, actor.organization_id, product.store_id, "pos.daily_count")
    before = service.product_admin_out(db, product).model_dump()
    product = service.set_product_availability(
        db, product, available=body.available, daily_count=body.daily_count, actor=actor
    )
    after = service.product_admin_out(db, product)
    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=product.store_id,
        entity="product",
        entity_id=product.id,
        action="set_availability",
        before=before,
        after=after.model_dump(),
    )
    return after


# ---------------------------------------------------------------------------
# Admin: grupos de modificadores (detrás de `pos.modifiers`).
# ---------------------------------------------------------------------------


@router.get("/admin/modifier-groups")
def list_modifier_groups(
    product_id: int,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(features.require_feature("pos.modifiers")),
) -> list[ModifierGroupOut]:
    service.product_or_404(db, actor, product_id)
    return service.modifier_groups_out(db, product_id)


@router.post("/admin/modifier-groups")
def create_modifier_group(
    product_id: int,
    body: ModifierGroupIn,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(features.require_feature("pos.modifiers")),
) -> ModifierGroupOut:
    product = service.product_or_404(db, actor, product_id)
    group = service.create_modifier_group(db, product=product, data=body)
    out = service.modifier_group_out(db, group)
    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=product.store_id,
        entity="modifier_group",
        entity_id=group.id,
        action="create",
        before=None,
        after=out.model_dump(),
    )
    return out


@router.patch("/admin/modifier-groups/{group_id}")
def update_modifier_group(
    group_id: int,
    body: ModifierGroupUpdateIn,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(features.require_feature("pos.modifiers")),
) -> ModifierGroupOut:
    group = service.modifier_group_or_404(db, actor, group_id)
    before = service.modifier_group_out(db, group).model_dump()
    group = service.update_modifier_group(db, group, body)
    after = service.modifier_group_out(db, group)
    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=group.store_id,
        entity="modifier_group",
        entity_id=group.id,
        action="update",
        before=before,
        after=after.model_dump(),
    )
    return after


@router.post("/modifier-options/{option_id}/availability")
def set_modifier_option_availability(
    option_id: int,
    body: OptionAvailabilityIn,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_actor),
    _feature: None = Depends(features.require_feature("pos.modifiers")),
) -> dict[str, Any]:
    option = service.modifier_option_or_404(db, actor, option_id)
    before = {"available": option.available}
    option = service.set_modifier_option_availability(db, option, available=body.available, actor=actor)
    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=option.store_id,
        entity="modifier_option",
        entity_id=option.id,
        action="set_availability",
        before=before,
        after={"available": option.available},
    )
    return {"id": option.id, "available": option.available}


# ---------------------------------------------------------------------------
# Admin: combos y menú del día (detrás de `pos.combos` / `pos.daily_menu`).
# ---------------------------------------------------------------------------


@router.get("/admin/combos")
def list_combos(
    request: Request,
    store_id: int,
    # Deuda declarada en `outputs-2a/ENTREGA.md § 5` (pedido 2b): ver
    # `list_categories` arriba, mismo motivo.
    format: str | None = Query(None, description='"csv" exporta como CSV'),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(features.require_feature("pos.combos")),
) -> Any:
    del format  # declarado sólo para el OpenAPI; el valor real se lee de `wants_csv(request)`.
    admin_store(db, actor, store_id)
    rows = db.execute(select(Combo).where(Combo.store_id == store_id).order_by(Combo.name)).scalars().all()
    out = [service.combo_admin_out(db, c) for c in rows]
    if wants_csv(request):
        return csv_response([c.model_dump() for c in out], "combos.csv")
    return out


@router.post("/admin/combos")
def create_combo(
    store_id: int,
    body: ComboIn,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(features.require_feature("pos.combos")),
) -> ComboAdminOut:
    admin_store(db, actor, store_id)
    combo = service.create_combo(db, organization_id=actor.organization_id, store_id=store_id, data=body)
    out = service.combo_admin_out(db, combo)
    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=store_id,
        entity="combo",
        entity_id=combo.id,
        action="create",
        before=None,
        after=out.model_dump(),
    )
    return out


@router.patch("/admin/combos/{combo_id}")
def update_combo(
    combo_id: int,
    body: ComboUpdateIn,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(features.require_feature("pos.combos")),
) -> ComboAdminOut:
    combo = service.combo_or_404(db, actor, combo_id)
    before = service.combo_admin_out(db, combo).model_dump()
    combo = service.update_combo(db, combo, body)
    after = service.combo_admin_out(db, combo)
    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=combo.store_id,
        entity="combo",
        entity_id=combo.id,
        action="update",
        before=before,
        after=after.model_dump(),
    )
    return after


@router.put("/admin/combos/{combo_id}/today")
def set_combo_today(
    combo_id: int,
    body: ComboTodayIn,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(features.require_feature("pos.daily_menu")),
) -> ComboAdminOut:
    combo = service.combo_or_404(db, actor, combo_id)
    before = service.combo_admin_out(db, combo).model_dump()
    combo = service.set_combo_today(db, combo, body.active_option_ids)
    after = service.combo_admin_out(db, combo)
    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=combo.store_id,
        entity="combo",
        entity_id=combo.id,
        action="set_today",
        before=before,
        after=after.model_dump(),
    )
    return after


@router.post("/combo-options/{option_id}/availability")
def set_combo_option_availability(
    option_id: int,
    body: OptionAvailabilityIn,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_actor),
    _feature: None = Depends(features.require_feature("pos.combos")),
) -> dict[str, Any]:
    option = service.combo_option_or_404(db, actor, option_id)
    before = {"available_today": option.available_today}
    option = service.set_combo_option_availability(db, option, available=body.available, actor=actor)
    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=option.store_id,
        entity="combo_option",
        entity_id=option.id,
        action="set_availability",
        before=before,
        after={"available_today": option.available_today},
    )
    return {"id": option.id, "available_today": option.available_today}
