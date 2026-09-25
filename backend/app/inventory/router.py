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
from app.auth.deps import Actor, admin_store, current_admin, current_device, current_operator
from app.core import features, tz
from app.core.csv import csv_response, wants_csv
from app.core.db import get_db
from app.core.errors import AppError
from app.core.idempotency import hash_request_body, idempotency_key, run_idempotent
from app.inventory import area_counts, service
from app.inventory.models import Ingredient, MovementCause, StockCountScope, WasteType
from app.inventory.schemas import (
    AdjustmentIn,
    AreaCountDetailOut,
    AreaCountIn,
    AreaCountOut,
    AreaCountSettingsIn,
    AreaCountSettingsOut,
    AreaRecountAnswerIn,
    AreaRecountRequestIn,
    AreaRecountRequestOut,
    AreaRecountStatusLiteral,
    CountAreaIn,
    CountAreaItemsIn,
    CountAreaMemberIn,
    CountAreaOut,
    CountAreaUpdateIn,
    DeviceAreaCountBoardOut,
    CountApplyIn,
    CountDetailOut,
    CountLinesIn,
    CountOpenIn,
    CountOut,
    CountScopeLiteral,
    DeviceIngredientOut,
    IngredientIn,
    IngredientOut,
    IngredientUpdateIn,
    InventorySettingsIn,
    LotOut,
    LotStatusLiteral,
    MovementCauseLiteral,
    StockRowOut,
    TransferReceiveIn,
    TransferStoreOut,
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
    business_date = tz.today_business_date(store.cutoff_hour)
    kpi: WasteKpiOut = service.weekly_waste_kpi(db, store=store, business_date=business_date)
    return WasteListOut(items=out, weekly_kpi=kpi)


@router.get("/device/waste/transfer-stores")
def list_transfer_stores(
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_device),
    _feature: None = Depends(features.require_feature("inventory.waste")),
) -> list[TransferStoreOut]:
    """Las otras sedes de la organización, para «Traslado a otra sede» en el
    formulario de merma. Vacía = una sola sede: la pantalla no ofrece la
    opción. Sólo id y nombre."""
    store = _store_for_device(db, actor)
    return [service.transfer_store_out(s) for s in service.transfer_destinations(db, store=store)]


@router.get("/admin/transfers/incoming")
def get_incoming_transfers(
    request: Request,
    store_id: int = Query(...),
    status: str = Query("pending", pattern="^(pending|all)$"),
    format: str | None = Query(None),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(features.require_feature("inventory.waste")),
) -> Any:
    """Traslados que llegan a esta sede desde otra de la organización:
    `pending` = por recibir; `all` = también los ya recibidos."""
    store = admin_store(db, actor, store_id)
    rows = service.list_incoming_transfers(db, store=store, pending_only=status == "pending")
    out = [service.incoming_transfer_out(db, store=store, waste=w) for w in rows]
    if wants_csv(request):
        return csv_response([o.model_dump(mode="json") for o in out], "transfers.csv")
    return out


