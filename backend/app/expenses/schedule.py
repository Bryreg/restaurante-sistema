"""c5 · Obligaciones recurrentes, agenda de vencimientos, INC del bimestre y
nómina como obligación (adaptado de café-sistema, `routers/costos.py`:
`/obligaciones/armar-mes`, `/repetir`, `/impoconsumo/agendar`,
`/nomina/agendar`, `/agenda`).

**Nada se crea solo.** Las plantillas no son un scheduler: «armar el mes»
lo dispara el dueño, ve la vista previa y confirma. Un generador automático
llenaría la agenda (y la utilidad) de costos que nadie confirmó.

**Idempotencia en dos capas**: la `Idempotency-Key` de cada escritura (doble
toque, reconexión) y además una llave de NEGOCIO en la base — `(template_id,
period_month)` para las copias, `(store_id, tax_year, tax_bimester)` viva
para el INC y `payroll_run_id` viva para la nómina —, así que dos requests
distintas (otra tablet, otra clave) tampoco duplican el arriendo. Un
`IntegrityError` en esa llave se lee como «ya estaba», nunca como un 500.

**Una sola matemática**: el INC sale del informe del contador
(`app.reports.hooks.bimester_tax`, las `tax_lines` congeladas de los
documentos de venta), y el monto de la nómina de la liquidación guardada
(`app.payroll.hooks`). Este módulo no suma ventas ni horas.
"""

from __future__ import annotations

import calendar
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.auth.deps import Actor
from app.core import clock, features, tz
from app.core.errors import AppError, NotFoundError
from app.core.money import format_cop
from app.core.tax import TAX_RATE_BY_CODE
from app.expenses import service
from app.expenses.models import (
    Obligation,
    ObligationCategory,
    ObligationStatus,
    ObligationTemplate,
    StoreObligationSettings,
)
from app.expenses.schemas import (
    AgendaItemOut,
    AgendaOut,
    ConsumptionTaxRateOut,
    ConsumptionTaxScheduleIn,
    MonthPlanLineOut,
    MonthPlanOut,
    ObligationSettingsIn,
    ObligationSettingsOut,
    ObligationTemplateIn,
    ObligationTemplateUpdateIn,
    PayrollRunCandidateOut,
    PayrollScheduleIn,
)
from app.stores.models import Store

# ---------------------------------------------------------------------------
# Fechas.
# ---------------------------------------------------------------------------


def month_start(value: date) -> date:
    return value.replace(day=1)


def add_months(first_of_month: date, months: int) -> date:
    index = first_of_month.year * 12 + (first_of_month.month - 1) + months
    return date(index // 12, index % 12 + 1, 1)


def _months_between(start: date, end: date) -> int:
    return (end.year - start.year) * 12 + (end.month - start.month)


def day_in_month(first_of_month: date, day: int) -> date:
    """El día `day` de ese mes, recortado al último día real (31 → 30 en
    abril, → 28/29 en febrero)."""
    last = calendar.monthrange(first_of_month.year, first_of_month.month)[1]
    return first_of_month.replace(day=min(day, last))


def today_for(store: Store) -> date:
    return tz.today_business_date(store.cutoff_hour)


# ---------------------------------------------------------------------------
# Plantillas.
# ---------------------------------------------------------------------------


def get_template_or_404(db: Session, *, organization_id: int, template_id: int) -> ObligationTemplate:
    row = db.get(ObligationTemplate, template_id)
    if row is None or row.organization_id != organization_id:
        raise NotFoundError("La obligación recurrente no existe en esta organización")
    return row


def list_templates(db: Session, *, store_id: int, include_inactive: bool) -> list[ObligationTemplate]:
    stmt = select(ObligationTemplate).where(ObligationTemplate.store_id == store_id)
    if not include_inactive:
        stmt = stmt.where(ObligationTemplate.deactivated_at.is_(None))
    return list(db.execute(stmt.order_by(ObligationTemplate.due_day, ObligationTemplate.id)).scalars())


def create_template(db: Session, *, actor: Actor, store: Store, payload: ObligationTemplateIn) -> ObligationTemplate:
    employee_id, employee_name = service._actor_identity(actor)
    row = ObligationTemplate(
        organization_id=store.organization_id,
        store_id=store.id,
        category=ObligationCategory(payload.category),
        description=payload.description,
        amount=payload.amount,
        interval_months=payload.interval_months,
        due_day=payload.due_day,
        start_month=month_start(payload.start_month),
        created_by_employee_id=employee_id,
        created_by_employee_name=employee_name,
        created_at=clock.now_utc(),
    )
    db.add(row)
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="obligation_template",
        entity_id=row.id,
        action="create",
        before=None,
        after={
            "category": row.category.value,
            "amount": row.amount,
            "interval_months": row.interval_months,
            "due_day": row.due_day,
            "start_month": row.start_month.isoformat(),
        },
    )
    return row


