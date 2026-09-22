"""Rutas de reservas (`/api/v1/...`).

Las de lectura y creación son del **dispositivo**: quien contesta el teléfono
y aparta la mesa está en el salón, no en la oficina. La lista del día también
la ve el administrador, que es quien mira a fin de mes cuántos no llegaron.

Todo detrás de `pos.reservations`: con la función apagada, `400
FEATURE_DISABLED` antes de llegar al servicio.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.auth.deps import Actor, admin_store, current_actor, current_admin, current_operator
from app.core import features
from app.core.db import get_db
from app.core.errors import AppError
from app.core.idempotency import hash_request_body, idempotency_key, run_idempotent
from app.reservations import service
from app.reservations.schemas import ReservationCloseIn, ReservationIn, ReservationOut
from app.stores.models import Store

router = APIRouter()

GATE = Depends(features.require_feature("pos.reservations"))


def _store_of(db: Session, actor: Actor) -> Store:
    store = db.get(Store, actor.store_id)
    if store is None:
        raise AppError("DEVICE_NOT_ACTIVATED", "Activá el dispositivo con el PIN de sede", status=401)
    return store


@router.get("/reservations", dependencies=[GATE])
def get_reservations(
    business_date: date | None = Query(None, alias="date"),
    store_id: int | None = Query(None),
    actor: Actor = Depends(current_actor),
    db: Session = Depends(get_db),
) -> list[ReservationOut]:
    """Las reservas de un día operativo. Sin `date`, las de hoy."""
    if actor.kind == "device":
        store = _store_of(db, actor)
    else:
        if store_id is None:
            raise AppError("STORE_REQUIRED", "Indicá la sede con `store_id`", status=400)
        admin_store(db, actor, store_id)
        store = db.get(Store, store_id)  # type: ignore[assignment]
        if store is None:
            raise AppError("NOT_FOUND", "La sede no existe", status=404)
    return service.list_for_date(db, store=store, business_date=business_date)


@router.post("/reservations", status_code=201, dependencies=[GATE])
def post_reservation(
    payload: ReservationIn,
    request: Request,
    actor: Actor = Depends(current_operator),
    db: Session = Depends(get_db),
) -> JSONResponse:
    store = _store_of(db, actor)
    body: dict[str, Any] = payload.model_dump(mode="json")
    key = idempotency_key(request)

    def _do() -> tuple[int, dict[str, Any]]:
        out = service.create(db, store=store, payload=payload, by_name=actor.employee_name)
        return 201, out.model_dump(mode="json")

    status_code, resp = run_idempotent(
        db,
        organization_id=actor.organization_id,
        scope="reservations.create",
        key=key,
        request_hash=hash_request_body(body),
        fn=_do,
    )
    return JSONResponse(status_code=status_code, content=resp)


@router.post("/reservations/{reservation_id}/close", dependencies=[GATE])
def post_close_reservation(
    reservation_id: int,
    payload: ReservationCloseIn,
    actor: Actor = Depends(current_operator),
    db: Session = Depends(get_db),
) -> ReservationOut:
    """Cancelar, o marcar que no llegaron. La fila NO se borra."""
    store = _store_of(db, actor)
    return service.close(
        db, store=store, reservation_id=reservation_id, payload=payload, by_name=actor.employee_name
    )


@router.get("/admin/reservations", dependencies=[GATE])
def get_admin_reservations(
    store_id: int = Query(...),
    business_date: date | None = Query(None, alias="date"),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> list[ReservationOut]:
    admin_store(db, actor, store_id)
    store = db.get(Store, store_id)
    if store is None:
        raise AppError("NOT_FOUND", "La sede no existe", status=404)
    return service.list_for_date(db, store=store, business_date=business_date)
