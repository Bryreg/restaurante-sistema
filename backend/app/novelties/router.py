"""Endpoints de las novedades del turno. Sólo borde HTTP: la lógica vive en
`service`. Todo detrás de `pos.novelties`.

Dispositivo:
- `GET  /novelties/open` — las abiertas (de cualquier turno) y las del turno.
  Dispositivo activado; la persona es opcional (es una lectura que el POS
  consulta seguido).
- `POST /novelties` — registrar (persona identificada).
- `POST /novelties/{id}/resolve` — resolver con nota (persona identificada).

Administrador:
- `GET  /admin/novelties?store_id=&status=open|all&from=&to=` (+ `format=csv`)
- `POST /admin/novelties/{id}/resolve?store_id=`

Toda escritura acepta `Idempotency-Key`.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.auth.deps import Actor, admin_store, current_admin, current_device, current_operator
from app.core import features
from app.core.csv import csv_response, wants_csv
from app.core.db import get_db
from app.core.errors import AppError
from app.core.idempotency import hash_request_body, idempotency_key, run_idempotent
from app.novelties import service
from app.novelties.schemas import NoveltyBoardOut, NoveltyIn, NoveltyOut, NoveltyResolveIn, NoveltyStatusLiteral
from app.stores.models import Store

router = APIRouter()

FEATURE = "pos.novelties"
_require = features.require_feature(FEATURE)


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


# ---------------------------------------------------------------------------
# Dispositivo.
# ---------------------------------------------------------------------------


@router.get("/novelties/open")
def get_board(
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_device),
    _feature: None = Depends(_require),
) -> NoveltyBoardOut:
    store = _device_store(db, actor)
    return service.board(db, store=store)


@router.post("/novelties", status_code=201)
def post_novelty(
    body: NoveltyIn,
    request: Request,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_operator),
    _feature: None = Depends(_require),
) -> JSONResponse:
    store = _device_store(db, actor)

    def _do() -> tuple[int, dict[str, Any]]:
        row = service.create_novelty(db, store=store, actor=actor, data=body)
        out = service.novelty_out(row).model_dump(mode="json")
        record_audit(
            db,
            actor=actor,
            organization_id=store.organization_id,
            store_id=store.id,
            entity="novelty",
            entity_id=row.id,
            action="create",
            before=None,
            after=out,
        )
        return 201, out

    return _idempotent(
        db, organization_id=store.organization_id, scope="novelties.create", request=request, payload=body, fn=_do
    )


def _resolve(
    db: Session, *, store: Store, actor: Actor, novelty_id: int, body: NoveltyResolveIn, request: Request
) -> JSONResponse:
    def _do() -> tuple[int, dict[str, Any]]:
        row = service.resolve_novelty(db, store=store, actor=actor, novelty_id=novelty_id, data=body)
        out = service.novelty_out(row).model_dump(mode="json")
        record_audit(
            db,
            actor=actor,
            organization_id=store.organization_id,
            store_id=store.id,
            entity="novelty",
            entity_id=row.id,
            action="resolve",
            before={"resolved_at": None},
            after=out,
            reason=row.resolution_note,
        )
        return 200, out

    return _idempotent(
        db,
        organization_id=store.organization_id,
        scope=f"novelties.resolve.{novelty_id}",
        request=request,
        payload=body,
        fn=_do,
    )


@router.post("/novelties/{novelty_id}/resolve")
def post_resolve(
    novelty_id: int,
    body: NoveltyResolveIn,
    request: Request,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_operator),
    _feature: None = Depends(_require),
) -> JSONResponse:
    store = _device_store(db, actor)
    return _resolve(db, store=store, actor=actor, novelty_id=novelty_id, body=body, request=request)


# ---------------------------------------------------------------------------
# Administrador.
# ---------------------------------------------------------------------------


@router.get("/admin/novelties")
def get_admin_novelties(
    request: Request,
    store_id: int = Query(...),
    status: NoveltyStatusLiteral = Query("open"),
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    format: str | None = Query(None),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(_require),
) -> Any:
    store = admin_store(db, actor, store_id)
    rows = service.list_admin(db, store=store, status=status, date_from=date_from, date_to=date_to)
    out: list[NoveltyOut] = [service.novelty_out(r) for r in rows]
    if wants_csv(request):
        return csv_response([o.model_dump(mode="json") for o in out], "novedades.csv")
    return out


@router.post("/admin/novelties/{novelty_id}/resolve")
def post_admin_resolve(
    novelty_id: int,
    body: NoveltyResolveIn,
    request: Request,
    store_id: int = Query(...),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(_require),
) -> JSONResponse:
    store = admin_store(db, actor, store_id)
    return _resolve(db, store=store, actor=actor, novelty_id=novelty_id, body=body, request=request)