def update_template(
    db: Session, *, actor: Actor, template: ObligationTemplate, payload: ObligationTemplateUpdateIn
) -> ObligationTemplate:
    if template.deactivated_at is not None:
        raise AppError(
            code="TEMPLATE_DEACTIVATED",
            message="Esta obligación recurrente está desactivada; creá una nueva si vuelve a repetirse",
            status=400,
        )
    changes = payload.model_dump(exclude_none=True)
    if not changes:
        raise AppError(code="VALIDATION_ERROR", message="No hay nada que cambiar", status=400)
    before = {key: getattr(template, key) for key in changes}
    for key, value in changes.items():
        setattr(template, key, value)
    template.updated_at = clock.now_utc()
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=template.organization_id,
        store_id=template.store_id,
        entity="obligation_template",
        entity_id=template.id,
        action="update",
        before=before,
        after=changes,
    )
    return template


def deactivate_template(db: Session, *, actor: Actor, template: ObligationTemplate, reason: str) -> ObligationTemplate:
    """Deja de repetirse. NO toca lo ya generado: esas obligaciones se deben
    igual y siguen con su plata y sus abonos."""
    if template.deactivated_at is not None:
        raise AppError(code="TEMPLATE_DEACTIVATED", message="Esta obligación recurrente ya está desactivada", status=400)
    employee_id, employee_name = service._actor_identity(actor)
    template.deactivated_at = clock.now_utc()
    template.deactivated_reason = reason
    template.deactivated_by_employee_id = employee_id
    template.deactivated_by_employee_name = employee_name
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=template.organization_id,
        store_id=template.store_id,
        entity="obligation_template",
        entity_id=template.id,
        action="deactivate",
        before={"deactivated_at": None},
        after={"deactivated_at": template.deactivated_at.isoformat()},
        reason=reason,
    )
    return template


def is_due_in(template: ObligationTemplate, period_month: date) -> bool:
    months = _months_between(template.start_month, period_month)
    return months >= 0 and months % template.interval_months == 0


# ---------------------------------------------------------------------------
# «Armar el mes».
# ---------------------------------------------------------------------------


def _existing_copies(db: Session, *, template_ids: list[int], period_months: list[date]) -> dict[tuple[int, date], Obligation]:
    if not template_ids or not period_months:
        return {}
    rows = db.execute(
        select(Obligation).where(Obligation.template_id.in_(template_ids), Obligation.period_month.in_(period_months))
    ).scalars()
    return {(r.template_id, r.period_month): r for r in rows if r.template_id is not None and r.period_month is not None}


def _plan_line(template: ObligationTemplate, period_month: date, existing: Obligation | None) -> MonthPlanLineOut:
    if existing is not None:
        return MonthPlanLineOut(
            template_id=template.id,
            description=existing.description,
            category=template.category.value,  # type: ignore[arg-type]
            amount=existing.amount,
            due_date=existing.due_date,
            period_month=period_month,
            obligation_id=existing.id,
            cancelled=existing.cancelled_at is not None,
        )
    return MonthPlanLineOut(
        template_id=template.id,
        description=template.description,
        category=template.category.value,  # type: ignore[arg-type]
        amount=template.amount,
        due_date=day_in_month(period_month, template.due_day),
        period_month=period_month,
        obligation_id=None,
        cancelled=False,
    )


