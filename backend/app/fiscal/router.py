"""Rutas admin de rangos de numeración, estados DIAN, evidencia, exportación
y notas (`/api/v1/admin/fiscal/*`, `/api/v1/admin/documents/{id}/notes`,
`/api/v1/admin/notes`). Todo bajo `current_admin` + `admin_store` — nunca lo
ve el dispositivo (el operador no recibe costos NI la máquina de estado DIAN
completa; lo que el dispositivo necesita ya sale de `app.payments.router`).
"""

from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.auth.deps import Actor, admin_store, current_admin
from app.core import clock, tz
from app.core.csv import csv_response, wants_csv
from app.core.db import get_db
from app.core.errors import AppError
from app.core.idempotency import hash_request_body, idempotency_key, run_idempotent
from app.fiscal import service
from app.fiscal.models import FiscalDocumentType
from app.fiscal.schemas import (
    AdminFiscalDocumentOut,
    AdminNoteListItem,
    DianStatusLiteral,
    DocumentEvidenceOut,
    ExportBundleOut,
    FiscalRangeIn,
    FiscalRangeOut,
    NoteCreateIn,
    NoteLineOut,
    NoteOut,
    RetryDocumentOut,
)
from app.payments import service as payments_service
from app.stores.models import Store

router = APIRouter()


def _store_or_404(db: Session, store_id: int) -> Store:
    store = db.get(Store, store_id)
    if store is None:
        raise AppError("NOT_FOUND", "La sede no existe", status=404)
    return store


# ---------------------------------------------------------------------------
# Rangos de numeración
# ---------------------------------------------------------------------------


@router.get("/admin/fiscal/ranges")
def get_ranges(
    request: Request,
    store_id: int = Query(...),
    # Deuda declarada en `outputs-2a/ENTREGA.md § 5` (pedido 2b): `format`
    # declarado en el contrato, no sólo leído de `request.query_params` dentro
    # de `wants_csv` — mismo patrón que `app.reports.router.get_sales`.
    format: str | None = Query(None, description='"csv" exporta como CSV'),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
) -> list[FiscalRangeOut] | Any:
    del format  # declarado sólo para el OpenAPI; el valor real se lee de `wants_csv(request)`.
    admin_store(db, actor, store_id)
    rows = [service.range_out(r) for r in service.list_ranges(db, store_id=store_id)]
    if wants_csv(request):
        csv_rows = [
            {
                "id": r.id,
                "store_id": r.store_id,
                "document_type": r.document_type,
                "prefix": r.prefix,
                "from": r.from_number,
                "to": r.to_number,
                "resolution_number": r.resolution_number,
                "resolution_date": r.resolution_date.isoformat(),
                "valid_from": r.valid_from.isoformat(),
                "valid_until": r.valid_until.isoformat(),
                "technical_key": r.technical_key or "",
                "consumed": r.consumed,
            }
            for r in rows
        ]
        return csv_response(csv_rows, filename="rangos-fiscales.csv")
    return rows


