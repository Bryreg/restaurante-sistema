"""Endpoints de cobro y comprobante (`/api/v1/...`), `CONTRATO-INTERNO-1b-1.md §2.4`.

`GET /documents/last` se declara ANTES de `GET /documents/{document_id}` — si
no, FastAPI la captura como `document_id="last"`.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.auth.deps import Actor, admin_store, current_admin, current_device, current_operator
from app.core import clock
from app.core.csv import csv_response, wants_csv
from app.core.db import get_db
from app.core.errors import AppError, UnauthorizedError
from app.core.idempotency import hash_request_body, idempotency_key, run_idempotent
from app.orders import service as orders_service
from app.payments import service
from app.payments.schemas import (
    ChangePreviewIn,
    ChangePreviewOut,
    DevicePaymentMethodOut,
    DocumentPrintableOut,
    PaymentIn,
)
from app.shifts import service as shifts_service
from app.stores.models import Store

router = APIRouter()


def _store_of(db: Session, actor: Actor) -> Store:
    store = db.get(Store, actor.store_id)
    if store is None:
        raise AppError("DEVICE_NOT_ACTIVATED", "Activá el dispositivo con el PIN de sede", status=401)
    return store


def _device_or_admin(request: Request, db: Session = Depends(get_db)) -> Actor:
    """Lectura del comprobante: cualquier dispositivo activado o un admin
    (igual criterio que `app.catalog.router._catalog_read_actor`)."""
    try:
        return current_admin(request, db)
    except UnauthorizedError:
        return current_device(request, db)


# ---------------------------------------------------------------------------
# Cobro
# ---------------------------------------------------------------------------


@router.post("/orders/{order_id}/payments", status_code=201)
def post_payment(
    order_id: int,
    payload: PaymentIn,
    request: Request,
    actor: Actor = Depends(current_operator),
    db: Session = Depends(get_db),
) -> JSONResponse:
    store = _store_of(db, actor)
    order = orders_service.get_order_or_404(db, actor=actor, order_id=order_id)
    shift = shifts_service.get_current_shift(db, store=store)

    body: dict[str, Any] = {"order_id": order_id, **payload.model_dump(mode="json")}
    key = idempotency_key(request)
    request_hash = hash_request_body(body)

    def _do() -> tuple[int, dict[str, Any]]:
        result = service.pay_order(
            db, actor=actor, store=store, shift=shift, order=order, payload=payload, now=clock.now_utc()
        )
        return 201, result.model_dump(mode="json")

    status_code, resp_body = run_idempotent(
        db,
        organization_id=actor.organization_id,
        scope="orders.payments",
        key=key,
        request_hash=request_hash,
        fn=_do,
    )
    return JSONResponse(status_code=status_code, content=resp_body)


@router.post("/payments/change-preview")
def post_change_preview(
    payload: ChangePreviewIn, actor: Actor = Depends(current_operator)
) -> ChangePreviewOut:
    """El vuelto antes de cobrar. Sólo lectura: no toca la comanda ni el
    cajón, así que no lleva `Idempotency-Key`. Pide persona identificada como
    el cobro, porque es parte de cobrar."""
    del actor
    return ChangePreviewOut.model_validate(service.preview_change(payload.splits))


# ---------------------------------------------------------------------------
# Dispositivo: medios de pago habilitados de la sede
# ---------------------------------------------------------------------------


@router.get("/device/payment-methods")
def get_device_payment_methods(
    actor: Actor = Depends(current_device), db: Session = Depends(get_db)
) -> list[DevicePaymentMethodOut]:
    store = _store_of(db, actor)
    return service.device_payment_methods(db, store_id=store.id)


# ---------------------------------------------------------------------------
# Comprobante
# ---------------------------------------------------------------------------


@router.get("/documents/last")
def get_last_document(actor: Actor = Depends(current_device), db: Session = Depends(get_db)) -> DocumentPrintableOut | None:
    document = service.get_last_document(db, store_id=actor.store_id)  # type: ignore[arg-type]
    if document is None:
        return None
    return service.document_printable(db, document)


@router.get("/documents/{document_id}")
def get_document(
    document_id: int, actor: Actor = Depends(_device_or_admin), db: Session = Depends(get_db)
) -> DocumentPrintableOut:
    document = service.get_document_or_404(db, actor=actor, document_id=document_id)
    return service.document_printable(db, document)


@router.post("/documents/{document_id}/reprint")
def post_reprint_document(
    document_id: int, actor: Actor = Depends(current_operator), db: Session = Depends(get_db)
) -> DocumentPrintableOut:
    document = service.get_document_or_404(db, actor=actor, document_id=document_id)
    service.reprint_document(db, actor=actor, document=document)
    return service.document_printable(db, document)


# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------


@router.get("/admin/documents")
def get_admin_documents(
    request: Request,
    store_id: int = Query(...),
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    document_type: str | None = Query(None, alias="type"),
    status: str | None = Query(None),
    # Deuda declarada en `outputs-2a/ENTREGA.md § 5` (pedido 2b): `format`
    # declarado en el contrato, no sólo leído de `request.query_params` dentro
    # de `wants_csv` — mismo patrón que `app.reports.router.get_sales`.
    format: str | None = Query(None, description='"csv" exporta como CSV'),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]] | Any:
    del format  # declarado sólo para el OpenAPI; el valor real se lee de `wants_csv(request)`.
    admin_store(db, actor, store_id)
    rows = service.admin_list_documents(
        db, store_id=store_id, date_from=date_from, date_to=date_to, document_type=document_type, status=status
    )
    if wants_csv(request):
        return csv_response(rows, filename="comprobantes.csv")
    return rows