def month_plan(db: Session, *, store: Store, year: int, month: int) -> MonthPlanOut:
    if not (2000 <= year <= 2100) or not (1 <= month <= 12):
        raise AppError("VALIDATION_ERROR", "Elegí un mes válido (año 2000–2100, mes 1–12)", status=400)
    period = date(year, month, 1)
    templates = list_templates(db, store_id=store.id, include_inactive=False)
    due = [t for t in templates if is_due_in(t, period)]
    existing = _existing_copies(db, template_ids=[t.id for t in due], period_months=[period])
    to_create: list[MonthPlanLineOut] = []
    already: list[MonthPlanLineOut] = []
    for template in due:
        copy = existing.get((template.id, period))
        (already if copy is not None else to_create).append(_plan_line(template, period, copy))
    return MonthPlanOut(
        store_id=store.id,
        year=year,
        month=month,
        period_month=period,
        active_templates=len(templates),
        to_create=to_create,
        to_create_total=sum(line.amount for line in to_create),
        already_generated=already,
    )


def generate_month(db: Session, *, actor: Actor, store: Store, year: int, month: int) -> tuple[list[Obligation], list[MonthPlanLineOut]]:
    """Crea las copias del mes que falten, todas en la misma transacción.
    Cada una en su propio SAVEPOINT: si otra request la creó en el medio,
    el índice único `uq_obligations_template_period` la frena y esa copia
    pasa a «ya estaba» sin abortar el resto."""
    plan = month_plan(db, store=store, year=year, month=month)
    templates = {t.id: t for t in list_templates(db, store_id=store.id, include_inactive=False)}
    created: list[Obligation] = []
    already = list(plan.already_generated)
    for line in plan.to_create:
        template = templates[line.template_id]
        try:
            with db.begin_nested():
                row = service.new_obligation(
                    db,
                    actor=actor,
                    store=store,
                    category=template.category,
                    description=template.description,
                    amount=template.amount,
                    due_date=line.due_date,
                    origin={"template_id": template.id, "period_month": line.period_month},
                )
        except IntegrityError:
            existing = _existing_copies(db, template_ids=[template.id], period_months=[line.period_month])
            already.append(_plan_line(template, line.period_month, existing.get((template.id, line.period_month))))
            continue
        created.append(row)
    return created, already


# ---------------------------------------------------------------------------
# Agenda.
# ---------------------------------------------------------------------------

AGENDA_MAX_DAYS = 366


def agenda(db: Session, *, store: Store, days: int) -> AgendaOut:
    if not (1 <= days <= AGENDA_MAX_DAYS):
        raise AppError("VALIDATION_ERROR", f"days: elegí entre 1 y {AGENDA_MAX_DAYS} días", status=400)
    today = today_for(store)
    horizon = today + timedelta(days=days)
    rows = list(
        db.execute(
            select(Obligation)
            .where(
                Obligation.store_id == store.id,
                Obligation.cancelled_at.is_(None),
                Obligation.status != ObligationStatus.PAID,
                Obligation.due_date <= horizon,
            )
            .order_by(Obligation.due_date, Obligation.id)
        ).scalars()
    )
    paid = service.paid_amounts(db, [r.id for r in rows])
    items: list[AgendaItemOut] = []
    for row in rows:
        row_paid = paid.get(row.id, 0)
        pending = service.pending_of(row, row_paid)
        if pending <= 0:
            continue
        items.append(
            AgendaItemOut(
                obligation_id=row.id,
                description=row.description,
                category=row.category.value,  # type: ignore[arg-type]
                due_date=row.due_date,
                amount=row.amount,
                paid_amount=row_paid,
                pending_amount=pending,
                status=row.status.value,  # type: ignore[arg-type]
                overdue=row.due_date < today,
                days_until_due=(row.due_date - today).days,
            )
        )
    overdue = [i for i in items if i.overdue]
    upcoming = [i for i in items if not i.overdue]
    return AgendaOut(
        store_id=store.id,
        today=today,
        days=days,
        horizon=horizon,
        items=items,
        overdue_count=len(overdue),
        overdue_total=sum(i.pending_amount for i in overdue),
        upcoming_total=sum(i.pending_amount for i in upcoming),
        total_pending=sum(i.pending_amount for i in items),
        not_generated=_not_generated(db, store=store, today=today, horizon=horizon),
    )


