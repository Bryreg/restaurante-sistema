"""Endpoints de `expenses` (`/api/v1/...`). Todo de admin, todo detrás de
`require_feature("money.obligations")`. `router.py` es sólo borde HTTP: la
matemática (punto de equilibrio, utilidad, la llave anti doble conteo) vive
en `service.py`.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy.orm import Session

from app.core.csv import CsvFormat, csv_response, sectioned_rows
from app.auth.deps import Actor, admin_store, current_admin
from app.core.db import get_db
from app.core.features import require_feature
from app.core.idempotency import hash_request_body, idempotency_key, run_idempotent
from app.expenses import schedule, service
from app.expenses.models import Expense, Obligation, ObligationPayment, ObligationTemplate
from app.expenses.schemas import (
    AgendaOut,
    BreakEvenOut,
    ConsumptionTaxOut,
    ConsumptionTaxScheduleIn,
    DrawerExpenseMovementOut,
    ExpenseIn,
    ExpenseOut,
    ExpenseVoidIn,
    GenerateMonthIn,
    GenerateMonthOut,
    MonthPlanOut,
    ObligationCancelIn,
    ObligationIn,
    ObligationOut,
    ObligationPaymentIn,
    ObligationPaymentOut,
    ObligationPaymentVoidIn,
    ObligationSettingsIn,
    ObligationSettingsOut,
    ObligationSettleIn,
    ObligationTemplateDeactivateIn,
    ObligationTemplateIn,
    ObligationTemplateOut,
    ObligationTemplateUpdateIn,
    PayrollRunCandidateOut,
    PayrollScheduleIn,
    PnlBudgetIn,
    PnlBudgetOut,
    PnlOut,
    ProfitOut,
    ScheduledObligationOut,
)
from app.stores.models import Store

router = APIRouter(dependencies=[Depends(require_feature("money.obligations"))])


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


def _expense_out(row: Expense) -> ExpenseOut:
    return ExpenseOut(
        id=row.id,
        store_id=row.store_id,
        category=row.category.value,  # type: ignore[arg-type]
        description=row.description,
        amount=row.amount,
        business_date=row.business_date,
        source=row.source.value,  # type: ignore[arg-type]
        cash_movement_id=row.cash_movement_id,
        created_by_employee_name=row.created_by_employee_name,
        created_at=row.created_at,
        voided_at=row.voided_at,
        voided_reason=row.voided_reason,
        voided_by_employee_name=row.voided_by_employee_name,
    )


def _obligations_out(db: Session, store: Store, rows: list[Obligation]) -> list[ObligationOut]:
    paid = service.paid_amounts(db, [r.id for r in rows])
    today = schedule.today_for(store)
    return [_obligation_out(r, paid=paid.get(r.id, 0), today=today) for r in rows]


def _one_out(db: Session, store: Store, row: Obligation) -> ObligationOut:
    return _obligations_out(db, store, [row])[0]


def _obligation_out(row: Obligation, *, paid: int, today: date) -> ObligationOut:
    return ObligationOut(
        id=row.id,
        store_id=row.store_id,
        category=row.category.value,  # type: ignore[arg-type]
        description=row.description,
        amount=row.amount,
        due_date=row.due_date,
        status=row.status.value,  # type: ignore[arg-type]
        paid_amount=paid,
        pending_amount=service.pending_of(row, paid),
        overdue=service.is_overdue(row, paid=paid, today=today),
        template_id=row.template_id,
        period_month=row.period_month,
        payroll_run_id=row.payroll_run_id,
        tax_year=row.tax_year,
        tax_bimester=row.tax_bimester,
        settled_at=row.settled_at,
        settled_by_employee_name=row.settled_by_employee_name,
        settled_source=row.settled_source.value if row.settled_source is not None else None,  # type: ignore[arg-type]
        cash_movement_id=row.cash_movement_id,
        created_by_employee_name=row.created_by_employee_name,
        created_at=row.created_at,
        cancelled_at=row.cancelled_at,
        cancelled_reason=row.cancelled_reason,
    )


# ---------------------------------------------------------------------------
# Gastos.
# ---------------------------------------------------------------------------


@router.get("/admin/expenses", response_model=list[ExpenseOut])
def list_expenses(
    store_id: int,
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    category: str | None = None,
    format: CsvFormat = None,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> list[ExpenseOut] | Response:
    store = admin_store(db, actor, store_id)
    rows = service.list_expenses(db, store_id=store.id, date_from=date_from, date_to=date_to, category=category)
    result = [_expense_out(r) for r in rows]
    if format == "csv":
        return csv_response(result, "gastos.csv")
    return result


@router.get("/admin/expenses/drawer-movements", response_model=list[DrawerExpenseMovementOut])
def list_drawer_movements(
    store_id: int,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> list[DrawerExpenseMovementOut]:
    """Los egresos del cajón que todavía no respaldan un gasto ni una
    obligación (últimos 30 días): de dónde se elige el `cash_movement_id`
    cuando la plata salió del cajón."""
    store = admin_store(db, actor, store_id)
    return [
        DrawerExpenseMovementOut(
            id=m.id,
            shift_id=m.shift_id,
            cause=m.cause.value,
            amount=m.amount,
            note=m.note,
            employee_name=m.employee_name,
            at=m.at,
        )
        for m in service.list_drawer_expense_movements(db, store_id=store.id)
    ]


@router.post("/admin/expenses", status_code=201)
def post_expense(
    payload: ExpenseIn,
    store_id: int,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> ExpenseOut:
    store = admin_store(db, actor, store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        row = service.create_expense(db, actor=actor, store=store, payload=payload)
        return 201, _expense_out(row).model_dump(mode="json")

    _status_code, body = _idempotent(
        db, organization_id=actor.organization_id, scope="expenses.create", request=request, payload=payload, fn=_do
    )
    return ExpenseOut.model_validate(body)


@router.post("/admin/expenses/{expense_id}/void")
def post_void_expense(
    expense_id: int,
    payload: ExpenseVoidIn,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> ExpenseOut:
    row = service.get_expense_or_404(db, organization_id=actor.organization_id, expense_id=expense_id)
    admin_store(db, actor, row.store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        updated = service.void_expense(db, actor=actor, expense=row, reason=payload.reason)
        return 200, _expense_out(updated).model_dump(mode="json")

    _status_code, body = _idempotent(
        db, organization_id=actor.organization_id, scope="expenses.void", request=request, payload=payload, fn=_do
    )
    return ExpenseOut.model_validate(body)




# ---------------------------------------------------------------------------
# Obligaciones agendadas.
#
# Las rutas LITERALES (`/agenda`, `/month-plan`, `/generate-month`,
# `/settings`, `/consumption-tax…`, `/payroll…`) van antes de las
# paramétricas `/admin/obligations/{obligation_id}/…`: es la regla de
# lectura del router, aunque hoy no compitan por profundidad.
# ---------------------------------------------------------------------------


@router.get("/admin/obligations", response_model=list[ObligationOut])
def list_obligations(
    store_id: int,
    status: str | None = None,
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    format: CsvFormat = None,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> list[ObligationOut] | Response:
    store = admin_store(db, actor, store_id)
    rows = service.list_obligations(db, store_id=store.id, status=status, date_from=date_from, date_to=date_to)
    result = _obligations_out(db, store, rows)
    if format == "csv":
        return csv_response(result, "obligaciones.csv")
    return result


@router.post("/admin/obligations", status_code=201)
def post_obligation(
    payload: ObligationIn,
    store_id: int,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> ObligationOut:
    store = admin_store(db, actor, store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        row = service.create_obligation(db, actor=actor, store=store, payload=payload)
        return 201, _one_out(db, store, row).model_dump(mode="json")

    _status_code, body = _idempotent(
        db, organization_id=actor.organization_id, scope="obligations.create", request=request, payload=payload, fn=_do
    )
    return ObligationOut.model_validate(body)


@router.get("/admin/obligations/agenda", response_model=AgendaOut)
def get_agenda(
    store_id: int,
    days: int = 30,
    format: CsvFormat = None,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> AgendaOut | Response:
    """Lo que vence de hoy a `days` días (30 o 60 en la pantalla) más todo
    lo vencido con saldo. Totales de SALDO, calculados acá."""
    store = admin_store(db, actor, store_id)
    result = schedule.agenda(db, store=store, days=days)
    if format == "csv":
        return csv_response(result.items, "agenda-de-pagos.csv")
    return result


@router.get("/admin/obligations/month-plan", response_model=MonthPlanOut)
def get_month_plan(
    store_id: int,
    year: int,
    month: int,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> MonthPlanOut:
    """Vista previa de «armar el mes»: qué copias se van a crear y cuáles ya
    estaban. No escribe nada."""
    store = admin_store(db, actor, store_id)
    return schedule.month_plan(db, store=store, year=year, month=month)


@router.post("/admin/obligations/generate-month")
def post_generate_month(
    payload: GenerateMonthIn,
    store_id: int,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> GenerateMonthOut:
    """«Armar el mes»: crea, en una sola transacción, la copia del mes de
    cada obligación recurrente que vence ese mes y todavía no la tiene.
    Idempotente por plantilla y mes: armarlo dos veces no cobra el arriendo
    dos veces (las que ya estaban vuelven en `already_generated`)."""
    store = admin_store(db, actor, store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        created, already = schedule.generate_month(db, actor=actor, store=store, year=payload.year, month=payload.month)
        out = GenerateMonthOut(
            year=payload.year,
            month=payload.month,
            created=_obligations_out(db, store, created),
            already_generated=already,
        )
        return 200, out.model_dump(mode="json")

    _status_code, body = _idempotent(
        db,
        organization_id=actor.organization_id,
        scope=f"obligations.generate_month.{store.id}",
        request=request,
        payload=payload,
        fn=_do,
    )
    return GenerateMonthOut.model_validate(body)


@router.get("/admin/obligations/settings", response_model=ObligationSettingsOut)
def get_obligation_settings(
    store_id: int,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> ObligationSettingsOut:
    store = admin_store(db, actor, store_id)
    return schedule.get_settings(db, store=store)


@router.put("/admin/obligations/settings")
def put_obligation_settings(
    payload: ObligationSettingsIn,
    store_id: int,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> ObligationSettingsOut:
    """El día del mes siguiente al bimestre en que se agenda el INC (1–28;
    `null` = el de fábrica, el 8). La DIAN lo fija por el último dígito del
    NIT: la sede escribe el suyo."""
    store = admin_store(db, actor, store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        return 200, schedule.put_settings(db, actor=actor, store=store, payload=payload).model_dump(mode="json")

    _status_code, body = _idempotent(
        db,
        organization_id=actor.organization_id,
        scope=f"obligations.settings.{store.id}",
        request=request,
        payload=payload,
        fn=_do,
    )
    return ObligationSettingsOut.model_validate(body)


@router.get("/admin/obligations/consumption-tax", response_model=ConsumptionTaxOut)
def get_consumption_tax(
    store_id: int,
    year: int | None = None,
    bimester: int | None = None,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> ConsumptionTaxOut:
    """El INC cobrado en un bimestre (por defecto el último cerrado), leído
    del informe del contador, con la fecha en que se agendaría y la
    obligación si ya está agendada. Sólo lectura."""
    store = admin_store(db, actor, store_id)
    fields, existing = schedule.consumption_tax(db, store=store, year=year, bimester=bimester)
    return ConsumptionTaxOut.model_validate(
        {**fields, "scheduled": _one_out(db, store, existing) if existing is not None else None}
    )


@router.post("/admin/obligations/consumption-tax/schedule")
def post_schedule_consumption_tax(
    payload: ConsumptionTaxScheduleIn,
    store_id: int,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> ScheduledObligationOut:
    """Agenda el INC de un bimestre cerrado como obligación con fecha DIAN.
    Sin `amount`, lo cobrado; con él, la cifra del contador. Idempotente
    por bimestre: si ya hay una viva, la devuelve con `already_existed`."""
    store = admin_store(db, actor, store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        row, already = schedule.schedule_consumption_tax(db, actor=actor, store=store, payload=payload)
        out = ScheduledObligationOut(obligation=_one_out(db, store, row), already_existed=already)
        return 200, out.model_dump(mode="json")

    _status_code, body = _idempotent(
        db,
        organization_id=actor.organization_id,
        scope="obligations.consumption_tax",
        request=request,
        payload=payload,
        fn=_do,
    )
    return ScheduledObligationOut.model_validate(body)


@router.get("/admin/obligations/payroll-runs", response_model=list[PayrollRunCandidateOut])
def get_payroll_candidates(
    store_id: int,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> list[PayrollRunCandidateOut]:
    """Las liquidaciones guardadas de la sede (las últimas 24) con su monto
    y, si ya se agendó, la obligación. Exige `payroll` encendida."""
    store = admin_store(db, actor, store_id)
    return schedule.payroll_candidates(db, store=store)


@router.post("/admin/obligations/payroll/schedule")
def post_schedule_payroll(
    payload: PayrollScheduleIn,
    store_id: int,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> ScheduledObligationOut:
    """Agenda una liquidación de nómina como obligación, por su costo para
    la sede (`employer_total_amount`, o `total_amount` si no hay). No suma a
    los costos fijos: la nómina ya entra a la utilidad por su lado.
    Idempotente por liquidación."""
    store = admin_store(db, actor, store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        row, already = schedule.schedule_payroll(db, actor=actor, store=store, payload=payload)
        out = ScheduledObligationOut(obligation=_one_out(db, store, row), already_existed=already)
        return 200, out.model_dump(mode="json")

    _status_code, body = _idempotent(
        db, organization_id=actor.organization_id, scope="obligations.payroll", request=request, payload=payload, fn=_do
    )
    return ScheduledObligationOut.model_validate(body)


def _obligation_and_store(db: Session, actor: Actor, obligation_id: int) -> tuple[Obligation, Store]:
    obligation = service.get_obligation_or_404(db, organization_id=actor.organization_id, obligation_id=obligation_id)
    store = admin_store(db, actor, obligation.store_id)
    return obligation, store


@router.post("/admin/obligations/{obligation_id}/settle")
def post_settle_obligation(
    obligation_id: int,
    payload: ObligationSettleIn,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> ObligationOut:
    """Paga TODO lo que falta en un solo abono."""
    obligation, store = _obligation_and_store(db, actor, obligation_id)

    def _do() -> tuple[int, dict[str, Any]]:
        updated = service.settle_obligation(db, actor=actor, store=store, obligation=obligation, payload=payload)
        return 200, _one_out(db, store, updated).model_dump(mode="json")

    _status_code, body = _idempotent(
        db, organization_id=actor.organization_id, scope="obligations.settle", request=request, payload=payload, fn=_do
    )
    return ObligationOut.model_validate(body)


def _payment_out(row: ObligationPayment) -> ObligationPaymentOut:
    return ObligationPaymentOut(
        id=row.id,
        obligation_id=row.obligation_id,
        amount=row.amount,
        paid_on=row.paid_on,
        source=row.source.value,  # type: ignore[arg-type]
        cash_movement_id=row.cash_movement_id,
        note=row.note,
        created_by_employee_name=row.created_by_employee_name,
        created_at=row.created_at,
        voided_at=row.voided_at,
        voided_reason=row.voided_reason,
        voided_by_employee_name=row.voided_by_employee_name,
    )


@router.get("/admin/obligations/{obligation_id}/payments", response_model=list[ObligationPaymentOut])
def list_obligation_payments(
    obligation_id: int,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> list[ObligationPaymentOut]:
    """Los abonos de la obligación, anulados incluidos (con su motivo)."""
    obligation, _store = _obligation_and_store(db, actor, obligation_id)
    return [_payment_out(p) for p in service.list_payments(db, obligation_id=obligation.id)]


@router.post("/admin/obligations/{obligation_id}/payments")
def post_obligation_payment(
    obligation_id: int,
    payload: ObligationPaymentIn,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> ObligationOut:
    """Un abono, con de dónde salió la plata. Nunca más de lo que falta."""
    obligation, store = _obligation_and_store(db, actor, obligation_id)

    def _do() -> tuple[int, dict[str, Any]]:
        service.add_payment(db, actor=actor, store=store, obligation=obligation, payload=payload)
        return 200, _one_out(db, store, obligation).model_dump(mode="json")

    _status_code, body = _idempotent(
        db, organization_id=actor.organization_id, scope="obligations.payment", request=request, payload=payload, fn=_do
    )
    return ObligationOut.model_validate(body)


@router.post("/admin/obligations/{obligation_id}/payments/{payment_id}/void")
def post_void_obligation_payment(
    obligation_id: int,
    payment_id: int,
    payload: ObligationPaymentVoidIn,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> ObligationOut:
    """Anula un abono con motivo (nunca se borra); la obligación recupera el
    saldo."""
    obligation, store = _obligation_and_store(db, actor, obligation_id)
    payment = service.get_payment_or_404(db, obligation=obligation, payment_id=payment_id)

    def _do() -> tuple[int, dict[str, Any]]:
        service.void_payment(db, actor=actor, obligation=obligation, payment=payment, reason=payload.reason)
        return 200, _one_out(db, store, obligation).model_dump(mode="json")

    _status_code, body = _idempotent(
        db,
        organization_id=actor.organization_id,
        scope="obligations.payment_void",
        request=request,
        payload=payload,
        fn=_do,
    )
    return ObligationOut.model_validate(body)


@router.post("/admin/obligations/{obligation_id}/cancel")
def post_cancel_obligation(
    obligation_id: int,
    payload: ObligationCancelIn,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> ObligationOut:
    obligation, store = _obligation_and_store(db, actor, obligation_id)

    def _do() -> tuple[int, dict[str, Any]]:
        updated = service.cancel_obligation(db, actor=actor, obligation=obligation, reason=payload.reason)
        return 200, _one_out(db, store, updated).model_dump(mode="json")

    _status_code, body = _idempotent(
        db, organization_id=actor.organization_id, scope="obligations.cancel", request=request, payload=payload, fn=_do
    )
    return ObligationOut.model_validate(body)


# ---------------------------------------------------------------------------
# c5 · Obligaciones recurrentes (plantillas).
# ---------------------------------------------------------------------------


def _template_out(row: ObligationTemplate) -> ObligationTemplateOut:
    return ObligationTemplateOut(
        id=row.id,
        store_id=row.store_id,
        category=row.category.value,  # type: ignore[arg-type]
        description=row.description,
        amount=row.amount,
        interval_months=row.interval_months,
        due_day=row.due_day,
        start_month=row.start_month,
        active=row.deactivated_at is None,
        created_by_employee_name=row.created_by_employee_name,
        created_at=row.created_at,
        updated_at=row.updated_at,
        deactivated_at=row.deactivated_at,
        deactivated_reason=row.deactivated_reason,
    )


@router.get("/admin/obligation-templates", response_model=list[ObligationTemplateOut])
def list_obligation_templates(
    store_id: int,
    include_inactive: bool = False,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> list[ObligationTemplateOut]:
    store = admin_store(db, actor, store_id)
    return [_template_out(t) for t in schedule.list_templates(db, store_id=store.id, include_inactive=include_inactive)]


@router.post("/admin/obligation-templates", status_code=201)
def post_obligation_template(
    payload: ObligationTemplateIn,
    store_id: int,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> ObligationTemplateOut:
    store = admin_store(db, actor, store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        row = schedule.create_template(db, actor=actor, store=store, payload=payload)
        return 201, _template_out(row).model_dump(mode="json")

    _status_code, body = _idempotent(
        db, organization_id=actor.organization_id, scope="obligation_templates.create", request=request, payload=payload, fn=_do
    )
    return ObligationTemplateOut.model_validate(body)


@router.patch("/admin/obligation-templates/{template_id}")
def patch_obligation_template(
    template_id: int,
    payload: ObligationTemplateUpdateIn,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> ObligationTemplateOut:
    """Cambia monto, descripción o día de vencimiento de lo que se genere
    de acá en adelante; lo ya generado no se toca."""
    template = schedule.get_template_or_404(db, organization_id=actor.organization_id, template_id=template_id)
    admin_store(db, actor, template.store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        row = schedule.update_template(db, actor=actor, template=template, payload=payload)
        return 200, _template_out(row).model_dump(mode="json")

    _status_code, body = _idempotent(
        db,
        organization_id=actor.organization_id,
        scope=f"obligation_templates.update.{template.id}",
        request=request,
        payload=payload,
        fn=_do,
    )
    return ObligationTemplateOut.model_validate(body)


@router.post("/admin/obligation-templates/{template_id}/deactivate")
def post_deactivate_obligation_template(
    template_id: int,
    payload: ObligationTemplateDeactivateIn,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> ObligationTemplateOut:
    """Deja de repetirse (con motivo). Lo ya generado sigue debiéndose."""
    template = schedule.get_template_or_404(db, organization_id=actor.organization_id, template_id=template_id)
    admin_store(db, actor, template.store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        row = schedule.deactivate_template(db, actor=actor, template=template, reason=payload.reason)
        return 200, _template_out(row).model_dump(mode="json")

    _status_code, body = _idempotent(
        db,
        organization_id=actor.organization_id,
        scope="obligation_templates.deactivate",
        request=request,
        payload=payload,
        fn=_do,
    )
    return ObligationTemplateOut.model_validate(body)


# ---------------------------------------------------------------------------
# Punto de equilibrio y utilidad del período.
# ---------------------------------------------------------------------------


@router.get("/admin/break-even", response_model=BreakEvenOut)
def get_break_even(
    store_id: int,
    date_from: date = Query(..., alias="from"),
    date_to: date = Query(..., alias="to"),
    format: CsvFormat = None,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> BreakEvenOut | Response:
    store = admin_store(db, actor, store_id)
    result = service.compute_break_even(db, store=store, date_from=date_from, date_to=date_to)
    if format == "csv":
        return csv_response(sectioned_rows(result), "punto-de-equilibrio.csv")
    return result


@router.get("/admin/profit", response_model=ProfitOut)
def get_profit(
    store_id: int,
    date_from: date = Query(..., alias="from"),
    date_to: date = Query(..., alias="to"),
    format: CsvFormat = None,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> ProfitOut | Response:
    store = admin_store(db, actor, store_id)
    result = service.compute_profit(db, store=store, date_from=date_from, date_to=date_to)
    if format == "csv":
        return csv_response(sectioned_rows(result), "utilidad.csv")
    return result


@router.get("/admin/profit/monthly", response_model=PnlOut)
def get_monthly_pnl(
    store_id: int,
    year: int,
    month: int,
    format: CsvFormat = None,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> PnlOut | Response:
    """El estado de resultados de los 12 meses que terminan en `year`-`month`
    (cada mes con la cuenta de Utilidad) y su presupuesto por renglón."""
    store = admin_store(db, actor, store_id)
    result = service.monthly_pnl(db, store=store, year=year, month=month)
    if format == "csv":
        rows = [
            {
                "line": row.label,
                **{m.label: cell.amount for m, cell in zip(result.months, row.cells)},
                "total": row.total.amount,
            }
            for row in result.rows
        ]
        return csv_response(rows, "estado-de-resultados.csv", headers={"line": "Renglón"})
    return result


@router.put("/admin/profit/budget", response_model=PnlBudgetOut)
def put_pnl_budget(
    store_id: int,
    body: PnlBudgetIn,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> PnlBudgetOut:
    """Pone (o quita, con `amount` nulo) el presupuesto de un renglón en un
    mes. Sólo administrador; queda en el historial."""
    store = admin_store(db, actor, store_id)
    return service.set_pnl_budget(
        db, actor=actor, store=store, year=body.year, month=body.month, line=body.line, amount=body.amount
    )
