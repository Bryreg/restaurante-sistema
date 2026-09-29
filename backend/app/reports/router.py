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
from app.core import tz
from app.core.csv import csv_response, wants_csv
from app.core.csv_es import csv_es_response
from app.core.db import get_db
from app.core.errors import AppError
from app.reports import overview as overview_service
from app.reports import panel as panel_service
from app.reports import series as series_service
from app.reports import service
from app.reports.panel_schemas import EmployeeRecordOut, IngredientRecordOut, PanelOut, ShiftRecordOut
from app.reports.series_schemas import SectionKey, SectionOut
from app.reports.schemas import AccountantReportOut, GroupBy, ReportsOverviewOut, TodayOut

router = APIRouter()


@router.get("/admin/today")
def get_today(
    store_id: int = Query(...),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> TodayOut:
    store = admin_store(db, actor, store_id)
    return service.today_report(db, store=store)


# ---------------------------------------------------------------------------
# Las descargas de los bloques de Hoy (decisión del dueño, 2026-09-29): cada
# bloque se baja tal como se ve, en CSV para Excel en español (`;`, BOM,
# encabezados en español — `app.core.csv_es`). Sin `format=csv`, el JSON de
# las mismas filas.
# ---------------------------------------------------------------------------


def _hour_text(hour: int) -> str:
    return f"{hour:02d}:00"


@router.get("/admin/today/sales-by-hour")
def get_today_sales_by_hour(
    request: Request,
    store_id: int = Query(...),
    format: str | None = Query(None, description='"csv" descarga la tabla en CSV'),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any] | Any:
    del format  # declarado sólo para el OpenAPI; el valor real se lee de `wants_csv(request)`.
    store = admin_store(db, actor, store_id)
    business_date, hours, reference = service.today_sales_by_hour(db, store=store)
    if wants_csv(request):
        ref_by_hour = {h.hour: h.net for h in reference}
        rows = [
            {
                "hour": _hour_text(h.hour),
                # Una hora que todavía no llega no es «$ 0»: celda vacía.
                "net": None if h.pending else h.net,
                "gross": None if h.pending else h.gross,
                "orders": None if h.pending else h.orders,
                "reference": ref_by_hour.get(h.hour),
            }
            for h in hours
        ]
        return csv_es_response(
            rows,
            columns=[
                ("hour", "Hora"),
                ("net", "Venta neta"),
                ("gross", "Cobrado"),
                ("orders", "Comandas"),
                ("reference", "Mismo día semana pasada (día completo)"),
            ],
            filename=f"ventas-por-hora-{business_date.isoformat()}.csv",
        )
    return {
        "business_date": business_date.isoformat(),
        "hours": [h.model_dump(mode="json") for h in hours],
        "reference": [h.model_dump(mode="json") for h in reference],
    }


@router.get("/admin/today/top-products")
def get_today_top_products(
    request: Request,
    store_id: int = Query(...),
    format: str | None = Query(None, description='"csv" descarga todos los platos del día en CSV'),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]] | Any:
    del format  # declarado sólo para el OpenAPI; el valor real se lee de `wants_csv(request)`.
    store = admin_store(db, actor, store_id)
    business_date = tz.today_business_date(store.cutoff_hour)
    products = service.today_top_products(db, store=store, business_date=business_date, limit=None)
    if wants_csv(request):
        return csv_es_response(
            [p.model_dump() for p in products],
            columns=[("label", "Producto"), ("units", "Unidades"), ("net", "Venta neta")],
            filename=f"productos-vendidos-{business_date.isoformat()}.csv",
        )
    return [p.model_dump(mode="json") for p in products]


@router.get("/admin/today/receptions")
def get_today_receptions(
    request: Request,
    store_id: int = Query(...),
    format: str | None = Query(None, description='"csv" descarga las entradas de mercancía del día en CSV'),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]] | Any:
    del format  # declarado sólo para el OpenAPI; el valor real se lee de `wants_csv(request)`.
    store = admin_store(db, actor, store_id)
    business_date = tz.today_business_date(store.cutoff_hour)
    enabled, lines = service.today_receptions(db, store=store, business_date=business_date)
    if not enabled:
        raise AppError(
            "FEATURE_DISABLED",
            "«Compras» está apagada en esta sede; habilitala en Admin → Funciones para ver las entradas de mercancía.",
            status=400,
        )
    if wants_csv(request):
        return csv_es_response(
            [
                {
                    **line.model_dump(),
                    "received_at": tz.to_bogota(line.received_at).strftime("%H:%M"),
                    "expires_at": line.expires_at.isoformat() if line.expires_at else None,
                    "lot_status": _LOT_STATUS_ES.get(line.lot_status or ""),
                }
                for line in lines
            ],
            columns=[
                ("received_at", "Hora"),
                ("supplier_name", "Proveedor"),
                ("ingredient_name", "Insumo"),
                ("qty", "Cantidad"),
                ("purchase_unit", "Unidad de compra"),
                ("lot_code", "Lote"),
                ("expires_at", "Vence"),
                ("lot_status", "Estado del lote"),
                ("received_by", "Recibió"),
            ],
            filename=f"entradas-de-mercancia-{business_date.isoformat()}.csv",
        )
    return [line.model_dump(mode="json") for line in lines]


_LOT_STATUS_ES = {"active": "Vigente", "expiring": "Vence pronto", "expired": "Vencido", "depleted": "Agotado"}


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


