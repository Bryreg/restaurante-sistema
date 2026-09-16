"""Endpoints de fichas técnicas, preparaciones y `recipe_effect`
(`features/fase-2-costo-inventario/spec.md`). El prefijo `/api/v1` lo agrega
`app.main.create_app`; acá las rutas se escriben sin él.

`format=csv` se declara **en la firma** de cada listado (nunca leído de
`request.query_params` a mano) para que el OpenAPI lo publique — el hallazgo
R-5 de 1b-2 que este pedido tiene que evitar.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any, Callable, Literal

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth.deps import Actor, admin_store, current_admin, current_device, current_operator
from app.core import tz
from app.core.csv import csv_response
from app.core.db import get_db
from app.core.features import require_feature
from app.core.idempotency import hash_request_body, idempotency_key, run_idempotent
from app.recipes import service
from app.recipes.hooks import uncosted_products
from app.recipes.schemas import (
    CoverageItemOut,
    PrepBatchAdminOut,
    PreparationAdminOut,
    PreparationDeviceOut,
    PreparationIn,
    PreparationModeIn,
    PreparationUpdateIn,
    ProduceIn,
    ProductRecipeIn,
    ProductRecipeOut,
    RecipeEffectIn,
    RecipeEffectOut,
    SuspiciousLineOut,
)

router = APIRouter()

FormatQuery = Literal["json", "csv"] | None


def _idempotent(
    db: Session, *, organization_id: int, scope: str, request: Request, payload: BaseModel,
    fn: Callable[[], tuple[int, dict[str, Any]]],
) -> JSONResponse:
    key = idempotency_key(request)
    request_hash = hash_request_body(payload.model_dump(mode="json"))
    status_code, body = run_idempotent(
        db, organization_id=organization_id, scope=scope, key=key, request_hash=request_hash, fn=fn
    )
    return JSONResponse(status_code=status_code, content=body)


def _cutoff_hour(db: Session, store_id: int) -> int:
    from app.stores.models import Store

    store = db.get(Store, store_id)
    return store.cutoff_hour if store is not None else 6


# ---------------------------------------------------------------------------
# Preparaciones — admin
# ---------------------------------------------------------------------------


@router.get("/admin/preparations", response_model=list[PreparationAdminOut])
def list_preparations(
    store_id: int,
    format: FormatQuery = None,
    active_only: bool = True,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(require_feature("catalog.preps")),
) -> list[PreparationAdminOut] | Response:
    admin_store(db, actor, store_id)
    rows = service.list_preparations(db, store_id=store_id, active_only=active_only)
    out = [service.preparation_admin_out(db, p) for p in rows]
    if format == "csv":
        flat = [{**o.model_dump(mode="json"), "lines": len(o.lines)} for o in out]
        return csv_response(flat, "preparaciones.csv")
    return out


@router.post("/admin/preparations", status_code=201)
def create_preparation(
    store_id: int,
    body: PreparationIn,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(require_feature("catalog.preps")),
) -> PreparationAdminOut:
    admin_store(db, actor, store_id)
    prep = service.create_preparation(db, actor=actor, store_id=store_id, data=body)
    return service.preparation_admin_out(db, prep)


@router.patch("/admin/preparations/{preparation_id}")
def update_preparation(
    preparation_id: int,
    body: PreparationUpdateIn,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(require_feature("catalog.preps")),
) -> PreparationAdminOut:
    prep = service.preparation_or_404(db, actor, preparation_id)
    prep = service.update_preparation(db, actor=actor, preparation=prep, data=body)
    return service.preparation_admin_out(db, prep)


@router.patch("/admin/preparations/{preparation_id}/mode")
def switch_preparation_mode(
    preparation_id: int,
    body: PreparationModeIn,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(require_feature("catalog.preps")),
) -> PreparationAdminOut:
    prep = service.preparation_or_404(db, actor, preparation_id)
    prep = service.switch_preparation_mode(
        db, actor=actor, preparation=prep, new_mode=body.mode, authorizer_pin=body.authorizer_pin
    )
    return service.preparation_admin_out(db, prep)


@router.get("/admin/preparations/{preparation_id}/batches", response_model=list[PrepBatchAdminOut])
def list_batches(
    preparation_id: int,
    format: FormatQuery = None,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(require_feature("catalog.preps")),
) -> list[PrepBatchAdminOut] | Response:
    service.preparation_or_404(db, actor, preparation_id)
    batches = service.list_batches(db, preparation_id=preparation_id)
    out = [service.batch_admin_out(b) for b in batches]
    if format == "csv":
        flat = [o.model_dump(mode="json") for o in out]
        return csv_response(flat, f"preparacion-{preparation_id}-lotes.csv")
    return out


# ---------------------------------------------------------------------------
# Preparaciones — dispositivo (POS/cocina, producción rápida en dos toques)
# ---------------------------------------------------------------------------


@router.get("/preparations")
def device_list_preparations(
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_device),
    _feature: None = Depends(require_feature("catalog.preps")),
) -> list[PreparationDeviceOut]:
    assert actor.store_id is not None
    rows = service.list_preparations(db, store_id=actor.store_id, active_only=True)
    return [service.preparation_device_out(p) for p in rows]


@router.post("/preparations/{preparation_id}/produce", status_code=201)
def produce(
    preparation_id: int,
    body: ProduceIn,
    request: Request,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_operator),
    _feature: None = Depends(require_feature("catalog.preps")),
) -> JSONResponse:
    prep = service.preparation_or_404(db, actor, preparation_id)

    def _run() -> tuple[int, dict[str, Any]]:
        batch = service.produce_preparation(db, actor=actor, preparation=prep, data=body)
        return 201, service.produce_out(batch).model_dump(mode="json")

    return _idempotent(
        db, organization_id=actor.organization_id, scope=f"prep_produce:{preparation_id}", request=request,
        payload=body, fn=_run,
    )


# ---------------------------------------------------------------------------
# Fichas técnicas del plato
# ---------------------------------------------------------------------------


@router.get("/admin/products/{product_id}/recipe")
def get_product_recipe(
    product_id: int,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(require_feature("catalog.recipes")),
) -> ProductRecipeOut:
    return service.get_product_recipe(db, actor=actor, product_id=product_id)


@router.put("/admin/products/{product_id}/recipe")
def put_product_recipe(
    product_id: int,
    body: ProductRecipeIn,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(require_feature("catalog.recipes")),
) -> ProductRecipeOut:
    return service.put_product_recipe(db, actor=actor, product_id=product_id, data=body)


# ---------------------------------------------------------------------------
# `recipe_effect` de las opciones de modificador
# ---------------------------------------------------------------------------


@router.put("/admin/modifier-options/{option_id}/recipe-effect")
def put_modifier_option_recipe_effect(
    option_id: int,
    body: RecipeEffectIn,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(require_feature("catalog.recipes")),
) -> RecipeEffectOut:
    return service.put_modifier_option_recipe_effect(db, actor=actor, option_id=option_id, data=body)


# ---------------------------------------------------------------------------
# Validaciones y cobertura
# ---------------------------------------------------------------------------


@router.get("/admin/recipes/coverage", response_model=list[CoverageItemOut])
def recipe_coverage(
    store_id: int,
    date_from: date | None = None,
    date_to: date | None = None,
    format: FormatQuery = None,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(require_feature("catalog.recipes")),
) -> list[CoverageItemOut] | Response:
    admin_store(db, actor, store_id)
    if date_to is None:
        date_to = tz.today_business_date(_cutoff_hour(db, store_id))
    if date_from is None:
        date_from = date_to - timedelta(days=30)
    rows = uncosted_products(db, store_id=store_id, date_from=date_from, date_to=date_to)
    if format == "csv":
        return csv_response(rows, "recetas-cobertura.csv")
    return [CoverageItemOut(**row) for row in rows]


@router.get("/admin/recipes/suspicious-units", response_model=list[SuspiciousLineOut])
def recipe_suspicious_units(
    store_id: int,
    format: FormatQuery = None,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(require_feature("catalog.recipes")),
) -> list[SuspiciousLineOut] | Response:
    admin_store(db, actor, store_id)
    rows = service.suspicious_recipe_lines(db, store_id=store_id)
    if format == "csv":
        return csv_response(rows, "recetas-unidades-sospechosas.csv")
    return [SuspiciousLineOut(**row) for row in rows]
