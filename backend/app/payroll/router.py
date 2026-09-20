"""Endpoints de `payroll` (`/api/v1/...`). Sólo borde HTTP: valida, llama a
`app.payroll.service`, serializa — ninguna matemática vive acá
(`docs/CONTEXTO-AGENTES.md §3`).

Rutas del **contrato de API mínimo**
(`features/fase-3-dinero-control/spec.md § 2`, tabla T3 — vinculante, no se
renombran ni se cambian): `GET /admin/payroll/hours`,
`GET`/`POST /admin/payroll/surcharge-tables`,
`GET`/`POST /admin/payroll/runs`, `GET /admin/tips/distribution/proposal`,
`GET`/`PATCH /admin/tips/settings`. `POST /admin/tips/payouts` **ya existe**
en `app.shifts.router` (el "confirmar") — no se toca ni se duplica acá.

Rutas agregadas **más allá** del contrato (declaradas también en
`outputs/backend-nomina-propinas.md § 3`, necesarias para que la
liquidación tenga con qué calcular plata: la ley da los RECARGOS, no la
TARIFA por hora de cada persona, y `app.auth.models.Employee` no tiene ese
campo — no es territorio de este pedido):
`GET`/`GET /admin/payroll/runs/{run_id}` (detalle con líneas),
`GET`/`POST /admin/payroll/holidays` (festivos, para "festivas"),
`GET`/`POST /admin/payroll/wages` (tarifa por hora, con vigencia),
`GET`/`POST /admin/payroll/areas` (área de cada persona, para el reparto
`by_area`).

`payroll` gatea todo `/admin/payroll/**`; `pos.tips` (ya existe) gatea
`/admin/tips/**` — dos flags independientes, sin `requires` entre sí, así
que cada ruta declara la suya con `require_feature` directo (nada de
`_require_x()` encadenado: eso sólo hace falta cuando una función depende de
otra, `docs/CONTEXTO-AGENTES.md §6`, y acá no es el caso). Como es un
`dependencies=[Depends(...)]` de la ruta, FastAPI la resuelve antes que el
cuerpo del endpoint llegue a `admin_store` (el "gate de sede") — el orden
queda garantizado por construcción, el mismo criterio que ya usa
`app.banking.router._require_bank`.

**Iteración 2 (C2/H-2, ajuste del Maestro):** `GET
/admin/tips/distribution/proposal` exigía `shift_id` sí o sí y devolvía
`422` a la pantalla, que manda `store_id`/`from`/`to` (spec.md § 2, la forma
del período para toda la fase). La firma pasa a `store_id`, `from`/`to`
(FECHA DE NEGOCIO, alias como `app.analytics.router.get_menu_engineering`) y
un `method` opcional; `shift_id` queda como override opcional para el
detalle de un turno puntual. La resolución de `from`/`to` a turnos cerrados
(mismo patrón de join que `app.banking.service.pending_deposits`) y la rama
"sin turnos → `available=False` con motivo" viven en
`service.get_tip_proposal_for_period` — este router sigue siendo sólo borde
HTTP.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from app.auth.deps import Actor, admin_store, current_admin
from app.core import hours as hours_mod
from app.core.errors import AppError
from app.core.db import get_db
from app.core.features import require_feature
from app.core.idempotency import hash_request_body, idempotency_key, run_idempotent
from app.payroll import service
from app.payroll.models import PayrollHoliday, PayrollWageRate, SurchargeTable
from app.payroll.schemas import (
    AreaAssignmentIn,
    AreaAssignmentOut,
    HolidayIn,
    HolidayOut,
    HoursOut,
    HoursRowOut,
    PayrollRunIn,
    PayrollRunLineOut,
    PayrollRunOut,
    PayrollRunSummaryOut,
    SurchargeTableIn,
    SurchargeTableOut,
    SurchargeTableUsedOut,
    TipProposalOut,
    TipProposalRowOut,
    TipSettingsIn,
    TipSettingsOut,
    WageRateIn,
    WageRateOut,
)
from app.payroll.service import EmployeeHours

router = APIRouter()


def _idempotent(
    db: Session, *, organization_id: int, scope: str, request: Request, payload: Any, fn: Any
) -> Any:
    key = idempotency_key(request)
    request_hash = hash_request_body(payload.model_dump(mode="json"))
    return run_idempotent(
        db, organization_id=organization_id, scope=scope, key=key, request_hash=request_hash, fn=fn
    )


# ---------------------------------------------------------------------------
# Presentación.
# ---------------------------------------------------------------------------


def _hours_row_out(row: EmployeeHours) -> HoursRowOut:
    return HoursRowOut(
        employee_id=row.employee_id,
        employee_name=row.employee_name,
        ordinary_minutes=row.ordinary_minutes,
        night_minutes=row.night_minutes,
        sunday_minutes=row.sunday_minutes,
        holiday_minutes=row.holiday_minutes,
        overtime_minutes=row.overtime_minutes,
        ordinary_hours=hours_mod.format_hours(row.ordinary_minutes),
        night_hours=hours_mod.format_hours(row.night_minutes),
        sunday_hours=hours_mod.format_hours(row.sunday_minutes),
        holiday_hours=hours_mod.format_hours(row.holiday_minutes),
        overtime_hours=hours_mod.format_hours(row.overtime_minutes),
    )


def _surcharge_table_out(row: SurchargeTable) -> SurchargeTableOut:
    return SurchargeTableOut.model_validate(row)


def _holiday_out(row: PayrollHoliday) -> HolidayOut:
    return HolidayOut.model_validate(row)


def _wage_rate_out(row: PayrollWageRate) -> WageRateOut:
    return WageRateOut.model_validate(row)


def _run_line_out(line: Any) -> PayrollRunLineOut:
    return PayrollRunLineOut(
        employee_id=line.employee_id,
        employee_name=line.employee_name,
        ordinary_minutes=line.ordinary_minutes,
        night_minutes=line.night_minutes,
        sunday_minutes=line.sunday_minutes,
        holiday_minutes=line.holiday_minutes,
        overtime_minutes=line.overtime_minutes,
        base_pay=line.base_pay,
        night_surcharge=line.night_surcharge,
        sunday_holiday_surcharge=line.sunday_holiday_surcharge,
        overtime_pay=line.overtime_pay,
        total=line.total,
        pay_reason=line.pay_reason,
    )


def _run_out(db: Session, run: Any) -> PayrollRunOut:
    lines = service.run_lines(db, run_id=run.id)
    return PayrollRunOut(
        id=run.id,
        store_id=run.store_id,
        date_from=run.date_from,
        date_to=run.date_to,
        tables_used=[SurchargeTableUsedOut(**snapshot) for snapshot in run.tables_used],
        lines=[_run_line_out(line) for line in lines],
        total_amount=run.total_amount,
        available=run.all_available,
        reason=run.reason,
        computed_at=run.computed_at,
        computed_by_employee_name=run.computed_by_employee_name,
    )


# ---------------------------------------------------------------------------
# Jornada — GET /admin/payroll/hours
# ---------------------------------------------------------------------------


@router.get("/admin/payroll/hours", dependencies=[Depends(require_feature("payroll"))])
def get_hours(
    store_id: int,
    date_from: date = Query(..., alias="from"),
    date_to: date = Query(..., alias="to"),
    employee_id: int | None = None,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> HoursOut:
    store = admin_store(db, actor, store_id)
    result = service.get_hours(db, store=store, date_from=date_from, date_to=date_to, employee_id=employee_id)
    return HoursOut(
        store_id=store.id,
        date_from=date_from,
        date_to=date_to,
        rows=[_hours_row_out(r) for r in result.rows],
        available=result.available,
        reason=result.reason,
    )


# ---------------------------------------------------------------------------
# Tablas de recargos — GET/POST /admin/payroll/surcharge-tables
# ---------------------------------------------------------------------------


@router.get("/admin/payroll/surcharge-tables", dependencies=[Depends(require_feature("payroll"))])
def list_surcharge_tables(
    store_id: int, actor: Actor = Depends(current_admin), db: Session = Depends(get_db)
) -> list[SurchargeTableOut]:
    store = admin_store(db, actor, store_id)
    rows = service.list_surcharge_tables(db, store_id=store.id)
    return [_surcharge_table_out(r) for r in rows]


@router.post(
    "/admin/payroll/surcharge-tables", status_code=201, dependencies=[Depends(require_feature("payroll"))]
)
def post_surcharge_table(
    payload: SurchargeTableIn,
    store_id: int,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> SurchargeTableOut:
    store = admin_store(db, actor, store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        row = service.create_surcharge_table(db, actor=actor, store=store, payload=payload)
        return 201, _surcharge_table_out(row).model_dump(mode="json")

    _status, body = _idempotent(
        db,
        organization_id=actor.organization_id,
        scope="payroll.surcharge_tables",
        request=request,
        payload=payload,
        fn=_do,
    )
    return SurchargeTableOut.model_validate(body)


# ---------------------------------------------------------------------------
# Festivos — GET/POST /admin/payroll/holidays (agregada).
# ---------------------------------------------------------------------------


@router.get("/admin/payroll/holidays", dependencies=[Depends(require_feature("payroll"))])
def list_holidays(
    store_id: int, actor: Actor = Depends(current_admin), db: Session = Depends(get_db)
) -> list[HolidayOut]:
    store = admin_store(db, actor, store_id)
    return [_holiday_out(r) for r in service.list_holidays(db, store_id=store.id)]


@router.post("/admin/payroll/holidays", status_code=201, dependencies=[Depends(require_feature("payroll"))])
def post_holiday(
    payload: HolidayIn,
    store_id: int,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> HolidayOut:
    store = admin_store(db, actor, store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        row = service.create_holiday(db, actor=actor, store=store, payload=payload)
        return 201, _holiday_out(row).model_dump(mode="json")

    _status, body = _idempotent(
        db, organization_id=actor.organization_id, scope="payroll.holidays", request=request, payload=payload, fn=_do
    )
    return HolidayOut.model_validate(body)


# ---------------------------------------------------------------------------
# Tarifa por hora — GET/POST /admin/payroll/wages (agregada).
# ---------------------------------------------------------------------------


@router.get("/admin/payroll/wages", dependencies=[Depends(require_feature("payroll"))])
def list_wages(
    store_id: int,
    employee_id: int | None = None,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> list[WageRateOut]:
    store = admin_store(db, actor, store_id)
    rows = service.list_wage_rates(db, store_id=store.id, employee_id=employee_id)
    return [_wage_rate_out(r) for r in rows]


@router.post("/admin/payroll/wages", status_code=201, dependencies=[Depends(require_feature("payroll"))])
def post_wage(
    payload: WageRateIn,
    store_id: int,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> WageRateOut:
    store = admin_store(db, actor, store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        row = service.create_wage_rate(db, actor=actor, store=store, payload=payload)
        return 201, _wage_rate_out(row).model_dump(mode="json")

    _status, body = _idempotent(
        db, organization_id=actor.organization_id, scope="payroll.wages", request=request, payload=payload, fn=_do
    )
    return WageRateOut.model_validate(body)


# ---------------------------------------------------------------------------
# Área — GET/POST /admin/payroll/areas (agregada, para el reparto `by_area`).
# ---------------------------------------------------------------------------


@router.get("/admin/payroll/areas", dependencies=[Depends(require_feature("payroll"))])
def list_areas(
    store_id: int, actor: Actor = Depends(current_admin), db: Session = Depends(get_db)
) -> list[AreaAssignmentOut]:
    store = admin_store(db, actor, store_id)
    return [AreaAssignmentOut.model_validate(r) for r in service.list_area_assignments(db, store_id=store.id)]


@router.post("/admin/payroll/areas", dependencies=[Depends(require_feature("payroll"))])
def post_area(
    payload: AreaAssignmentIn,
    store_id: int,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> AreaAssignmentOut:
    store = admin_store(db, actor, store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        row = service.set_employee_area(db, actor=actor, store=store, payload=payload)
        return 200, AreaAssignmentOut.model_validate(row).model_dump(mode="json")

    _status, body = _idempotent(
        db, organization_id=actor.organization_id, scope="payroll.areas", request=request, payload=payload, fn=_do
    )
    return AreaAssignmentOut.model_validate(body)


# ---------------------------------------------------------------------------
# Liquidación del período — GET/POST /admin/payroll/runs
# ---------------------------------------------------------------------------


@router.get("/admin/payroll/runs", dependencies=[Depends(require_feature("payroll"))])
def list_runs(
    store_id: int, actor: Actor = Depends(current_admin), db: Session = Depends(get_db)
) -> list[PayrollRunSummaryOut]:
    store = admin_store(db, actor, store_id)
    rows = service.list_runs(db, store_id=store.id)
    return [
        PayrollRunSummaryOut(
            id=r.id,
            store_id=r.store_id,
            date_from=r.date_from,
            date_to=r.date_to,
            total_amount=r.total_amount,
            available=r.all_available,
            reason=r.reason,
            computed_at=r.computed_at,
        )
        for r in rows
    ]


@router.get("/admin/payroll/runs/{run_id}", dependencies=[Depends(require_feature("payroll"))])
def get_run(
    run_id: int, store_id: int, actor: Actor = Depends(current_admin), db: Session = Depends(get_db)
) -> PayrollRunOut:
    store = admin_store(db, actor, store_id)
    run = service.get_run(db, store_id=store.id, run_id=run_id)
    return _run_out(db, run)


@router.post("/admin/payroll/runs", status_code=201, dependencies=[Depends(require_feature("payroll"))])
def post_run(
    payload: PayrollRunIn,
    store_id: int,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> PayrollRunOut:
    store = admin_store(db, actor, store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        run = service.create_run(db, actor=actor, store=store, date_from=payload.date_from, date_to=payload.date_to)
        return 201, _run_out(db, run).model_dump(mode="json")

    _status, body = _idempotent(
        db, organization_id=actor.organization_id, scope="payroll.runs", request=request, payload=payload, fn=_do
    )
    return PayrollRunOut.model_validate(body)


# ---------------------------------------------------------------------------
# Reparto de propinas (D-3) — GET /admin/tips/distribution/proposal,
# GET/PATCH /admin/tips/settings. `POST /admin/tips/payouts` ya existe en
# `app.shifts.router` — no se toca ni se duplica.
# ---------------------------------------------------------------------------


@router.get("/admin/tips/distribution/proposal", dependencies=[Depends(require_feature("pos.tips"))])
def get_tip_proposal(
    store_id: int,
    date_from: date | None = Query(default=None, alias="from"),
    date_to: date | None = Query(default=None, alias="to"),
    shift_id: list[int] | None = Query(default=None, alias="shift_id"),
    method: str | None = None,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> TipProposalOut:
    """La propuesta de reparto: **nunca escribe nada** (D-3). El «confirmar»
    sigue siendo `POST /admin/tips/payouts`, que existe desde 1b-2.

    Se pide **o** por período (`from`/`to`) **o** por turnos puntuales
    (`shift_id`, repetible). R-4 del cierre de la fase 3: `shift_id` estaba
    documentado como «override opcional» pero `from`/`to` eran obligatorios,
    así que el override no se podía usar solo — se pedía un rango que después
    se ignoraba. O era opcional de verdad, o había que dejar de llamarlo
    override; es lo primero.
    """
    store = admin_store(db, actor, store_id)
    if not shift_id and (date_from is None or date_to is None):
        raise AppError(
            code="PERIOD_OR_SHIFT_REQUIRED",
            message=(
                "Pedí la propuesta por período (`from` y `to`) o por turnos puntuales "
                "(`shift_id`); sin ninguno de los dos no hay de dónde sacar las propinas"
            ),
        )
    shift_ids, result = service.get_tip_proposal_for_period(
        db, store=store, date_from=date_from, date_to=date_to, shift_ids=shift_id, method=method
    )
    return TipProposalOut(
        store_id=store.id,
        shift_ids=shift_ids,
        method=result.method.value,  # type: ignore[arg-type]
        rows=[TipProposalRowOut(employee_id=r.employee_id, employee_name=r.employee_name, basis=r.basis, amount=r.amount) for r in result.rows],
        total=result.total,
        available=result.available,
        reason=result.reason,
    )


@router.get("/admin/tips/settings", dependencies=[Depends(require_feature("pos.tips"))])
def get_tip_settings(
    store_id: int, actor: Actor = Depends(current_admin), db: Session = Depends(get_db)
) -> TipSettingsOut:
    store = admin_store(db, actor, store_id)
    result = service.get_tip_settings(db, store_id=store.id)
    return TipSettingsOut(store_id=result.store_id, method=result.method.value, updated_at=result.updated_at)  # type: ignore[arg-type]


@router.patch("/admin/tips/settings", dependencies=[Depends(require_feature("pos.tips"))])
def patch_tip_settings(
    payload: TipSettingsIn,
    store_id: int,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> TipSettingsOut:
    store = admin_store(db, actor, store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        result = service.update_tip_settings(db, actor=actor, store=store, method=payload.method)
        out = TipSettingsOut(store_id=result.store_id, method=result.method.value, updated_at=result.updated_at)  # type: ignore[arg-type]
        return 200, out.model_dump(mode="json")

    _status, body = _idempotent(
        db, organization_id=actor.organization_id, scope="payroll.tip_settings", request=request, payload=payload, fn=_do
    )
    return TipSettingsOut.model_validate(body)
