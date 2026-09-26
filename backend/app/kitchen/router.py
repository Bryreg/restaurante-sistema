"""Vista de cocina (`CONTRATO-INTERNO-1b-1.md §2.4` «Cocina», ampliada en el
pedido 2c con el KDS completo, `kitchen.kds`).

Hasta 2b `app/kitchen` no tenía modelos propios: `GET /kitchen/rounds` lee
directamente `app.orders.models` (rondas e ítems `sent`/`ready`) y
`StoreSalesSettings` (tiempos objetivo por curso) para armar el semáforo. El
`ready` de UN ítem sigue viviendo en `app.orders.router`
(`POST /orders/{id}/items/{item_id}/ready`, territorio ajeno) — sin cambios.

2c agrega, todo detrás de `kitchen.kds` (que requiere `kitchen.view`,
`app/core/features.py`):

- Un enriquecimiento de `GET /kitchen/rounds` cuando `kitchen.kds` está
  encendida (orden por «marchar», atribución del bump, canal de
  plataforma) — la respuesta base NO CAMBIA con la flag apagada, es el
  mismo criterio ya usado acá con `_semaphore`/tiempos objetivo
  (`app/kitchen/service.py::enrich_round_for_kds`).
- `POST /kitchen/items/{item_id}/bump` y `.../unbump`: idempotentes,
  CONTRATO C1 (`app.orders.hooks.bump_item`/`unbump_item`).
- `POST /kitchen/orders/{order_id}/expedite`: la comanda completa de un
  golpe, CONTRATO C1 (`expedite_order`).
- `GET/POST /kitchen/print-jobs`: el trabajo de impresión por estación
  (qué se imprimiría, cuándo, y su registro — no un driver).

Atribución (§ misión, "qué rutas exigen persona identificada"): bumpear,
deshacer un bump, expedir e imprimir son acciones que alguien hace — las
cuatro piden `current_operator` (persona identificada) y quedan detrás de
`features.require_feature("kitchen.kds")` como *dependency* (a diferencia
de las lecturas de acá abajo, no hay problema en exigir un operador: son
gestos deliberados de cocina, no un sondeo pasivo). Las dos lecturas
(`GET /kitchen/rounds`, `GET /kitchen/print-jobs`) siguen con
`current_device` + `features.assert_feature` a mano, mismo criterio ya
documentado en `get_kitchen_rounds`: una pantalla de cocina puede no tener
a nadie identificado."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.deps import Actor, current_device, current_operator
from app.core import clock, features, tz
from app.core.db import get_db
from app.core.idempotency import hash_request_body, idempotency_key, run_idempotent
from app.kitchen import service
from app.kitchen.schemas import KitchenPrintJobOut, PrintJobIn
from app.orders.models import OrderItem, OrderItemStatus
from app.stores import service as stores_service
from app.stores.models import Store

router = APIRouter()


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
    """Mismo patrón que `app.orders.router._idempotent` (no se importa esa
    función privada de un territorio ajeno: se repite acá, cuatro líneas,
    contra las piezas públicas de `app.core.idempotency`)."""
    body: dict[str, Any] = dict(extra)
    if payload is not None:
        body.update(payload.model_dump(mode="json"))
    key = idempotency_key(request)
    request_hash = hash_request_body(body)
    status_code, resp_body = run_idempotent(
        db, organization_id=organization_id, scope=scope, key=key, request_hash=request_hash, fn=fn
    )
    return JSONResponse(status_code=status_code, content=resp_body)


def _semaphore(elapsed_seconds: int, target_minutes: int | None) -> str:
    # La regla vive en `service.semaphore` desde que el panel del
    # administrador cuenta los platos atrasados (`app.kitchen.hooks`): el KDS
    # y el panel tienen que decir el mismo color para el mismo plato.
    return service.semaphore(elapsed_seconds, target_minutes)


@router.get("/kitchen/rounds")
def get_kitchen_rounds(
    station: str | None = Query(None), actor: Actor = Depends(current_device), db: Session = Depends(get_db)
) -> list[dict[str, Any]]:
    # `features.require_feature(...)` como *dependency* exige un operador
    # identificado (resuelve `current_actor` -> `current_operator` por
    # dentro), pero esta ruta es de lectura de dispositivo con persona
    # OPCIONAL (una pantalla de cocina no tiene por qué tener a alguien
    # identificado): se valida la función a mano, sobre el actor real.
    features.assert_feature(db, actor.organization_id, actor.store_id, "kitchen.view")
    store_id = actor.store_id
    settings = stores_service.get_sales_settings(db, store_id)  # type: ignore[arg-type]
    course_targets = settings.course_target_minutes or {}
    now = clock.now_utc()
    # `kitchen.kds` es estrictamente ADITIVA acá: con la flag apagada este
    # booleano nunca se usa y la respuesta queda byte a byte la de 1b
    # (checklist de la spec: "con kitchen.kds apagada, todo lo de 1b sigue
    # idéntico").
    kds_enabled = features.is_enabled(db, actor.organization_id, store_id, "kitchen.kds")  # type: ignore[arg-type]
    store = db.get(Store, store_id)
    today = tz.today_business_date(store.cutoff_hour) if store is not None else None

    out: list[dict[str, Any]] = []
    for round_row, order in service.live_rounds(db, store_id=store_id):  # type: ignore[arg-type]
        items_stmt = select(OrderItem).where(
            OrderItem.round_id == round_row.id, OrderItem.status.in_([OrderItemStatus.SENT, OrderItemStatus.READY])
        )
        if station:
            items_stmt = items_stmt.where(OrderItem.station == station)
        items = service.visible_items(order, list(db.execute(items_stmt.order_by(OrderItem.id)).scalars()))
        if not items:
            continue

        items_out: list[dict[str, Any]] = []
        for item in items:
            elapsed_seconds = int((now - item.sent_at).total_seconds()) if item.sent_at is not None else 0
            target_minutes = service.target_minutes_for(course_targets, course=item.course, station=item.station)
            items_out.append(
                {
                    "item_id": item.id,
                    "name": item.name,
                    "qty": item.qty,
                    "modifiers_text": item.modifiers_text,
                    "note": item.note,
                    "course": item.course,
                    "station": item.station,
                    "status": item.status.value,
                    "elapsed_seconds": elapsed_seconds,
                    "target_minutes": target_minutes,
                    "semaphore": _semaphore(elapsed_seconds, target_minutes),
                }
            )

        round_out: dict[str, Any] = {
            "order_id": order.id,
            "round_no": round_row.round_no,
            "sent_at": round_row.sent_at,
            "elapsed_seconds": int((now - round_row.sent_at).total_seconds()),
            "channel": order.channel.value,
            "tables": service.tables_for_order(db, order_id=order.id),
            "takeout_name": order.takeout_customer_name,
            "covers": order.covers,
            "items": items_out,
        }
        if kds_enabled:
            service.enrich_round_for_kds(
                db, order=order, items=items, items_out=items_out, round_out=round_out, today=today
            )
        out.append(round_out)

    return out


# ---------------------------------------------------------------------------
# KDS completo (`kitchen.kds`): bump, expedición e impresión por estación.
# ---------------------------------------------------------------------------


@router.post("/kitchen/items/{item_id}/bump", dependencies=[Depends(features.require_feature("kitchen.kds"))])
def post_bump_item(
    item_id: int, request: Request, actor: Actor = Depends(current_operator), db: Session = Depends(get_db)
) -> JSONResponse:
    def _do() -> tuple[int, dict[str, Any]]:
        now = clock.now_utc()
        result = service.bump_item(db, item_id=item_id, store_id=actor.store_id, actor=actor, now=now)  # type: ignore[arg-type]
        return 200, result.model_dump(mode="json")

    return _idempotent(
        db, organization_id=actor.organization_id, scope="kitchen.bump", request=request,
        extra={"item_id": item_id}, payload=None, fn=_do,
    )


@router.post("/kitchen/items/{item_id}/unbump", dependencies=[Depends(features.require_feature("kitchen.kds"))])
def post_unbump_item(
    item_id: int, request: Request, actor: Actor = Depends(current_operator), db: Session = Depends(get_db)
) -> JSONResponse:
    def _do() -> tuple[int, dict[str, Any]]:
        now = clock.now_utc()
        result = service.unbump_item(db, item_id=item_id, store_id=actor.store_id, actor=actor, now=now)  # type: ignore[arg-type]
        return 200, result.model_dump(mode="json")

    return _idempotent(
        db, organization_id=actor.organization_id, scope="kitchen.unbump", request=request,
        extra={"item_id": item_id}, payload=None, fn=_do,
    )


@router.post("/kitchen/orders/{order_id}/expedite", dependencies=[Depends(features.require_feature("kitchen.kds"))])
def post_expedite_order(
    order_id: int,
    request: Request,
    station: str | None = Query(None),
    actor: Actor = Depends(current_operator),
    db: Session = Depends(get_db),
) -> JSONResponse:
    """Sin `station`, la comanda completa (el KDS en «Todas»); con `station`,
    sólo los ítems de esa estación (el KDS filtrado)."""

    def _do() -> tuple[int, dict[str, Any]]:
        now = clock.now_utc()
        result = service.expedite_order(
            db, order_id=order_id, store_id=actor.store_id, actor=actor, now=now, station=station  # type: ignore[arg-type]
        )
        return 200, result.model_dump(mode="json")

    return _idempotent(
        db, organization_id=actor.organization_id, scope="kitchen.expedite", request=request,
        extra={"order_id": order_id, "station": station}, payload=None, fn=_do,
    )


@router.get("/kitchen/print-jobs")
def get_print_jobs(
    station: str | None = Query(None), actor: Actor = Depends(current_device), db: Session = Depends(get_db)
) -> list[KitchenPrintJobOut]:
    # Lectura de dispositivo con persona OPCIONAL, mismo criterio que
    # `get_kitchen_rounds`: se valida la función a mano sobre el actor real.
    features.assert_feature(db, actor.organization_id, actor.store_id, "kitchen.kds")
    return service.list_print_jobs(db, store_id=actor.store_id, station=station)  # type: ignore[arg-type]


@router.post("/kitchen/print-jobs", dependencies=[Depends(features.require_feature("kitchen.kds"))])
def post_print_job(
    payload: PrintJobIn, request: Request, actor: Actor = Depends(current_operator), db: Session = Depends(get_db)
) -> JSONResponse:
    def _do() -> tuple[int, dict[str, Any]]:
        now = clock.now_utc()
        result = service.register_print_job(
            db, store_id=actor.store_id, round_id=payload.round_id, station=payload.station, actor=actor, now=now  # type: ignore[arg-type]
        )
        return 200, result.model_dump(mode="json")

    return _idempotent(
        db, organization_id=actor.organization_id, scope="kitchen.print", request=request,
        extra={}, payload=payload, fn=_do,
    )
