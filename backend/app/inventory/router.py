"""Endpoints de `inventory` (`features/fase-2-costo-inventario/spec.md`). El
prefijo `/api/v1` lo agrega `app.main.create_app` (o, en tests, el montaje
manual de `tests/inventory/conftest.py` mientras `"inventory"` no está
todavía en `app.main.DOMAINS` — ver ese archivo).

Gating de flags (decisión declarada en el entregable): `Ingredient` es dato
maestro, igual que `Category`/`Product` en `catalog` — no lleva flag propia,
porque `catalog.recipes` (fichas técnicas, territorio ajeno) necesita poder
leer insumos aunque `inventory.perpetual` esté apagada. Lo que SÍ es
opcional: `inventory.perpetual` (movimientos, stock, ajustes) e
`inventory.waste` (mermas).
"""

from __future__ import annotations

from datetime import date
from typing import Any, Callable

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.auth.deps import Actor, admin_store, current_admin, current_device
from app.core import features
from app.core.csv import csv_response, wants_csv
from app.core.db import get_db
from app.core.errors import AppError
from app.core.idempotency import hash_request_body, idempotency_key, run_idempotent
from app.inventory import service
from app.inventory.models import Ingredient, MovementCause, WasteType
from app.inventory.schemas import (
    AdjustmentIn,
    DeviceIngredientOut,
    IngredientIn,
    IngredientOut,
    IngredientUpdateIn,
    MovementCauseLiteral,
    StockRowOut,
    WasteIn,
    WasteKpiOut,
    WasteListOut,
    WasteTypeLiteral,
)
from app.stores.models import Store

router = APIRouter()


# ---------------------------------------------------------------------------
# Helpers.
# ---------------------------------------------------------------------------


def _idempotent(
    db: Session,
    *,
    organization_id: int,
    scope: str,
    request: Request,
    payload: BaseModel,
    fn: Callable[[], tuple[int, dict[str, Any]]],
) -> JSONResponse:
    key = idempotency_key(request)
    request_hash = hash_request_body(payload.model_dump(mode="json"))
    status_code, body = run_idempotent(
        db, organization_id=organization_id, scope=scope, key=key, request_hash=request_hash, fn=fn
    )
    return JSONResponse(status_code=status_code, content=body)


def _store_for_device(db: Session, actor: Actor) -> Store:
    store = db.get(Store, actor.store_id)
    if store is None:
        raise AppError(code="DEVICE_NOT_ACTIVATED", message="Activá el dispositivo con el PIN de sede", status=401)
    return store


# ---------------------------------------------------------------------------
# Admin: insumos.
# ---------------------------------------------------------------------------


@router.get("/admin/ingredients")
def list_ingredients(
    request: Request,
    store_id: int = Query(...),
    active_only: bool = Query(True),
    format: str | None = Query(None),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
) -> Any:
    store = admin_store(db, actor, store_id)
    rows = service.list_ingredients(db, store=store, active_only=active_only)
    out = [service.ingredient_out(db, i) for i in rows]
    if wants_csv(request):
        return csv_response([o.model_dump() for o in out], "ingredients.csv")
    return out


@router.post("/admin/ingredients", status_code=201)
def create_ingredient(
    store_id: int, body: IngredientIn, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> IngredientOut:
    store = admin_store(db, actor, store_id)
    ingredient = service.create_ingredient(db, organization_id=actor.organization_id, store_id=store.id, data=body)
    out = service.ingredient_out(db, ingredient)
    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=store.id,
        entity="ingredient",
        entity_id=ingredient.id,
        action="create",
        before=None,
        after=out.model_dump(),
    )
    return out


@router.patch("/admin/ingredients/{ingredient_id}")
def update_ingredient(
    ingredient_id: int,
    body: IngredientUpdateIn,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
) -> IngredientOut:
    ingredient = service.ingredient_or_404(db, actor, ingredient_id)
    before = service.ingredient_out(db, ingredient).model_dump()
    ingredient = service.update_ingredient(db, ingredient, body)
    after = service.ingredient_out(db, ingredient)
    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=ingredient.store_id,
        entity="ingredient",
        entity_id=ingredient.id,
        action="update",
        before=before,
        after=after.model_dump(),
    )
    return after


@router.delete("/admin/ingredients/{ingredient_id}")
def deactivate_ingredient(
    ingredient_id: int, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> IngredientOut:
    """Baja lógica, nunca `DELETE` de fila (`docs/ESTADO.md`: nada de
    inventario se borra)."""
    ingredient = service.ingredient_or_404(db, actor, ingredient_id)
    before = service.ingredient_out(db, ingredient).model_dump()
    ingredient = service.deactivate_ingredient(db, ingredient)
    after = service.ingredient_out(db, ingredient)
    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=ingredient.store_id,
        entity="ingredient",
        entity_id=ingredient.id,
        action="deactivate",
        before=before,
        after=after.model_dump(),
    )
    return after