def _not_generated(db: Session, *, store: Store, today: date, horizon: date) -> list[MonthPlanLineOut]:
    """Las copias de plantillas activas que vencen entre el mes de hoy y
    `horizon` y que todavía no se generaron: el aviso de «armá el mes»."""
    templates = list_templates(db, store_id=store.id, include_inactive=False)
    first = month_start(today)
    months = [add_months(first, k) for k in range(_months_between(first, horizon) + 1)]
    existing = _existing_copies(db, template_ids=[t.id for t in templates], period_months=months)
    lines: list[MonthPlanLineOut] = []
    for period in months:
        for template in templates:
            if not is_due_in(template, period) or (template.id, period) in existing:
                continue
            line = _plan_line(template, period, None)
            if line.due_date <= horizon:
                lines.append(line)
    return sorted(lines, key=lambda line: (line.due_date, line.template_id))


# ---------------------------------------------------------------------------
# Configuración y el INC del bimestre.
# ---------------------------------------------------------------------------

#: Día del mes siguiente al bimestre en que se agenda el INC si la sede no
#: eligió otro. **Supuesto declarado** (decisión del dueño: «la segunda
#: semana del mes después del bimestre»): el plazo exacto lo fija el
#: calendario tributario de la DIAN según el último dígito del NIT, y el
#: sistema no lo sabe. Se toma el PRIMER día de la segunda semana (el 8):
#: con el calendario de los últimos años (plazos del INC bimestral entre
#: ~el 9 y ~el 24 del mes siguiente) eso agenda el pago antes del plazo de
#: cualquier NIT — el error tolerable es pagar unos días antes, no tarde. La
#: sede lo cambia en `PUT /admin/obligations/settings` (1–28) con su fecha
#: real, y cada agendamiento acepta además una fecha a mano.
DEFAULT_CONSUMPTION_TAX_DUE_DAY = 8

#: Las tarifas (por ciento entero de `tax_lines[].rate`) que son INC. Hoy la
#: carta sólo tiene `inc_8` (`app.core.tax`); el IVA (19) no es INC y no se
#: suma acá.
CONSUMPTION_TAX_RATES = frozenset({TAX_RATE_BY_CODE["inc_8"]})

_BIMESTER_LABELS = (
    "enero – febrero",
    "marzo – abril",
    "mayo – junio",
    "julio – agosto",
    "septiembre – octubre",
    "noviembre – diciembre",
)


def bimester_label(year: int, bimester: int) -> str:
    return f"{_BIMESTER_LABELS[bimester - 1]} {year}"


def get_settings(db: Session, *, store: Store) -> ObligationSettingsOut:
    row = db.get(StoreObligationSettings, store.id)
    value = row.consumption_tax_due_day if row is not None else None
    return ObligationSettingsOut(
        store_id=store.id,
        consumption_tax_due_day=value,
        default_consumption_tax_due_day=DEFAULT_CONSUMPTION_TAX_DUE_DAY,
        effective_consumption_tax_due_day=value if value is not None else DEFAULT_CONSUMPTION_TAX_DUE_DAY,
    )


def put_settings(db: Session, *, actor: Actor, store: Store, payload: ObligationSettingsIn) -> ObligationSettingsOut:
    row = db.get(StoreObligationSettings, store.id)
    before = {"consumption_tax_due_day": row.consumption_tax_due_day} if row is not None else None
    if row is None:
        row = StoreObligationSettings(store_id=store.id)
        db.add(row)
    row.consumption_tax_due_day = payload.consumption_tax_due_day
    row.updated_at = clock.now_utc()
    row.updated_by_employee_id = actor.employee_id
    row.updated_by_employee_name = actor.employee_name
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="store_obligation_settings",
        entity_id=store.id,
        action="update",
        before=before,
        after={"consumption_tax_due_day": payload.consumption_tax_due_day},
    )
    return get_settings(db, store=store)


def bimester_of(value: date) -> tuple[int, int]:
    return value.year, (value.month - 1) // 2 + 1


def previous_bimester(year: int, bimester: int) -> tuple[int, int]:
    return (year - 1, 6) if bimester == 1 else (year, bimester - 1)


