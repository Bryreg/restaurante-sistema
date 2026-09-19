"""Endpoints admin de devoluciones pendientes (`/api/v1/admin/pending-refunds/...`).

No hay ruta de dispositivo: una devolución pendiente sólo nace del gancho
`app.refunds.hooks.settle_or_queue_refund` (que llama la nota, territorio de
`backend-fiscal`) y sólo el admin la salda.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from app.auth.deps import Actor, admin_store, current_admin
from app.core import clock
from app.core.csv import csv_response, wants_csv
from app.core.db import get_db
from app.core.idempotency import hash_request_body, idempotency_key, run_idempotent
from app.refunds import service
from app.refunds.schemas import PendingRefundOut, SettlePendingRefundIn

router = APIRouter()


@router.get("/admin/pending-refunds")
def admin_list_pending_refunds(
    request: Request,
    store_id: int,
    status: str | None = None,
    # Deuda declarada en `outputs-2a/ENTREGA.md § 5` (pedido 2b): `format`
    # declarado en el contrato, no sólo leído de `request.query_params` dentro
    # de `wants_csv` — mismo patrón que `app.reports.router.get_sales`.
    format: str | None = Query(None, description='"csv" exporta como CSV'),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> Any:
    del format  # declarado sólo para el OpenAPI; el valor real se lee de `wants_csv(request)`.
    admin_store(db, actor, store_id)
    rows = service.list_pending_refunds(db, organization_id=actor.organization_id, store_id=store_id, status=status)
    out = [PendingRefundOut.model_validate(r) for r in rows]
    if wants_csv(request):
        return csv_response([r.model_dump(mode="json") for r in out], filename="pending_refunds.csv")
    return out


@router.post("/admin/pending-refunds/{pending_refund_id}/settle")
def admin_settle_pending_refund(
    pending_refund_id: int,
    payload: SettlePendingRefundIn,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> PendingRefundOut:
    pending_refund = service.get_pending_refund_or_404(
        db, organization_id=actor.organization_id, pending_refund_id=pending_refund_id
    )
    admin_store(db, actor, pending_refund.store_id)

    key = idempotency_key(request)
    request_hash = hash_request_body(payload.model_dump(mode="json", by_alias=True))

    def _do() -> tuple[int, dict[str, Any]]:
        settled = service.settle_pending_refund(
            db,
            actor=actor,
            pending_refund=pending_refund,
            settle_from=payload.from_,
            shift_id=payload.shift_id,
            now=clock.now_utc(),
        )
        return 200, PendingRefundOut.model_validate(settled).model_dump(mode="json")

    status, body = run_idempotent(
        db,
        organization_id=actor.organization_id,
        scope="pending_refunds.settle",
        key=key,
        request_hash=request_hash,
        fn=_do,
    )
    return PendingRefundOut.model_validate(body)
