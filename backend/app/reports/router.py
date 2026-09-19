"""Endpoints de reportes del administrador (`/api/v1/admin/...`),
`docs/SPEC-NEGOCIO.md §9.3` y `features/fase-1b-venta/spec.md` «Admin
reports». Todas las rutas son de admin (`current_admin` + `admin_store`): un
`store_id` de otra organización es `404`, nunca `403` ni `200` (SPEC §1.1,
§11.19). Todo listado acepta `format=csv` (`app.core.csv`).
"""

from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from app.auth.deps import Actor, admin_store, current_admin
from app.core.csv import csv_response, wants_csv
from app.core.db import get_db
from app.reports import service
from app.reports.schemas import AccountantReportOut, GroupBy, TodayOut

router = APIRouter()


@router.get("/admin/today")
def get_today(
    store_id: int = Query(...),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> TodayOut:
    store = admin_store(db, actor, store_id)
    return service.today_report(db, store=store)


@router.get("/admin/sales")
def get_sales(
    request: Request,
    store_id: int = Query(...),
    date_from: date = Query(..., alias="from"),
    date_to: date = Query(..., alias="to"),
    group_by: GroupBy = Query(..., alias="group_by"),
    # Pedido 2a (R-5, `outputs-1b-2/auditor-fiscal.md`): declarado en el
    # contrato (parámetro de la firma), no sólo leído de
    # `request.query_params` dentro de `wants_csv` — así el OpenAPI SÍ lo
    # publica. Este endpoint gana campos de costo en este mismo pedido, así
    # que se corrige acá de una vez; el chequeo real sigue siendo
    # `wants_csv(request)` (no se toca `app.core.csv`, ajeno).
    format: str | None = Query(None, description='"csv" exporta `rows` como CSV'),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any] | Any:
    del format  # declarado sólo para el OpenAPI; el valor real se lee de `wants_csv(request)`.
    admin_store(db, actor, store_id)
    report = service.sales_report(db, store_id=store_id, date_from=date_from, date_to=date_to, group_by=group_by)
    if wants_csv(request):
        rows = [row.model_dump(mode="json") for row in report.rows]
        return csv_response(rows, filename="ventas.csv")
    return report.model_dump(mode="json")


@router.get("/admin/accountant-report")
def get_accountant_report(
    request: Request,
    store_id: int = Query(...),
    year: int = Query(...),
    bimester: int | None = Query(None),
    month: int | None = Query(None),
    # Deuda declarada en `outputs-2a/ENTREGA.md § 5` (pedido 2b): `format`
    # declarado en el contrato, no sólo leído de `request.query_params` dentro
    # de `wants_csv` — mismo patrón que `get_sales` arriba.
    format: str | None = Query(None, description='"csv" exporta como CSV'),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> AccountantReportOut | Any:
    del format  # declarado sólo para el OpenAPI; el valor real se lee de `wants_csv(request)`.
    admin_store(db, actor, store_id)
    report = service.accountant_report(db, store_id=store_id, year=year, bimester=bimester, month=month)
    if wants_csv(request):
        rows: list[dict[str, Any]] = []
        for row in report.rows:
            for rate_row in row.by_rate:
                rows.append(
                    {
                        "business_date": row.business_date.isoformat(),
                        "rate": rate_row.rate,
                        "documents_count": row.documents_count,
                        "documents_base": rate_row.documents_base,
                        "documents_tax": rate_row.documents_tax,
                        "notes_count": row.notes_count,
                        "notes_base": rate_row.notes_base,
                        "notes_tax": rate_row.notes_tax,
                        "tips_amount": row.tips_amount,
                    }
                )
        return csv_response(rows, filename="informe-contador.csv")
    return report


@router.get("/admin/unavailable-log")
def get_unavailable_log(
    request: Request,
    store_id: int = Query(...),
    date_from: date = Query(..., alias="from"),
    date_to: date = Query(..., alias="to"),
    # Deuda declarada en `outputs-2a/ENTREGA.md § 5` (pedido 2b): ver
    # `get_accountant_report` arriba, mismo motivo.
    format: str | None = Query(None, description='"csv" exporta como CSV'),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]] | Any:
    del format  # declarado sólo para el OpenAPI; el valor real se lee de `wants_csv(request)`.
    store = admin_store(db, actor, store_id)
    rows = service.unavailable_log(db, store=store, date_from=date_from, date_to=date_to)
    payload = [row.model_dump(mode="json") for row in rows]
    if wants_csv(request):
        return csv_response(payload, filename="agotados.csv")
    return payload