def consumption_tax_due_date(year: int, bimester: int, due_day: int) -> date:
    """El `due_day` del mes siguiente al cierre del bimestre (nov–dic → enero
    del año siguiente)."""
    return day_in_month(add_months(date(year, 2 * bimester, 1), 1), due_day)


def _live_tax_obligation(db: Session, *, store_id: int, year: int, bimester: int) -> Obligation | None:
    return db.execute(
        select(Obligation).where(
            Obligation.store_id == store_id,
            Obligation.tax_year == year,
            Obligation.tax_bimester == bimester,
            Obligation.cancelled_at.is_(None),
        )
    ).scalar_one_or_none()


def _validate_bimester(year: int, bimester: int) -> None:
    if not (2000 <= year <= 2100):
        raise AppError("VALIDATION_ERROR", "year: elegí un año entre 2000 y 2100", status=400)
    if not (1 <= bimester <= 6):
        raise AppError("VALIDATION_ERROR", "bimester: tiene que estar entre 1 y 6", status=400)


def consumption_tax(
    db: Session, *, store: Store, year: int | None, bimester: int | None
) -> tuple[dict[str, object], Obligation | None]:
    """El INC cobrado en un bimestre (por defecto, el último CERRADO: el que
    está corriendo todavía no se declara). Devuelve los campos de
    `ConsumptionTaxOut` sin `scheduled` y la obligación viva, si existe."""
    from app.reports import hooks as reports_hooks

    today = today_for(store)
    if year is None or bimester is None:
        year, bimester = previous_bimester(*bimester_of(today))
    _validate_bimester(year, bimester)

    taxes = reports_hooks.bimester_tax(db, store_id=store.id, year=year, bimester=bimester)
    inc_rates = {rate: values for rate, values in taxes.by_rate.items() if rate in CONSUMPTION_TAX_RATES}
    base: int | None
    tax_amount: int | None
    reason: str | None = None
    if taxes.documents == 0:
        base = tax_amount = None
        reason = f"No hay ventas facturadas en {bimester_label(year, bimester)}: no hay INC que medir."
    else:
        base = sum(b for b, _t in inc_rates.values())
        tax_amount = sum(t for _b, t in inc_rates.values())
        if tax_amount == 0:
            reason = (
                f"Las ventas de {bimester_label(year, bimester)} no tienen INC (8 %): "
                "si la sede cobra IVA, el INC no aplica."
            )
    settings = get_settings(db, store=store)
    due_day = settings.effective_consumption_tax_due_day
    fields: dict[str, object] = {
        "store_id": store.id,
        "year": year,
        "bimester": bimester,
        "label": bimester_label(year, bimester),
        "date_from": taxes.date_from,
        "date_to": taxes.date_to,
        "closed": taxes.date_to < today,
        "documents": taxes.documents,
        "rates": [
            ConsumptionTaxRateOut(rate=rate, base=b, tax=t) for rate, (b, t) in sorted(taxes.by_rate.items())
        ],
        "base": base,
        "tax_amount": tax_amount,
        "reason": reason,
        "due_day": due_day,
        "due_day_is_default": settings.consumption_tax_due_day is None,
        "due_date": consumption_tax_due_date(year, bimester, due_day),
    }
    return fields, _live_tax_obligation(db, store_id=store.id, year=year, bimester=bimester)


#: Un monto a mano por debajo de un QUINTO de lo cobrado se rebota (café: un
#: dígito que falta es un factor de diez exacto). Escribir de más no rebota:
#: reserva de más, que es el lado seguro.
_MIN_MANUAL_FRACTION = 5


