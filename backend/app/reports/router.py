"""Endpoints de reportes del administrador (`/api/v1/admin/...`),
`docs/SPEC-NEGOCIO.md §9.3` y `features/fase-1b-venta/spec.md` «Admin
reports». Todas las rutas son de admin (`current_admin` + `admin_store`): un
`store_id` de otra organización es `404`, nunca `403` ni `200` (SPEC §1.1,
§11.19). Todo listado acepta `format=csv` (`app.core.csv`).
"""

from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.auth.deps import Actor, admin_store, current_admin
from app.core import tz
from app.core.csv import CsvFormat, csv_response, sectioned_rows, wants_csv
from app.core.csv_es import csv_es_response
from app.core.db import get_db
from app.core.errors import AppError
from app.reports import accountant as accountant_service
from app.reports import overview as overview_service
from app.reports import panel as panel_service
from app.reports import series as series_service
from app.reports import service
from app.reports.panel_schemas import EmployeeRecordOut, IngredientRecordOut, PanelOut, ShiftRecordOut
from app.reports.series_schemas import SectionKey, SectionOut
from app.stores.models import Store
from app.reports.schemas import (
    AccountantGoalOut,
    AccountantReportOut,
    GroupBy,
    ReportsOverviewOut,
    SalesGoalIn,
    TodayOut,
)

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


def _recap_day(store: Store, day: date | None) -> date | None:
    """El día pedido para la descarga: hoy o uno anterior, nunca el futuro."""
    if day is None:
        return None
    if day > tz.today_business_date(store.cutoff_hour):
        raise AppError("VALIDATION_ERROR", "date: elegí hoy o un día anterior", status=400)
    return day


def _hour_text(hour: int) -> str:
    return f"{hour:02d}:00"


@router.get("/admin/today/sales-by-hour")
def get_today_sales_by_hour(
    request: Request,
    store_id: int = Query(...),
    day: date | None = Query(None, alias="date", description="Un día ya cerrado (el repaso de Hoy); sin él, hoy"),
    format: str | None = Query(None, description='"csv" descarga la tabla en CSV'),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any] | Any:
    del format  # declarado sólo para el OpenAPI; el valor real se lee de `wants_csv(request)`.
    store = admin_store(db, actor, store_id)
    business_date, hours, reference = service.today_sales_by_hour(db, store=store, day=_recap_day(store, day))
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
    day: date | None = Query(None, alias="date", description="Un día ya cerrado (el repaso de Hoy); sin él, hoy"),
    format: str | None = Query(None, description='"csv" descarga todos los platos del día en CSV'),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]] | Any:
    del format  # declarado sólo para el OpenAPI; el valor real se lee de `wants_csv(request)`.
    store = admin_store(db, actor, store_id)
    business_date = _recap_day(store, day) or tz.today_business_date(store.cutoff_hour)
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
    day: date | None = Query(None, alias="date", description="Un día ya cerrado (el repaso de Hoy); sin él, hoy"),
    format: str | None = Query(None, description='"csv" descarga las entradas de mercancía del día en CSV'),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]] | Any:
    del format  # declarado sólo para el OpenAPI; el valor real se lee de `wants_csv(request)`.
    store = admin_store(db, actor, store_id)
    business_date = _recap_day(store, day) or tz.today_business_date(store.cutoff_hour)
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
    store_id: str = Query(..., description='Id de la sede, o "all" para todas las sedes de la organización'),
    year: int = Query(...),
    bimester: int | None = Query(None),
    month: int | None = Query(None),
    # Deuda declarada en `outputs-2a/ENTREGA.md § 5` (pedido 2b): `format`
    # declarado en el contrato, no sólo leído de `request.query_params` dentro
    # de `wants_csv` — mismo patrón que `get_sales` arriba.
    format: str | None = Query(None, description='"csv" exporta el «Excel» del contador (`;`, UTF-8 con BOM)'),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> AccountantReportOut | Any:
    """Informe del contador «como café-sistema» (`app.reports.accountant`):
    por día operativo y medio de pago, con los totales del mes, la
    comparación contra el período anterior y la meta. `store_id=all` junta
    las sedes de la organización. `format=csv` baja el «Excel»: `;` como
    separador, BOM UTF-8 y la fila TOTAL."""
    del format  # declarado sólo para el OpenAPI; el valor real se lee de `wants_csv(request)`.
    if year < 2000 or year > 2100:
        raise AppError("VALIDATION_ERROR", "year: elegí un año entre 2000 y 2100", status=400)
    if store_id == "all":
        stores = overview_service.organization_stores(db, actor.organization_id)
        if not stores:
            raise AppError("VALIDATION_ERROR", "Todavía no hay sedes creadas: creá una en Configuración", status=400)
        all_stores = True
    else:
        if not store_id.isdigit():
            raise AppError("VALIDATION_ERROR", 'store_id: tiene que ser el id de una sede o "all"', status=400)
        stores = [admin_store(db, actor, int(store_id))]
        all_stores = False
    report = accountant_service.accountant_report(
        db, stores=stores, all_stores=all_stores, year=year, bimester=bimester, month=month
    )
    if wants_csv(request):
        return StreamingResponse(
            (chunk.encode("utf-8") for chunk in accountant_service.csv_lines(report)),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{accountant_service.csv_filename(report)}"'},
        )
    return report