@router.post("/admin/fiscal/ranges", status_code=201)
def post_range(
    payload: FiscalRangeIn, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> FiscalRangeOut:
    store = admin_store(db, actor, payload.store_id)
    now = clock.now_utc()
    row = service.create_range(
        db,
        organization_id=actor.organization_id,
        store_id=store.id,
        document_type=FiscalDocumentType(payload.document_type),
        prefix=payload.prefix,
        from_number=payload.from_number,
        to_number=payload.to_number,
        resolution_number=payload.resolution_number,
        resolution_date=payload.resolution_date,
        valid_from=payload.valid_from,
        valid_until=payload.valid_until,
        technical_key=payload.technical_key,
        now=now,
    )
    out = service.range_out(row)
    record_audit(
        db,
        actor=actor,
        organization_id=actor.organization_id,
        store_id=store.id,
        entity="fiscal_range",
        entity_id=row.id,
        action="create",
        before=None,
        after=out.model_dump(mode="json", by_alias=True),
    )
    return out


# ---------------------------------------------------------------------------
# Estados ante la DIAN
# ---------------------------------------------------------------------------


@router.get("/admin/fiscal/documents")
def get_fiscal_documents(
    request: Request,
    store_id: int = Query(...),
    status: DianStatusLiteral | None = Query(default=None),
    # Deuda declarada en `outputs-2a/ENTREGA.md § 5` (pedido 2b): ver
    # `get_ranges` arriba, mismo motivo.
    format: str | None = Query(None, description='"csv" exporta como CSV'),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
) -> list[AdminFiscalDocumentOut] | Any:
    del format  # declarado sólo para el OpenAPI; el valor real se lee de `wants_csv(request)`.
    admin_store(db, actor, store_id)
    rows = service.admin_list_fiscal_documents(db, store_id=store_id, status=status)
    if wants_csv(request):
        return csv_response(rows, filename="documentos-fiscales.csv")
    return [AdminFiscalDocumentOut(**r) for r in rows]


@router.post("/admin/fiscal/documents/{document_id}/retry")
def post_retry_document(
    document_id: int,
    request: Request,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
) -> Any:
    document = payments_service.get_document_or_404(db, actor=actor, document_id=document_id)
    store = _store_or_404(db, document.store_id)

    body: dict[str, Any] = {"document_id": document_id}
    key = idempotency_key(request)
    request_hash = hash_request_body(body)

    def _do() -> tuple[int, dict[str, Any]]:
        service.retry_document(db, document=document, store=store, now=clock.now_utc())
        record_audit(
            db,
            actor=actor,
            organization_id=actor.organization_id,
            store_id=store.id,
            entity="fiscal_document",
            entity_id=document.id,
            action="retry",
            before=None,
            after={"dian_status": document.dian_status.value if document.dian_status else None},
        )
        out = RetryDocumentOut(
            id=document.id,
            full_number=f"{document.prefix}-{document.number:06d}",
            dian_status=document.dian_status.value if document.dian_status else None,  # type: ignore[arg-type]
            legend=document.legend,
            cude=document.cude,
            qr_url=document.qr_url,
            contingency=document.dian_status is not None and document.dian_status.value == "contingency",
        )
        return 200, out.model_dump(mode="json")

    status_code, resp_body = run_idempotent(
        db,
        organization_id=actor.organization_id,
        scope="fiscal.retry",
        key=key,
        request_hash=request_hash,
        fn=_do,
    )
    return JSONResponse(status_code=status_code, content=resp_body)


@router.get("/admin/fiscal/documents/{document_id}/evidence")
def get_evidence(
    document_id: int, db: Session = Depends(get_db), actor: Actor = Depends(current_admin)
) -> DocumentEvidenceOut:
    document = payments_service.get_document_or_404(db, actor=actor, document_id=document_id)
    return service.document_evidence(db, document=document)


@router.get("/admin/fiscal/export")
def get_export(
    store_id: int = Query(...),
    date_from: date = Query(..., alias="from"),
    date_to: date = Query(..., alias="to"),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
) -> ExportBundleOut:
    admin_store(db, actor, store_id)
    service.sweep_contingency_overdue(db, store_id=store_id)
    return service.export_bundle(db, store_id=store_id, date_from=date_from, date_to=date_to)


# ---------------------------------------------------------------------------
# Notas
# ---------------------------------------------------------------------------


def _note_out(row: Any, *, refund_status: str | None, returned_to_stock_item_ids: list[int]) -> NoteOut:
    return NoteOut(
        id=row.id,
        document_type=row.document_type.value,
        prefix=row.prefix,
        number=row.number,
        full_number=f"{row.prefix}-{row.number:06d}",
        reverses_document_id=row.reverses_document_id,
        reason=row.reason or "",
        lines=[NoteLineOut(**line) for line in row.lines],
        subtotal=row.subtotal,
        discount_total=row.discount_total,
        tax_total=row.tax_total,
        total=row.total,
        dian_status=row.dian_status.value if row.dian_status else None,
        legend=row.legend,
        business_date=row.business_date,
        issued_at=row.issued_at,
        refund_status=refund_status,
        returned_to_stock_item_ids=returned_to_stock_item_ids,
    )


@router.post("/admin/documents/{document_id}/notes", status_code=201)
def post_note(
    document_id: int,
    payload: NoteCreateIn,
    request: Request,
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
) -> Any:
    original = payments_service.get_document_or_404(db, actor=actor, document_id=document_id)
    store = _store_or_404(db, original.store_id)

    body: dict[str, Any] = {"document_id": document_id, **payload.model_dump(mode="json")}
    key = idempotency_key(request)
    request_hash = hash_request_body(body)

    def _do() -> tuple[int, dict[str, Any]]:
        now = clock.now_utc()
        business_date = tz.today_business_date(store.cutoff_hour)
        note, returned_to_stock_item_ids = service.issue_note(
            db,
            original=original,
            kind=payload.kind,
            reason=payload.reason,
            lines_in=payload.lines,
            actor=actor,
            store=store,
            business_date=business_date,
            now=now,
        )
        refund_status = service.settle_or_queue_refund_for_note(
            db, note=note, refund_in=payload.refund, actor=actor, now=now
        )
        record_audit(
            db,
            actor=actor,
            organization_id=actor.organization_id,
            store_id=store.id,
            entity="fiscal_document",
            entity_id=note.id,
            action="issue_note",
            before={"reverses_document_id": original.id, "original_status": "issued"},
            after={
                "kind": payload.kind,
                "total": note.total,
                "refund_status": refund_status,
                "returned_to_stock_item_count": len(returned_to_stock_item_ids),
            },
        )
        return 201, _note_out(
            note, refund_status=refund_status, returned_to_stock_item_ids=returned_to_stock_item_ids
        ).model_dump(mode="json")

    status_code, resp_body = run_idempotent(
        db,
        organization_id=actor.organization_id,
        scope="fiscal.notes",
        key=key,
        request_hash=request_hash,
        fn=_do,
    )
    return JSONResponse(status_code=status_code, content=resp_body)


@router.get("/admin/notes")
def get_notes(
    request: Request,
    store_id: int = Query(...),
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    # Deuda declarada en `outputs-2a/ENTREGA.md § 5` (pedido 2b): ver
    # `get_ranges` arriba, mismo motivo.
    format: str | None = Query(None, description='"csv" exporta como CSV'),
    db: Session = Depends(get_db),
    actor: Actor = Depends(current_admin),
) -> list[AdminNoteListItem] | Any:
    del format  # declarado sólo para el OpenAPI; el valor real se lee de `wants_csv(request)`.
    admin_store(db, actor, store_id)
    rows = service.admin_list_notes(db, store_id=store_id, date_from=date_from, date_to=date_to)
    if wants_csv(request):
        return csv_response(rows, filename="notas.csv")
    return [AdminNoteListItem(**r) for r in rows]