def schedule_consumption_tax(
    db: Session, *, actor: Actor, store: Store, payload: ConsumptionTaxScheduleIn
) -> tuple[Obligation, bool]:
    fields, existing = consumption_tax(db, store=store, year=payload.year, bimester=payload.bimester)
    if existing is not None:
        return existing, True
    label = str(fields["label"])
    if not fields["closed"]:
        raise AppError(
            code="BIMESTER_NOT_CLOSED",
            message=(
                f"El bimestre {label} todavía no cerró: lo que lleva facturado no es lo que se va a declarar. "
                "Agendalo cuando termine."
            ),
            status=400,
        )
    measured = fields["tax_amount"]
    assert measured is None or isinstance(measured, int)
    if payload.amount is None:
        if not measured:
            raise AppError(
                code="CONSUMPTION_TAX_UNAVAILABLE",
                message=f"No se puede agendar el INC de {label}: {fields['reason']} Si tenés la cifra del contador, escribila.",
                status=400,
            )
        amount = measured
    else:
        amount = payload.amount
        if measured and amount * _MIN_MANUAL_FRACTION < measured:
            raise AppError(
                code="CONSUMPTION_TAX_AMOUNT_TOO_LOW",
                message=(
                    f"Escribiste {format_cop(amount)} y el INC cobrado en {label} fue {format_cop(measured)}: "
                    "revisá la cifra del contador (¿falta un dígito?)."
                ),
                status=400,
            )
    due_date = payload.due_date or fields["due_date"]
    assert isinstance(due_date, date)
    try:
        with db.begin_nested():
            row = service.new_obligation(
                db,
                actor=actor,
                store=store,
                category=ObligationCategory.CONSUMPTION_TAX,
                description=f"INC {label}",
                amount=amount,
                due_date=due_date,
                origin={"tax_year": payload.year, "tax_bimester": payload.bimester},
            )
    except IntegrityError:
        concurrent = _live_tax_obligation(db, store_id=store.id, year=payload.year, bimester=payload.bimester)
        if concurrent is None:
            raise
        return concurrent, True
    return row, False


# ---------------------------------------------------------------------------
# Nómina.
# ---------------------------------------------------------------------------


def _assert_payroll(db: Session, store: Store) -> None:
    features.assert_feature(db, store.organization_id, store.id, "payroll")


def _live_payroll_obligations(db: Session, run_ids: list[int]) -> dict[int, Obligation]:
    if not run_ids:
        return {}
    rows = db.execute(
        select(Obligation).where(Obligation.payroll_run_id.in_(run_ids), Obligation.cancelled_at.is_(None))
    ).scalars()
    return {r.payroll_run_id: r for r in rows if r.payroll_run_id is not None}


def payroll_candidates(db: Session, *, store: Store) -> list[PayrollRunCandidateOut]:
    from app.payroll import hooks as payroll_hooks

    _assert_payroll(db, store)
    runs = payroll_hooks.list_run_totals(db, store_id=store.id)
    scheduled = _live_payroll_obligations(db, [r.id for r in runs])
    return [
        PayrollRunCandidateOut(
            payroll_run_id=r.id,
            date_from=r.date_from,
            date_to=r.date_to,
            amount=r.amount,
            amount_source=r.amount_source,
            computed_at=r.computed_at,
            scheduled_obligation_id=scheduled[r.id].id if r.id in scheduled else None,
        )
        for r in runs
    ]


def schedule_payroll(db: Session, *, actor: Actor, store: Store, payload: PayrollScheduleIn) -> tuple[Obligation, bool]:
    from app.payroll import hooks as payroll_hooks

    _assert_payroll(db, store)
    run = payroll_hooks.get_run_total(db, run_id=payload.payroll_run_id)
    if run is None or run.store_id != store.id:
        raise NotFoundError("Esa liquidación de nómina no existe en esta sede")
    existing = _live_payroll_obligations(db, [run.id]).get(run.id)
    if existing is not None:
        return existing, True
    amount = payload.amount if payload.amount is not None else run.amount
    if amount is None:
        raise AppError(
            code="PAYROLL_RUN_WITHOUT_TOTAL",
            message=(
                "Esa liquidación no tiene total (a alguien le faltaba la tarifa o el contrato): "
                "liquidá de nuevo en Nómina o escribí el monto."
            ),
            status=400,
        )
    description = f"Nómina {run.date_from.strftime('%d/%m')} – {run.date_to.strftime('%d/%m/%Y')}"
    try:
        with db.begin_nested():
            row = service.new_obligation(
                db,
                actor=actor,
                store=store,
                category=ObligationCategory.PAYROLL,
                description=description,
                amount=amount,
                due_date=payload.due_date or run.date_to,
                origin={"payroll_run_id": run.id},
            )
    except IntegrityError:
        concurrent = _live_payroll_obligations(db, [run.id]).get(run.id)
        if concurrent is None:
            raise
        return concurrent, True
    return row, False