@router.post("/admin/transfers/{waste_id}/receive")
def post_receive_transfer(
    waste_id: int,
    body: TransferReceiveIn,
    request: Request,
    store_id: int = Query(...),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(features.require_feature("inventory.waste")),
) -> JSONResponse:
    store = admin_store(db, actor, store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        waste = service.receive_transfer(db, store=store, actor=actor, waste_id=waste_id, data=body)
        out = service.incoming_transfer_out(db, store=store, waste=waste)
        record_audit(
            db,
            actor=actor,
            organization_id=store.organization_id,
            store_id=store.id,
            entity="waste_transfer",
            entity_id=waste.id,
            action="receive",
            before=None,
            after=out.model_dump(mode="json"),
        )
        return 200, out.model_dump(mode="json")

    return _idempotent(
        db,
        organization_id=store.organization_id,
        scope="inventory.transfer_receive",
        request=request,
        payload=body,
        fn=_do,
    )


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


# ---------------------------------------------------------------------------
# Admin: lotes y vencimientos (pedido 2b, `inventory.lots`).
# ---------------------------------------------------------------------------


@router.get("/admin/lots")
def get_lots(
    store_id: int = Query(...),
    ingredient_id: int | None = Query(None),
    status: LotStatusLiteral | None = Query(None),
    expiring_within_days: int | None = Query(None, ge=0),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(features.require_feature("inventory.lots")),
) -> list[LotOut]:
    store = admin_store(db, actor, store_id)
    rows = service.list_lots(
        db, store=store, ingredient_id=ingredient_id, status=status, expiring_within_days=expiring_within_days
    )
    return [service.lot_out(db, batch, st) for batch, st in rows]


# ---------------------------------------------------------------------------
# Admin: umbrales de varianza (configuración de sede; vive acá por decisión
# de arquitectura, no en `app.stores`).
# ---------------------------------------------------------------------------


@router.get("/admin/stores/{store_id}/inventory-settings")
def get_inventory_settings(
    store_id: int,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(features.require_feature("inventory.variance")),
) -> Any:
    store = admin_store(db, actor, store_id)
    return service.inventory_settings_out(service.get_inventory_settings(db, store))


@router.put("/admin/stores/{store_id}/inventory-settings")
def put_inventory_settings(
    store_id: int,
    body: InventorySettingsIn,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(features.require_feature("inventory.variance")),
) -> Any:
    store = admin_store(db, actor, store_id)
    before = service.inventory_settings_out(service.get_inventory_settings(db, store)).model_dump()
    row = service.update_inventory_settings(db, store, body)
    after = service.inventory_settings_out(row)
    record_audit(
        db, actor=actor, organization_id=actor.organization_id, store_id=store.id,
        entity="inventory_settings", entity_id=store.id, action="update", before=before, after=after.model_dump(),
    )
    return after


# ---------------------------------------------------------------------------
# Admin: conteos a ciegas (`inventory.counts`).
# ---------------------------------------------------------------------------


@router.post("/admin/counts", status_code=201)
def post_open_count(
    body: CountOpenIn,
    store_id: int,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(features.require_feature("inventory.counts")),
) -> Any:
    store = admin_store(db, actor, store_id)
    count = service.open_count(db, store=store, actor=actor, scope=StockCountScope(body.scope))
    out = service.count_detail_out(db, count)
    record_audit(
        db, actor=actor, organization_id=actor.organization_id, store_id=store.id,
        entity="stock_count", entity_id=count.id, action="open", before=None, after=out.model_dump(mode="json"),
    )
    return out


@router.get("/admin/counts")
def list_counts_route(
    request: Request,
    store_id: int = Query(...),
    scope: CountScopeLiteral | None = Query(None),
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    format: str | None = Query(None),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(features.require_feature("inventory.counts")),
) -> Any:
    store = admin_store(db, actor, store_id)
    scope_enum = StockCountScope(scope) if scope is not None else None
    counts = service.list_counts(db, store=store, scope=scope_enum, date_from=date_from, date_to=date_to)
    out = []
    for count in counts:
        lines_total, lines_counted = service.count_lines_summary(db, count)
        out.append(service.count_out(count, lines_total=lines_total, lines_counted=lines_counted))
    if wants_csv(request):
        return csv_response([o.model_dump(mode="json") for o in out], "counts.csv")
    return out


@router.get("/admin/counts/{count_id}")
def get_count_route(
    count_id: int,
    store_id: int = Query(...),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(features.require_feature("inventory.counts")),
) -> CountDetailOut:
    store = admin_store(db, actor, store_id)
    count = service.count_or_404(db, store, count_id)
    return service.count_detail_out(db, count)


@router.put("/admin/counts/{count_id}/lines")
def put_count_lines(
    count_id: int,
    body: CountLinesIn,
    store_id: int = Query(...),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(features.require_feature("inventory.counts")),
) -> Any:
    store = admin_store(db, actor, store_id)
    count = service.count_or_404(db, store, count_id)
    out = service.save_count_lines(db, count=count, data=body)
    record_audit(
        db, actor=actor, organization_id=actor.organization_id, store_id=store.id,
        entity="stock_count", entity_id=count.id, action="save_lines", before=None, after=out.model_dump(mode="json"),
    )
    return out


@router.post("/admin/counts/{count_id}/apply")
def post_apply_count(
    count_id: int,
    body: CountApplyIn,
    request: Request,
    store_id: int = Query(...),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(features.require_feature("inventory.counts")),
) -> JSONResponse:
    store = admin_store(db, actor, store_id)
    count = service.count_or_404(db, store, count_id)

    def _do() -> tuple[int, dict[str, Any]]:
        out = service.apply_count(db, count=count, store=store, actor=actor, authorizer_pin=body.authorizer_pin)
        record_audit(
            db, actor=actor, organization_id=actor.organization_id, store_id=store.id,
            entity="stock_count", entity_id=count.id, action="apply", before=None, after=out.model_dump(mode="json"),
        )
        return 200, out.model_dump(mode="json")

    return _idempotent(
        db, organization_id=actor.organization_id, scope="inventory.count_apply", request=request, payload=body, fn=_do
    )


# ---------------------------------------------------------------------------
# Admin: varianza, food cost real y salud del control (`inventory.variance`).
# ---------------------------------------------------------------------------


@router.get("/admin/variance")
def get_variance(
    request: Request,
    store_id: int = Query(...),
    # Opcional: sin `count_id` se usa el último conteo aplicado de la sede
    # (la pestaña abre con él sin que el dueño tenga que elegirlo — informe
    # del analista, #12). `available: false` con motivo si no hay ninguno.
    count_id: int | None = Query(None),
    format: str | None = Query(None),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(features.require_feature("inventory.variance")),
) -> Any:
    store = admin_store(db, actor, store_id)
    out = service.variance_report(db, store=store, count_id=count_id)
    if wants_csv(request):
        return csv_response(
            [r.model_dump(mode="json") for r in out.rows], f"variance-{out.count_id or 'sin-conteo'}.csv"
        )
    return out


@router.get("/admin/food-cost")
def get_food_cost(
    store_id: int = Query(...),
    date_from: date = Query(..., alias="from"),
    date_to: date = Query(..., alias="to"),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(features.require_feature("inventory.variance")),
) -> Any:
    store = admin_store(db, actor, store_id)
    return service.food_cost_report(db, store=store, date_from=date_from, date_to=date_to)


@router.get("/admin/control-health")
def get_control_health(
    store_id: int = Query(...),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(features.require_feature("inventory.variance")),
) -> Any:
    store = admin_store(db, actor, store_id)
    return service.control_health(db, store=store)


# ---------------------------------------------------------------------------
# Conteo corto por área (`inventory.shift_counts`, que requiere
# `inventory.perpetual`: sin libro no hay esperado contra qué medir). La
# dependencia se valida primero, para que el mensaje apunte a lo que falta de
# verdad.
#
# Dispositivo (sin stock, sin conteo anterior, sin costo: a ciegas):
# - `GET  /device/area-count` — la lista del área de la persona identificada,
#   el momento sugerido, si ya contó hoy y los recuentos pedidos.
# - `POST /device/area-counts` — registrar un conteo de apertura o cierre.
# - `POST /device/area-recounts/{id}/answer` — responder un recuento.
#
# Administrador:
# - `GET/POST /admin/count-areas`, `PATCH /admin/count-areas/{id}`,
#   `PUT /admin/count-areas/{id}/items`, `PUT /admin/count-area-members`.
# - `GET/PUT /admin/area-count-settings` — el umbral.
# - `GET /admin/area-counts` (+ CSV), `GET /admin/area-counts/{id}`.
# - `GET/POST /admin/area-recounts`.
#
# Toda escritura del dispositivo y el pedido de recuento aceptan
# `Idempotency-Key`.
# ---------------------------------------------------------------------------

_require_shift_counts_base = features.require_feature("inventory.perpetual")
_require_shift_counts = features.require_feature(area_counts.FEATURE)


@router.get("/device/area-count")
def get_device_area_count(
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_device),
    _base: None = Depends(_require_shift_counts_base),
    _feature: None = Depends(_require_shift_counts),
) -> DeviceAreaCountBoardOut:
    store = _store_for_device(db, actor)
    return area_counts.device_board(db, store=store, actor=actor)


