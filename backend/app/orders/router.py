"""Endpoints de la comanda (`/api/v1/...`), `CONTRATO-INTERNO-1b-1.md §2.4`.

Lectura con `current_device` (persona opcional); escritura con
`current_operator` (persona vigente); admin con `current_admin` + `admin_store`.
`GET /orders/favorites` se declara ANTES de `GET /orders/{id}` — si no, FastAPI
la captura como `id="favorites"`.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth.deps import Actor, admin_store, current_admin, current_device, current_operator
from app.core import features
from app.core.csv import csv_response, wants_csv
from app.core.db import get_db
from app.core.errors import AppError, NotFoundError
from app.core.idempotency import hash_request_body, idempotency_key, run_idempotent
from app.orders import service
from app.orders.models import Order
from app.orders.schemas import (
    AddItemsIn,
    BillSplitEqualOut,
    BillSplitIn,
    BillSplitItemsOut,
    CourtesyItemIn,
    DiscountIn,
    ExpectedVersionIn,
    FavoriteOut,
    MergeIn,
    MoveIn,
    OrderCreateIn,
    OrderOut,
    PatchItemIn,
    PreBillOut,
    SubAccountOut,
    TablesStatusOut,
    VoidItemIn,
    VoidOrderIn,
)
from app.stores.models import Store

router = APIRouter()


def _store_of(db: Session, actor: Actor) -> Store:
    store = db.get(Store, actor.store_id)
    if store is None:
        raise AppError("DEVICE_NOT_ACTIVATED", "Activá el dispositivo con el PIN de sede", status=401)
    return store


def _idempotent(
    db: Session,
    *,
    organization_id: int,
    scope: str,
    request: Request,
    extra: dict[str, Any],
    payload: BaseModel | None,
    fn: Callable[[], tuple[int, dict[str, Any]]],
) -> JSONResponse:
    """El hash incluye los ids del path (`order_id`, `item_id`...): la clave
    de idempotencia es global al scope, no por comanda, así que dos comandas
    distintas con la misma clave y un body parecido no deben pisarse."""
    body: dict[str, Any] = dict(extra)
    if payload is not None:
        body.update(payload.model_dump(mode="json"))
    key = idempotency_key(request)
    request_hash = hash_request_body(body)
    status_code, resp_body = run_idempotent(db, organization_id=organization_id, scope=scope, key=key, request_hash=request_hash, fn=fn)
    return JSONResponse(status_code=status_code, content=resp_body)


def _for_device(actor: Actor) -> bool:
    return actor.kind != "admin"


# ---------------------------------------------------------------------------
# Mesas
# ---------------------------------------------------------------------------


@router.get("/tables/status")
def get_tables_status(actor: Actor = Depends(current_device), db: Session = Depends(get_db)) -> TablesStatusOut:
    # Ver nota en `app.kitchen.router.get_kitchen_rounds`: `require_feature`
    # como *dependency* exigiría un operador identificado; esta es una
    # lectura de dispositivo con persona opcional (sondeo del mapa de mesas).
    features.assert_feature(db, actor.organization_id, actor.store_id, "pos.tables")
    return service.tables_status(db, store_id=actor.store_id)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Comandas
# ---------------------------------------------------------------------------


@router.post("/orders", status_code=201)
def post_create_order(payload: OrderCreateIn, actor: Actor = Depends(current_operator), db: Session = Depends(get_db)) -> OrderOut:
    store = _store_of(db, actor)
    order = service.create_order(db, actor=actor, store=store, payload=payload)
    return service.order_out(db, order, for_device=_for_device(actor))


@router.get("/orders")
def get_orders(
    status: str | None = Query(None),
    channel: str | None = Query(None),
    actor: Actor = Depends(current_device),
    db: Session = Depends(get_db),
) -> list[OrderOut]:
    orders = service.list_orders(db, actor=actor, status=status, channel=channel)
    return [service.order_out(db, o, for_device=True) for o in orders]


@router.get("/orders/favorites")
def get_favorites(actor: Actor = Depends(current_device), db: Session = Depends(get_db)) -> list[FavoriteOut]:
    return service.list_favorites(db, store_id=actor.store_id)  # type: ignore[arg-type]


@router.get("/orders/{order_id}")
def get_order(order_id: int, actor: Actor = Depends(current_device), db: Session = Depends(get_db)) -> OrderOut:
    order = service.get_order_or_404(db, actor=actor, order_id=order_id)
    return service.order_out(db, order, for_device=True)


@router.post("/orders/{order_id}/items")
def post_add_items(
    order_id: int, payload: AddItemsIn, request: Request, actor: Actor = Depends(current_operator), db: Session = Depends(get_db)
) -> JSONResponse:
    order = service.get_order_or_404(db, actor=actor, order_id=order_id)

    def _do() -> tuple[int, dict[str, Any]]:
        updated = service.add_items(db, order=order, actor=actor, payload=payload)
        return 200, service.order_out(db, updated, for_device=True).model_dump(mode="json")

    return _idempotent(db, organization_id=actor.organization_id, scope="orders.items", request=request, extra={"order_id": order_id}, payload=payload, fn=_do)


@router.patch("/orders/{order_id}/items/{item_id}")
def patch_item(order_id: int, item_id: int, payload: PatchItemIn, actor: Actor = Depends(current_operator), db: Session = Depends(get_db)) -> OrderOut:
    order = service.get_order_or_404(db, actor=actor, order_id=order_id)
    updated = service.patch_item(db, order=order, item_id=item_id, actor=actor, payload=payload)
    return service.order_out(db, updated, for_device=True)


@router.post("/orders/{order_id}/send", dependencies=[Depends(features.require_feature("kitchen.view"))])
def post_send(order_id: int, payload: ExpectedVersionIn, request: Request, actor: Actor = Depends(current_operator), db: Session = Depends(get_db)) -> JSONResponse:
    order = service.get_order_or_404(db, actor=actor, order_id=order_id)

    def _do() -> tuple[int, dict[str, Any]]:
        updated = service.send_order(db, order=order, actor=actor, expected_version=payload.expected_version)
        return 200, service.order_out(db, updated, for_device=True).model_dump(mode="json")

    return _idempotent(db, organization_id=actor.organization_id, scope="orders.send", request=request, extra={"order_id": order_id}, payload=payload, fn=_do)


@router.post("/orders/{order_id}/items/{item_id}/ready", dependencies=[Depends(features.require_feature("kitchen.view"))])
def post_item_ready(order_id: int, item_id: int, request: Request, actor: Actor = Depends(current_device), db: Session = Depends(get_db)) -> JSONResponse:
    order = service.get_order_or_404(db, actor=actor, order_id=order_id)

    def _do() -> tuple[int, dict[str, Any]]:
        updated = service.mark_ready(db, order=order, item_id=item_id, actor=actor)
        return 200, service.order_out(db, updated, for_device=True).model_dump(mode="json")

    return _idempotent(db, organization_id=actor.organization_id, scope="orders.ready", request=request, extra={"order_id": order_id, "item_id": item_id}, payload=None, fn=_do)


@router.post("/orders/{order_id}/items/{item_id}/served")
def post_item_served(order_id: int, item_id: int, request: Request, actor: Actor = Depends(current_operator), db: Session = Depends(get_db)) -> JSONResponse:
    order = service.get_order_or_404(db, actor=actor, order_id=order_id)

    def _do() -> tuple[int, dict[str, Any]]:
        updated = service.mark_served(db, order=order, item_id=item_id, actor=actor)
        return 200, service.order_out(db, updated, for_device=True).model_dump(mode="json")

    return _idempotent(db, organization_id=actor.organization_id, scope="orders.served", request=request, extra={"order_id": order_id, "item_id": item_id}, payload=None, fn=_do)


@router.post("/orders/{order_id}/items/{item_id}/void")
def post_item_void(order_id: int, item_id: int, payload: VoidItemIn, actor: Actor = Depends(current_operator), db: Session = Depends(get_db)) -> OrderOut:
    order = service.get_order_or_404(db, actor=actor, order_id=order_id)
    updated = service.void_item(db, order=order, item_id=item_id, actor=actor, expected_version=payload.expected_version, reason=payload.reason, note=payload.note, authorizer_pin=payload.authorizer_pin)
    return service.order_out(db, updated, for_device=True)


@router.post("/orders/{order_id}/items/{item_id}/courtesy", dependencies=[Depends(features.require_feature("pos.courtesies"))])
def post_item_courtesy(order_id: int, item_id: int, payload: CourtesyItemIn, actor: Actor = Depends(current_operator), db: Session = Depends(get_db)) -> OrderOut:
    order = service.get_order_or_404(db, actor=actor, order_id=order_id)
    updated = service.courtesy_item(db, order=order, item_id=item_id, actor=actor, payload=payload)
    return service.order_out(db, updated, for_device=True)


@router.post("/orders/{order_id}/discounts", dependencies=[Depends(features.require_feature("pos.discounts"))])
def post_discount(order_id: int, payload: DiscountIn, actor: Actor = Depends(current_operator), db: Session = Depends(get_db)) -> OrderOut:
    order = service.get_order_or_404(db, actor=actor, order_id=order_id)
    updated = service.add_discount(db, order=order, actor=actor, payload=payload)
    return service.order_out(db, updated, for_device=True)


@router.delete("/orders/{order_id}/discounts/{discount_id}", dependencies=[Depends(features.require_feature("pos.discounts"))])
def delete_discount(
    order_id: int, discount_id: int, expected_version: int = Query(...), actor: Actor = Depends(current_operator), db: Session = Depends(get_db)
) -> OrderOut:
    # `expected_version` va en la query (no en el body): varios clientes HTTP
    # (incluido `httpx`/`fetch`) no soportan un cuerpo JSON en `DELETE` de
    # forma confiable. Decisión declarada en el entregable.
    order = service.get_order_or_404(db, actor=actor, order_id=order_id)
    updated = service.remove_discount(db, order=order, discount_id=discount_id, actor=actor, expected_version=expected_version)
    return service.order_out(db, updated, for_device=True)


@router.post("/orders/{order_id}/merge", dependencies=[Depends(features.require_feature("pos.tables"))])
def post_merge(order_id: int, payload: MergeIn, actor: Actor = Depends(current_operator), db: Session = Depends(get_db)) -> OrderOut:
    order = service.get_order_or_404(db, actor=actor, order_id=order_id)
    updated = service.merge_orders(db, order=order, actor=actor, payload=payload)
    return service.order_out(db, updated, for_device=True)


@router.post("/orders/{order_id}/move", dependencies=[Depends(features.require_feature("pos.tables"))])
def post_move(order_id: int, payload: MoveIn, actor: Actor = Depends(current_operator), db: Session = Depends(get_db)) -> OrderOut:
    order = service.get_order_or_404(db, actor=actor, order_id=order_id)
    updated = service.move_order(db, order=order, actor=actor, payload=payload)
    return service.order_out(db, updated, for_device=True)


@router.post("/orders/{order_id}/void")
def post_void_order(order_id: int, payload: VoidOrderIn, actor: Actor = Depends(current_operator), db: Session = Depends(get_db)) -> OrderOut:
    order = service.get_order_or_404(db, actor=actor, order_id=order_id)
    updated = service.void_order(db, order=order, actor=actor, payload=payload)
    return service.order_out(db, updated, for_device=True)


@router.post("/orders/{order_id}/bill/present", dependencies=[Depends(features.require_feature("pos.pre_bill"))])
def post_bill_present(order_id: int, payload: ExpectedVersionIn, request: Request, actor: Actor = Depends(current_operator), db: Session = Depends(get_db)) -> JSONResponse:
    order = service.get_order_or_404(db, actor=actor, order_id=order_id)

    def _do() -> tuple[int, dict[str, Any]]:
        updated = service.present_bill(db, order=order, actor=actor, expected_version=payload.expected_version)
        pre_bill = service.build_pre_bill(db, updated)
        return 200, pre_bill.model_dump(mode="json")

    return _idempotent(db, organization_id=actor.organization_id, scope="orders.bill_present", request=request, extra={"order_id": order_id}, payload=payload, fn=_do)


@router.post("/orders/{order_id}/bill/split", dependencies=[Depends(features.require_feature("pos.split_bill"))])
def post_bill_split(order_id: int, payload: BillSplitIn, actor: Actor = Depends(current_operator), db: Session = Depends(get_db)) -> BillSplitEqualOut | BillSplitItemsOut:
    order = service.get_order_or_404(db, actor=actor, order_id=order_id)
    if payload.mode == "equal":
        if not payload.parts:
            raise AppError("VALIDATION_ERROR", "parts: obligatorio para dividir en partes iguales")
        per_part, total = service.split_bill_equal(db, order=order, actor=actor, expected_version=payload.expected_version, parts=payload.parts)
        return BillSplitEqualOut(parts=payload.parts, per_part=per_part, total=total)
    groups = payload.groups or []
    accounts = service.split_bill_items(db, order=order, actor=actor, expected_version=payload.expected_version, groups=groups)
    return BillSplitItemsOut(sub_accounts=[service.sub_account_out(db, a) for a in accounts])


@router.get("/orders/{order_id}/sub-accounts")
def get_sub_accounts(order_id: int, actor: Actor = Depends(current_device), db: Session = Depends(get_db)) -> list[SubAccountOut]:
    order = service.get_order_or_404(db, actor=actor, order_id=order_id)
    accounts = service.list_sub_accounts(db, order)
    return [service.sub_account_out(db, a) for a in accounts]


# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------


@router.get("/admin/orders")
def get_admin_orders(
    request: Request,
    store_id: int = Query(...),
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    status: str | None = Query(None),
    channel: str | None = Query(None),
    flags: str | None = Query(None),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]] | Any:
    admin_store(db, actor, store_id)
    flags_list = flags.split(",") if flags else None
    rows = service.admin_list_orders(db, store_id=store_id, date_from=date_from, date_to=date_to, status=status, channel=channel, flags=flags_list)
    if wants_csv(request):
        return csv_response(rows, filename="pedidos.csv")
    return rows


@router.get("/admin/orders/{order_id}")
def get_admin_order(order_id: int, actor: Actor = Depends(current_admin), db: Session = Depends(get_db)) -> OrderOut:
    order = db.get(Order, order_id)
    if order is None or order.organization_id != actor.organization_id:
        raise NotFoundError("La comanda no existe")
    admin_store(db, actor, order.store_id)
    return service.order_out(db, order, for_device=False)