@router.get("/admin/reports/overview")
def get_reports_overview(
    store_id: str = Query(..., description='Id de la sede, o "all" para todas las sedes de la organización'),
    date_from: date = Query(..., alias="from"),
    date_to: date = Query(..., alias="to"),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> ReportsOverviewOut:
    """«Informes»: todas las secciones del período en una sola respuesta
    (`app.reports.overview`). `store_id=all` consolida las sedes de la
    organización del administrador con la misma agregación que por sede y
    agrega `by_store`. Un id de otra organización es `404`."""
    if store_id == "all":
        stores = overview_service.organization_stores(db, actor.organization_id)
        if not stores:
            raise AppError("VALIDATION_ERROR", "Todavía no hay sedes creadas: creá una en Configuración", status=400)
        return overview_service.reports_overview(
            db, stores=stores, all_stores=True, date_from=date_from, date_to=date_to
        )
    if not store_id.isdigit():
        raise AppError("VALIDATION_ERROR", 'store_id: tiene que ser el id de una sede o "all"', status=400)
    store = admin_store(db, actor, int(store_id))
    return overview_service.reports_overview(db, stores=[store], all_stores=False, date_from=date_from, date_to=date_to)


# ---------------------------------------------------------------------------
# Panel de control y fichas relacionales (`app.reports.panel`)
# ---------------------------------------------------------------------------


@router.get("/admin/panel")
def get_panel(
    store_id: str = Query(..., description='Id de la sede, o "all" para todas las sedes activas de la organización'),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> PanelOut:
    """«Ahora» por sede: caja, quién trabaja, conteos, salón, cocina y lo que
    espera al dueño, con un semáforo que dice su porqué. `store_id=all`
    recorre las sedes activas de la organización; un id ajeno es `404`."""
    if store_id == "all":
        stores = [s for s in overview_service.organization_stores(db, actor.organization_id) if s.active]
        if not stores:
            raise AppError("VALIDATION_ERROR", "Todavía no hay sedes activas: creá una en Configuración", status=400)
        return panel_service.panel(db, stores=stores, all_stores=True)
    if not store_id.isdigit():
        raise AppError("VALIDATION_ERROR", 'store_id: tiene que ser el id de una sede o "all"', status=400)
    store = admin_store(db, actor, int(store_id))
    return panel_service.panel(db, stores=[store], all_stores=False)


@router.get("/admin/panel/sections")
def get_panel_sections(
    section: SectionKey = Query(..., description="caja, equipo o informes"),
    store_id: str = Query(..., description='Id de la sede, o "all" para todas las sedes activas de la organización'),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> SectionOut:
    """Caja, Equipo e Informes en el celular: cuatro tarjetas por sección,
    cada una con su cifra, su serie «barra + raya» y sus excepciones
    (`app.reports.series.sections`). `store_id=all` junta las sedes activas
    de la organización; un id ajeno es `404`."""
    if store_id == "all":
        stores = [s for s in overview_service.organization_stores(db, actor.organization_id) if s.active]
        if not stores:
            raise AppError("VALIDATION_ERROR", "Todavía no hay sedes activas: creá una en Configuración", status=400)
        return series_service.sections(db, stores=stores, all_stores=True, section=section)
    if not store_id.isdigit():
        raise AppError("VALIDATION_ERROR", 'store_id: tiene que ser el id de una sede o "all"', status=400)
    store = admin_store(db, actor, int(store_id))
    return series_service.sections(db, stores=[store], all_stores=False, section=section)


@router.get("/admin/records/shift/{shift_id}")
def get_shift_record(
    shift_id: int,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> ShiftRecordOut:
    """La ficha del turno: ventas, consignado, anulaciones, descuentos y
    cortesías, novedades, conteos por área y asistencia. El dinero del
    cajón (retiros, movimientos, relevos, esperado) lo trae `GET /shifts/{id}`."""
    from app.shifts.models import Shift

    shift = db.get(Shift, shift_id)
    if shift is None:
        raise AppError("NOT_FOUND", "El turno no existe", status=404)
    admin_store(db, actor, shift.store_id)
    return panel_service.shift_record(db, shift=shift)


@router.get("/admin/records/employee/{employee_id}")
def get_employee_record(
    employee_id: int,
    store_id: int = Query(...),
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> EmployeeRecordOut:
    """La ficha de una persona en una sede y un período (30 días por
    defecto): lo que cobró, los turnos en que tuvo la caja, su asistencia,
    y sus anulaciones, descuentos y cortesías."""
    store = admin_store(db, actor, store_id)
    employee = panel_service.get_employee_or_404(db, organization_id=actor.organization_id, employee_id=employee_id)
    return panel_service.employee_record(db, employee=employee, store=store, date_from=date_from, date_to=date_to)


@router.get("/admin/records/ingredient/{ingredient_id}")
def get_ingredient_record(
    ingredient_id: int,
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> IngredientRecordOut:
    """La ficha de un insumo: stock según el libro, entradas y salidas por
    causa, y sus conteos por área. El detalle movimiento por movimiento lo
    trae `GET /admin/ingredients/{id}/movements`."""
    from app.inventory.models import Ingredient

    ingredient = db.get(Ingredient, ingredient_id)
    if ingredient is None:
        raise AppError("NOT_FOUND", "El insumo no existe", status=404)
    store = admin_store(db, actor, ingredient.store_id)
    return panel_service.ingredient_record(
        db, ingredient=ingredient, store=store, date_from=date_from, date_to=date_to
    )