def _count_audit(db: Session, *, actor: Actor, store: Store, count_id: int, out: dict[str, Any]) -> None:
    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="area_count",
        entity_id=count_id,
        action="create",
        before=None,
        after=out,
    )


@router.post("/device/area-counts", status_code=201)
def post_device_area_count(
    body: AreaCountIn,
    request: Request,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_operator),
    _base: None = Depends(_require_shift_counts_base),
    _feature: None = Depends(_require_shift_counts),
) -> JSONResponse:
    store = _store_for_device(db, actor)

    def _do() -> tuple[int, dict[str, Any]]:
        count = area_counts.register_count(db, store=store, actor=actor, data=body)
        out = area_counts.receipt_out(db, count).model_dump(mode="json")
        _count_audit(db, actor=actor, store=store, count_id=count.id, out=out)
        return 201, out

    return _idempotent(
        db, organization_id=store.organization_id, scope="inventory.area_count", request=request, payload=body, fn=_do
    )


@router.post("/device/area-recounts/{request_id}/answer", status_code=201)
def post_device_recount_answer(
    request_id: int,
    body: AreaRecountAnswerIn,
    request: Request,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_operator),
    _base: None = Depends(_require_shift_counts_base),
    _feature: None = Depends(_require_shift_counts),
) -> JSONResponse:
    store = _store_for_device(db, actor)

    def _do() -> tuple[int, dict[str, Any]]:
        count = area_counts.answer_recount(db, store=store, actor=actor, request_id=request_id, data=body)
        out = area_counts.receipt_out(db, count).model_dump(mode="json")
        _count_audit(db, actor=actor, store=store, count_id=count.id, out=out)
        return 201, out

    return _idempotent(
        db,
        organization_id=store.organization_id,
        scope=f"inventory.area_recount.{request_id}",
        request=request,
        payload=body,
        fn=_do,
    )