@router.get("/admin/ingredients/{ingredient_id}/movements")
def get_ingredient_movements(
    ingredient_id: int,
    request: Request,
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    cause: MovementCauseLiteral | None = Query(None),
    format: str | None = Query(None),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(features.require_feature("inventory.perpetual")),
) -> Any:
    ingredient = service.ingredient_or_404(db, actor, ingredient_id)
    cause_enum = MovementCause(cause) if cause is not None else None
    rows = service.list_movements(db, ingredient=ingredient, date_from=date_from, date_to=date_to, cause=cause_enum)
    out = [service.movement_out(m) for m in rows]
    if wants_csv(request):
        return csv_response([o.model_dump(mode="json") for o in out], f"movements-{ingredient_id}.csv")
    return out


# ---------------------------------------------------------------------------
# Admin: stock teórico y ajustes.
# ---------------------------------------------------------------------------


@router.get("/admin/inventory/stock")
def get_inventory_stock(
    request: Request,
    store_id: int = Query(...),
    critical_only: bool = Query(False),
    below_min: bool = Query(False),
    negative: bool = Query(False),
    format: str | None = Query(None),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(features.require_feature("inventory.perpetual")),
) -> Any:
    store = admin_store(db, actor, store_id)
    rows: list[StockRowOut] = service.stock_rows(
        db, store=store, critical_only=critical_only, below_min=below_min, negative=negative
    )
    if wants_csv(request):
        return csv_response([r.model_dump(mode="json") for r in rows], "inventory-stock.csv")
    return rows


@router.post("/admin/inventory/adjustments", status_code=201)
def post_inventory_adjustment(
    body: AdjustmentIn,
    request: Request,
    store_id: int,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(features.require_feature("inventory.perpetual")),
) -> JSONResponse:
    store = admin_store(db, actor, store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        out = service.register_adjustment(db, store=store, actor=actor, data=body)
        record_audit(
            db,
            actor=actor,
            organization_id=actor.organization_id,
            store_id=store.id,
            entity="stock_movement",
            entity_id=out.id,
            action="manual_adjustment",
            before=None,
            after=out.model_dump(mode="json"),
            reason=body.reason,
        )
        return 201, out.model_dump(mode="json")

    return _idempotent(
        db, organization_id=actor.organization_id, scope="inventory.adjustment", request=request, payload=body, fn=_do
    )


# ---------------------------------------------------------------------------
# Mermas.
# ---------------------------------------------------------------------------


@router.post("/waste", status_code=201)
def post_waste(
    body: WasteIn,
    request: Request,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_device),
    _feature: None = Depends(features.require_feature("inventory.waste")),
) -> JSONResponse:
    store = _store_for_device(db, actor)

    def _do() -> tuple[int, dict[str, Any]]:
        waste = service.register_waste(db, store=store, data=body)
        out = service.waste_out(waste)
        record_audit(
            db,
            actor=actor,
            organization_id=store.organization_id,
            store_id=store.id,
            entity="waste",
            entity_id=waste.id,
            action="create",
            before=None,
            after=service.waste_admin_out(waste).model_dump(mode="json"),
        )
        return 201, out.model_dump(mode="json")

    return _idempotent(
        db, organization_id=store.organization_id, scope="inventory.waste", request=request, payload=body, fn=_do
    )


@router.get("/admin/waste")
def get_waste_list(
    request: Request,
    store_id: int = Query(...),
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    type: WasteTypeLiteral | None = Query(None),
    employee_id: int | None = Query(None),
    format: str | None = Query(None),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(features.require_feature("inventory.waste")),
) -> Any:
    store = admin_store(db, actor, store_id)
    type_enum = WasteType(type) if type is not None else None
    rows = service.list_waste(
        db, store=store, date_from=date_from, date_to=date_to, type_=type_enum, employee_id=employee_id
    )
    out = [service.waste_admin_out(w) for w in rows]
    if wants_csv(request):
        return csv_response([o.model_dump(mode="json") for o in out], "waste.csv")
    kpi: WasteKpiOut = service.weekly_waste_kpi()
    return WasteListOut(items=out, weekly_kpi=kpi)


# ---------------------------------------------------------------------------
# Dispositivo: sin ningún campo de costo.
# ---------------------------------------------------------------------------


@router.get("/device/ingredients")
def list_device_ingredients(
    db: Session = Depends(get_db), actor: Actor = Depends(current_device)
) -> list[DeviceIngredientOut]:
    """Sólo para el formulario de merma del POS/cocina: `{id, name,
    base_unit}`, ni un campo de costo (regla dura, SPEC-NEGOCIO §2.2). Mismo
    patrón que `GET /device/employees` y `GET /device/payment-methods`:
    dispositivo activado, persona identificada opcional."""
    store = _store_for_device(db, actor)
    rows: list[Ingredient] = service.list_ingredients(db, store=store, active_only=True)
    return [DeviceIngredientOut(id=i.id, name=i.name, base_unit=i.base_unit.value) for i in rows]  # type: ignore[arg-type]
