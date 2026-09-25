"""Endpoints de las solicitudes del salón (`/api/v1/requests/...` y
`/api/v1/admin/requests/...`). Sólo borde HTTP: la lógica vive en `service`.

Operador (tablet, persona identificada), detrás de `pos.requests`:
- `GET  /requests/supply-suggestions` — insumos bajo mínimo o en negativo, sin costos.
- `POST /requests/supplies` — pedido de insumos (exige además «Inventario perpetuo»).
- `POST /requests/change` — pedido de sencilla (exige además «Cambio de denominaciones»).
- `GET  /requests/mine` — las del turno abierto y las aprobadas pendientes.
- `POST /requests/{id}/received` — la sencilla aprobada llegó.

Administrador:
- `GET  /admin/requests?store_id=&status=&kind=`
- `GET  /admin/requests/supplies?store_id=&status=approved` — la lista de Compras.
- `POST /admin/requests/{id}/approve` (con ajustes), `/reject`, `/mark-bought`.

Toda escritura exige `Idempotency-Key`.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth.deps import Actor, admin_store, current_admin, current_operator
from app.core import features
from app.core.db import get_db
from app.core.errors import AppError
from app.core.idempotency import hash_request_body, idempotency_key, run_idempotent
from app.requests import service
from app.requests.models import StaffRequestKind, StaffRequestStatus
from app.requests.schemas import (
    ApproveIn,
    ChangeRequestIn,
    MarkBoughtIn,
    ReceivedIn,
    RejectIn,
    StaffRequestKindLiteral,
    StaffRequestOut,
    StaffRequestStatusLiteral,
    SupplyRequestIn,
    SupplySuggestionsOut,
)
from app.stores.models import Store

router = APIRouter()

_require = features.require_feature(service.FEATURE)


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


def _device_store(db: Session, actor: Actor) -> Store:
    store = db.get(Store, actor.store_id)
    if store is None:
        raise AppError("DEVICE_NOT_ACTIVATED", "Activá el dispositivo con el PIN de sede", status=401)
    return store


def _one(db: Session, request_row: Any) -> dict[str, Any]:
    return service.to_out_many(db, [request_row])[0].model_dump(mode="json")


# ---------------------------------------------------------------------------
# Operador
# ---------------------------------------------------------------------------


@router.get("/requests/supply-suggestions", dependencies=[Depends(_require)])
def get_supply_suggestions(
    actor: Actor = Depends(current_operator), db: Session = Depends(get_db)
) -> SupplySuggestionsOut:
    return service.supply_suggestions(db, store=_device_store(db, actor))


@router.post("/requests/supplies", status_code=201, dependencies=[Depends(_require)])
def post_supply_request(
    payload: SupplyRequestIn,
    request: Request,
    actor: Actor = Depends(current_operator),
    db: Session = Depends(get_db),
) -> StaffRequestOut:
    store = _device_store(db, actor)

    def _do() -> tuple[int, dict[str, Any]]:
        row = service.create_supply_request(db, actor=actor, store=store, payload=payload)
        return 201, _one(db, row)

    return _idempotent(  # type: ignore[return-value]
        db, organization_id=actor.organization_id, scope="requests.supplies", request=request, payload=payload, fn=_do
    )


@router.post("/requests/change", status_code=201, dependencies=[Depends(_require)])
def post_change_request(
    payload: ChangeRequestIn,
    request: Request,
    actor: Actor = Depends(current_operator),
    db: Session = Depends(get_db),
) -> StaffRequestOut:
    store = _device_store(db, actor)

    def _do() -> tuple[int, dict[str, Any]]:
        row = service.create_change_request(db, actor=actor, store=store, payload=payload)
        return 201, _one(db, row)

    return _idempotent(  # type: ignore[return-value]
        db, organization_id=actor.organization_id, scope="requests.change", request=request, payload=payload, fn=_do
    )


@router.get("/requests/mine", dependencies=[Depends(_require)])
def get_my_requests(
    actor: Actor = Depends(current_operator), db: Session = Depends(get_db)
) -> list[StaffRequestOut]:
    store = _device_store(db, actor)
    return service.to_out_many(db, service.list_mine(db, store=store))


@router.post("/requests/{request_id}/received", dependencies=[Depends(_require)])
def post_received(
    request_id: int,
    payload: ReceivedIn,
    request: Request,
    actor: Actor = Depends(current_operator),
    db: Session = Depends(get_db),
) -> StaffRequestOut:
    store = _device_store(db, actor)

    def _do() -> tuple[int, dict[str, Any]]:
        row = service.mark_received(db, actor=actor, store=store, request_id=request_id, payload=payload)
        return 200, _one(db, row)

    return _idempotent(  # type: ignore[return-value]
        db,
        organization_id=actor.organization_id,
        scope=f"requests.received.{request_id}",
        request=request,
        payload=payload,
        fn=_do,
    )


# ---------------------------------------------------------------------------
# Administrador
# ---------------------------------------------------------------------------


def _admin_list(
    db: Session,
    actor: Actor,
    store_id: int,
    status: StaffRequestStatusLiteral | None,
    kind: StaffRequestKind | None,
) -> list[StaffRequestOut]:
    store = admin_store(db, actor, store_id)
    rows = service.list_for_admin(
        db,
        store=store,
        status=StaffRequestStatus(status) if status is not None else None,
        kind=kind,
    )
    return service.to_out_many(db, rows)


@router.get("/admin/requests", dependencies=[Depends(_require)])
def get_admin_requests(
    store_id: int = Query(...),
    status: StaffRequestStatusLiteral | None = Query(None),
    kind: StaffRequestKindLiteral | None = Query(None),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> list[StaffRequestOut]:
    return _admin_list(db, actor, store_id, status, StaffRequestKind(kind) if kind is not None else None)


@router.get("/admin/requests/supplies", dependencies=[Depends(_require)])
def get_admin_supply_requests(
    store_id: int = Query(...),
    status: StaffRequestStatusLiteral | None = Query("approved"),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> list[StaffRequestOut]:
    """La lista de Compras: por defecto, los pedidos aprobados y por comprar."""
    return _admin_list(db, actor, store_id, status, StaffRequestKind.SUPPLY)


@router.post("/admin/requests/{request_id}/approve")
def post_approve(
    request_id: int,
    payload: ApproveIn,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> StaffRequestOut:
    def _do() -> tuple[int, dict[str, Any]]:
        row = service.get_for_admin(db, actor=actor, request_id=request_id)
        return 200, _one(db, service.approve(db, actor=actor, request=row, payload=payload))

    return _idempotent(  # type: ignore[return-value]
        db,
        organization_id=actor.organization_id,
        scope=f"requests.approve.{request_id}",
        request=request,
        payload=payload,
        fn=_do,
    )


@router.post("/admin/requests/{request_id}/reject")
def post_reject(
    request_id: int,
    payload: RejectIn,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> StaffRequestOut:
    def _do() -> tuple[int, dict[str, Any]]:
        row = service.get_for_admin(db, actor=actor, request_id=request_id)
        return 200, _one(db, service.reject(db, actor=actor, request=row, payload=payload))

    return _idempotent(  # type: ignore[return-value]
        db,
        organization_id=actor.organization_id,
        scope=f"requests.reject.{request_id}",
        request=request,
        payload=payload,
        fn=_do,
    )


@router.post("/admin/requests/{request_id}/mark-bought")
def post_mark_bought(
    request_id: int,
    payload: MarkBoughtIn,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> StaffRequestOut:
    def _do() -> tuple[int, dict[str, Any]]:
        row = service.get_for_admin(db, actor=actor, request_id=request_id)
        return 200, _one(db, service.mark_bought(db, actor=actor, request=row, note=payload.note))

    return _idempotent(  # type: ignore[return-value]
        db,
        organization_id=actor.organization_id,
        scope=f"requests.mark_bought.{request_id}",
        request=request,
        payload=payload,
        fn=_do,
    )