@router.get("/admin/count-areas")
def get_count_areas(
    store_id: int = Query(...),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _base: None = Depends(_require_shift_counts_base),
    _feature: None = Depends(_require_shift_counts),
) -> list[CountAreaOut]:
    store = admin_store(db, actor, store_id)
    return area_counts.areas_out(db, store=store)


def _area_audit(
    db: Session, *, actor: Actor, store: Store, area_id: int, action: str,
    before: dict[str, Any] | None, after: dict[str, Any] | None,
) -> None:
    record_audit(
        db, actor=actor, organization_id=store.organization_id, store_id=store.id,
        entity="count_area", entity_id=area_id, action=action, before=before, after=after,
    )


def _one_area_out(db: Session, store: Store, area_id: int) -> CountAreaOut:
    return next(a for a in area_counts.areas_out(db, store=store) if a.id == area_id)


@router.post("/admin/count-areas", status_code=201)
def post_count_area(
    body: CountAreaIn,
    store_id: int = Query(...),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _base: None = Depends(_require_shift_counts_base),
    _feature: None = Depends(_require_shift_counts),
) -> CountAreaOut:
    store = admin_store(db, actor, store_id)
    area = area_counts.create_area(db, store=store, data=body)
    out = _one_area_out(db, store, area.id)
    _area_audit(db, actor=actor, store=store, area_id=area.id, action="create", before=None, after=out.model_dump())
    return out


@router.patch("/admin/count-areas/{area_id}")
def patch_count_area(
    area_id: int,
    body: CountAreaUpdateIn,
    store_id: int = Query(...),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _base: None = Depends(_require_shift_counts_base),
    _feature: None = Depends(_require_shift_counts),
) -> CountAreaOut:
    store = admin_store(db, actor, store_id)
    area = area_counts.area_or_404(db, store=store, area_id=area_id)
    before = _one_area_out(db, store, area.id).model_dump()
    area_counts.update_area(db, store=store, area=area, data=body)
    out = _one_area_out(db, store, area.id)
    _area_audit(db, actor=actor, store=store, area_id=area.id, action="update", before=before, after=out.model_dump())
    return out


@router.put("/admin/count-areas/{area_id}/items")
def put_count_area_items(
    area_id: int,
    body: CountAreaItemsIn,
    store_id: int = Query(...),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _base: None = Depends(_require_shift_counts_base),
    _feature: None = Depends(_require_shift_counts),
) -> CountAreaOut:
    store = admin_store(db, actor, store_id)
    area = area_counts.area_or_404(db, store=store, area_id=area_id)
    before = _one_area_out(db, store, area.id).model_dump()
    area_counts.set_area_items(db, store=store, area=area, data=body)
    out = _one_area_out(db, store, area.id)
    _area_audit(db, actor=actor, store=store, area_id=area.id, action="set_items", before=before, after=out.model_dump())
    return out


