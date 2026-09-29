"""Endpoints de las etiquetas de cocina. Sólo borde HTTP: la lógica vive en
`service`. Todo detrás de `inventory.labels`.

Dispositivo (persona identificada para escribir):
- `GET  /device/labels` — las etiquetas activas, la que vence primero arriba.
- `GET  /device/labels/sources` — qué se puede etiquetar: insumos para
  «Abrí», lo recibido y lo producido de los últimos días.
- `GET  /device/labels/settings` — el tamaño de la etiqueta de la sede.
- `GET  /device/labels/{code}` — leer una etiqueta escaneada.
- `POST /labels` — imprimir (1 a 30 copias, cada una con su código);
  responde `{labels: [...]}`.
- `POST /labels/{code}/reprint` — reimprimir (queda contado).
- `POST /labels/{code}/finish` — se acabó / se botó (botar es merma, con PIN).

Administrador:
- `GET /admin/labels?store_id=&status=active|closed|all&from=&to=` (+ `format=csv`)
- `GET|PUT /admin/stores/{store_id}/label-settings`

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
from app.labels import service
from app.labels.schemas import (
    LabelBoardOut,
    LabelCreateIn,
    LabelFilterLiteral,
    LabelFinishIn,
    LabelOut,
    LabelSettingsIn,
    LabelSettingsOut,
    LabelSourcesOut,
)
from app.stores.models import Store

router = APIRouter()

FEATURE = "inventory.labels"
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


def _one(db: Session, store: Store, row: Any) -> LabelOut:
    return service.labels_out(db, [row], today=service._today(store))[0]


# ---------------------------------------------------------------------------
# Dispositivo.
# ---------------------------------------------------------------------------


@router.get("/device/labels")
def get_board(
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_device),
    _feature: None = Depends(_require),
) -> LabelBoardOut:
    return service.board(db, store=_device_store(db, actor))


@router.get("/device/labels/sources")
def get_sources(
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_device),
    _feature: None = Depends(_require),
) -> LabelSourcesOut:
    return service.sources(db, store=_device_store(db, actor))


@router.get("/device/labels/settings")
def get_device_settings(
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_device),
    _feature: None = Depends(_require),
) -> LabelSettingsOut:
    return service.get_settings(db, store=_device_store(db, actor))


@router.get("/device/labels/{code}")
def get_one(
    code: str,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_device),
    _feature: None = Depends(_require),
) -> LabelOut:
    store = _device_store(db, actor)
    return _one(db, store, service.get_label(db, store=store, code=code))


@router.post("/labels", status_code=201)
def post_labels(
    body: LabelCreateIn,
    request: Request,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_operator),
    _feature: None = Depends(_require),
) -> JSONResponse:
    store = _device_store(db, actor)

    def _do() -> tuple[int, dict[str, Any]]:
        rows = service.create_labels(db, store=store, actor=actor, data=body)
        out = [o.model_dump(mode="json") for o in service.labels_out(db, rows, today=service._today(store))]
        for item in out:
            record_audit(
                db,
                actor=actor,
                organization_id=store.organization_id,
                store_id=store.id,
                entity="food_label",
                entity_id=item["id"],
                action="create",
                before=None,
                after=item,
            )
        return 201, {"labels": out}

    return _idempotent(
        db, organization_id=store.organization_id, scope="labels.create", request=request, payload=body, fn=_do
    )


class _Empty(BaseModel):
    pass


@router.post("/labels/{code}/reprint")
def post_reprint(
    code: str,
    request: Request,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_operator),
    _feature: None = Depends(_require),
) -> JSONResponse:
    store = _device_store(db, actor)

    def _do() -> tuple[int, dict[str, Any]]:
        row = service.reprint(db, store=store, code=code)
        out = _one(db, store, row).model_dump(mode="json")
        record_audit(
            db,
            actor=actor,
            organization_id=store.organization_id,
            store_id=store.id,
            entity="food_label",
            entity_id=row.id,
            action="reprint",
            before={"print_count": row.print_count - 1},
            after={"print_count": row.print_count},
        )
        return 200, out

    return _idempotent(
        db,
        organization_id=store.organization_id,
        scope=f"labels.reprint.{service.normalize_code(code)}",
        request=request,
        payload=_Empty(),
        fn=_do,
    )


@router.post("/labels/{code}/finish")
def post_finish(
    code: str,
    body: LabelFinishIn,
    request: Request,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_operator),
    _feature: None = Depends(_require),
) -> JSONResponse:
    store = _device_store(db, actor)

    def _do() -> tuple[int, dict[str, Any]]:
        row, waste = service.finish(db, store=store, actor=actor, code=code, data=body)
        out = _one(db, store, row).model_dump(mode="json")
        if waste is not None:
            from app.inventory import service as inventory_service

            record_audit(
                db,
                actor=actor,
                organization_id=store.organization_id,
                store_id=store.id,
                entity="waste",
                entity_id=waste.id,
                action="create",
                before=None,
                after=inventory_service.waste_admin_out(waste).model_dump(mode="json"),
            )
        record_audit(
            db,
            actor=actor,
            organization_id=store.organization_id,
            store_id=store.id,
            entity="food_label",
            entity_id=row.id,
            action=body.outcome,
            before={"status": "active"},
            after=out,
            reason=body.note,
        )
        return 200, out

    return _idempotent(
        db,
        organization_id=store.organization_id,
        scope=f"labels.finish.{service.normalize_code(code)}",
        request=request,
        payload=body,
        fn=_do,
    )


# ---------------------------------------------------------------------------
# Administrador.
# ---------------------------------------------------------------------------


@router.get("/admin/labels")
def get_admin_labels(
    request: Request,
    store_id: int = Query(...),
    status: LabelFilterLiteral = Query("active"),
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    format: str | None = Query(None),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(_require),
) -> Any:
    store = admin_store(db, actor, store_id)
    out = service.list_admin(db, store=store, status=status, date_from=date_from, date_to=date_to)
    if wants_csv(request):
        return csv_response([o.model_dump(mode="json") for o in out], "etiquetas.csv")
    return out


@router.get("/admin/stores/{store_id}/label-settings")
def get_admin_settings(
    store_id: int,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(_require),
) -> LabelSettingsOut:
    return service.get_settings(db, store=admin_store(db, actor, store_id))


@router.put("/admin/stores/{store_id}/label-settings")
def put_admin_settings(
    store_id: int,
    body: LabelSettingsIn,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
    _feature: None = Depends(_require),
) -> LabelSettingsOut:
    store = admin_store(db, actor, store_id)
    before, after = service.put_settings(db, store=store, data=body)
    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="label_settings",
        entity_id=store.id,
        action="update",
        before=before.model_dump(mode="json"),
        after=after.model_dump(mode="json"),
    )
    return after