@router.get("/admin/accountant-report/goal")
def get_sales_goal(
    store_id: int = Query(...),
    year: int = Query(...),
    month: int = Query(...),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> AccountantGoalOut:
    """La meta de ventas de ese mes para la sede (la del mes, o la heredada
    del último mes que tenía una)."""
    store = admin_store(db, actor, store_id)
    return accountant_service.get_goal(db, store=store, year=year, month=month)


@router.put("/admin/accountant-report/goal")
def put_sales_goal(
    body: SalesGoalIn,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> AccountantGoalOut:
    """Pone la meta de ventas del mes (`amount` nulo o 0 = sin meta). Sólo
    administrador; queda en el historial."""
    store = admin_store(db, actor, body.store_id)
    accountant_service.set_goal(db, actor=actor, store=store, year=body.year, month=body.month, amount=body.amount)
    return accountant_service.get_goal(db, store=store, year=body.year, month=body.month)


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


@router.get("/admin/reports/overview", response_model=ReportsOverviewOut)
def get_reports_overview(
    store_id: str = Query(..., description='Id de la sede, o "all" para todas las sedes de la organización'),
    date_from: date = Query(..., alias="from"),
    date_to: date = Query(..., alias="to"),
    format: CsvFormat = None,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> ReportsOverviewOut | Response:
    """«Informes»: todas las secciones del período en una sola respuesta
    (`app.reports.overview`). `store_id=all` consolida las sedes de la
    organización del administrador con la misma agregación que por sede y
    agrega `by_store`. Un id de otra organización es `404`."""
    if store_id == "all":
        stores = overview_service.organization_stores(db, actor.organization_id)
        if not stores:
            raise AppError("VALIDATION_ERROR", "Todavía no hay sedes creadas: creá una en Configuración", status=400)
        result = overview_service.reports_overview(
            db, stores=stores, all_stores=True, date_from=date_from, date_to=date_to
        )
    else:
        if not store_id.isdigit():
            raise AppError("VALIDATION_ERROR", 'store_id: tiene que ser el id de una sede o "all"', status=400)
        store = admin_store(db, actor, int(store_id))
        result = overview_service.reports_overview(
            db, stores=[store], all_stores=False, date_from=date_from, date_to=date_to
        )
    if format == "csv":
        return csv_response(sectioned_rows(result), "informes.csv")
    return result


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


@router.get("/admin/records/employee/{employee_id}", response_model=EmployeeRecordOut)
def get_employee_record(
    employee_id: int,
    store_id: int = Query(...),
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    format: CsvFormat = None,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> EmployeeRecordOut | Response:
    """La ficha de una persona en una sede y un período (30 días por
    defecto): lo que cobró, los turnos en que tuvo la caja, su asistencia,
    y sus anulaciones, descuentos y cortesías."""
    store = admin_store(db, actor, store_id)
    employee = panel_service.get_employee_or_404(db, organization_id=actor.organization_id, employee_id=employee_id)
    result = panel_service.employee_record(db, employee=employee, store=store, date_from=date_from, date_to=date_to)
    if format == "csv":
        return csv_response(sectioned_rows(result), "ficha-persona.csv")
    return result


@router.get("/admin/records/ingredient/{ingredient_id}", response_model=IngredientRecordOut)
def get_ingredient_record(
    ingredient_id: int,
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    format: CsvFormat = None,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> IngredientRecordOut | Response:
    """La ficha de un insumo: stock según el libro, entradas y salidas por
    causa, y sus conteos por área. El detalle movimiento por movimiento lo
    trae `GET /admin/ingredients/{id}/movements`."""
    from app.inventory.models import Ingredient

    ingredient = db.get(Ingredient, ingredient_id)
    if ingredient is None:
        raise AppError("NOT_FOUND", "El insumo no existe", status=404)
    store = admin_store(db, actor, ingredient.store_id)
    result = panel_service.ingredient_record(
        db, ingredient=ingredient, store=store, date_from=date_from, date_to=date_to
    )
    if format == "csv":
        return csv_response(sectioned_rows(result), "ficha-insumo.csv")
    return result