@router.put("/admin/count-area-members")
def put_count_area_member(
    body: CountAreaMemberIn,
    store_id: int = Query(...),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _base: None = Depends(_require_shift_counts_base),
    _feature: None = Depends(_require_shift_counts),
) -> list[CountAreaOut]:
    store = admin_store(db, actor, store_id)
    previous = area_counts.member_area(db, store=store, employee_id=body.employee_id)
    area_counts.set_member(db, store=store, data=body)
    record_audit(
        db, actor=actor, organization_id=store.organization_id, store_id=store.id,
        entity="count_area_member", entity_id=body.employee_id, action="assign",
        before={"area_id": previous.id if previous is not None else None},
        after={"area_id": body.area_id},
    )
    return area_counts.areas_out(db, store=store)


@router.get("/admin/area-count-settings")
def get_area_count_settings(
    store_id: int = Query(...),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _base: None = Depends(_require_shift_counts_base),
    _feature: None = Depends(_require_shift_counts),
) -> AreaCountSettingsOut:
    store = admin_store(db, actor, store_id)
    return area_counts.settings_out(db, store)


@router.put("/admin/area-count-settings")
def put_area_count_settings(
    body: AreaCountSettingsIn,
    store_id: int = Query(...),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _base: None = Depends(_require_shift_counts_base),
    _feature: None = Depends(_require_shift_counts),
) -> AreaCountSettingsOut:
    store = admin_store(db, actor, store_id)
    before = area_counts.settings_out(db, store).model_dump()
    after = area_counts.update_settings(db, store, body)
    record_audit(
        db, actor=actor, organization_id=store.organization_id, store_id=store.id,
        entity="area_count_settings", entity_id=store.id, action="update", before=before, after=after.model_dump(),
    )
    return after


@router.get("/admin/area-counts")
def get_area_counts(
    request: Request,
    store_id: int = Query(...),
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    area_id: int | None = Query(None),
    format: str | None = Query(None),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _base: None = Depends(_require_shift_counts_base),
    _feature: None = Depends(_require_shift_counts),
) -> Any:
    store = admin_store(db, actor, store_id)
    rows = area_counts.list_counts(db, store=store, date_from=date_from, date_to=date_to, area_id=area_id)
    out: list[AreaCountOut] = [area_counts.count_summary(db, store=store, count=c) for c in rows]
    if wants_csv(request):
        return csv_response([o.model_dump(mode="json") for o in out], "conteos-por-area.csv")
    return out


@router.get("/admin/area-counts/{count_id}")
def get_area_count(
    count_id: int,
    store_id: int = Query(...),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _base: None = Depends(_require_shift_counts_base),
    _feature: None = Depends(_require_shift_counts),
) -> AreaCountDetailOut:
    store = admin_store(db, actor, store_id)
    count = area_counts.count_or_404(db, store=store, count_id=count_id)
    return area_counts.count_detail(db, store=store, count=count)


@router.get("/admin/area-recounts")
def get_area_recounts(
    store_id: int = Query(...),
    status: AreaRecountStatusLiteral | None = Query(None),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _base: None = Depends(_require_shift_counts_base),
    _feature: None = Depends(_require_shift_counts),
) -> list[AreaRecountRequestOut]:
    store = admin_store(db, actor, store_id)
    return [area_counts.recount_out(db, r) for r in area_counts.list_recounts(db, store=store, status=status)]


@router.post("/admin/area-recounts", status_code=201)
def post_area_recount(
    body: AreaRecountRequestIn,
    request: Request,
    store_id: int = Query(...),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _base: None = Depends(_require_shift_counts_base),
    _feature: None = Depends(_require_shift_counts),
) -> JSONResponse:
    store = admin_store(db, actor, store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        row = area_counts.create_recount(db, store=store, actor=actor, data=body)
        out = area_counts.recount_out(db, row).model_dump(mode="json")
        record_audit(
            db, actor=actor, organization_id=store.organization_id, store_id=store.id,
            entity="area_recount", entity_id=row.id, action="create", before=None, after=out,
        )
        return 201, out

    return _idempotent(
        db, organization_id=store.organization_id, scope="inventory.area_recount_request", request=request,
        payload=body, fn=_do,
    )
