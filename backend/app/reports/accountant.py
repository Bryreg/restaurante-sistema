"""Informe del contador (`GET /admin/accountant-report`), «igual que
café-sistema» (decisión del dueño 2026-09): por día operativo, lo cobrado
partido en efectivo / tarjeta / transferencia / otros, total, acumulado,
facturas y ticket promedio; los totales del mes con promedios, participación
por medio, día de mayor y menor venta, la comparación contra el período
anterior y la meta del mes. **Sin nómina** (el dueño lo pidió así).

Encima de lo que café tenía, lo fiscal que el contador de un restaurante
necesita y café no: base, impuesto (por tarifa), notas crédito y propinas.
Las propinas **no son venta** (Ley 1935 de 2018): van en su columna y nunca
suman al total.

**Una sola matemática, acá.** Los promedios, los porcentajes, los deltas y el
avance de la meta los calcula este módulo con `money.round_half_up` (enteros,
sin float); la interfaz sólo pinta. `null` no es 0: un promedio sin divisor,
un delta contra un período en cero o una meta que no existe viajan como
`null`.

**El ticket promedio no es de este módulo**: es `service.average_ticket`
(venta neta sin impuesto ni propina ÷ comandas distintas), el mismo de «Hoy»
y «Ventas» (auditoría u9: antes era lo cobrado con impuesto ÷ facturas y no
cuadraba con «Hoy»). «Facturas» sigue siendo su propia columna.

Lee los mismos documentos que «Ventas» (`service._sale_documents`: emitidos,
no reversados) — el documento que una nota corrige queda `reversed` y deja de
sumar; la nota se lista aparte en «Notas crédito».
"""

from __future__ import annotations

import csv
import io
from collections import defaultdict
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.auth.deps import Actor
from app.core import clock, tz
from app.core.errors import AppError, ConflictError
from app.fiscal.models import FiscalDocument, FiscalDocumentType
from app.orders import money
from app.reports import service
from app.reports.models import SalesGoal
from app.reports.schemas import (
    AccountantComparisonOut,
    AccountantDayOut,
    AccountantDayRefOut,
    AccountantDeltaOut,
    AccountantGoalOut,
    AccountantMethodShareOut,
    AccountantRateBreakdownOut,
    AccountantRateTotalOut,
    AccountantReportOut,
    AccountantRowOut,
    AccountantSummaryOut,
    GoalPaceOut,
    MethodAmountOut,
)
from app.stores.models import Store

MONTH_NAMES = (
    "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
)
BIMESTER_NAMES = (
    "Enero – Febrero", "Marzo – Abril", "Mayo – Junio",
    "Julio – Agosto", "Septiembre – Octubre", "Noviembre – Diciembre",
)

METHOD_GROUPS: tuple[str, ...] = ("cash", "card", "transfer", "other")
METHOD_GROUP_LABELS = {"cash": "Efectivo", "card": "Tarjeta", "transfer": "Transferencia", "other": "Otros"}

# Los medios de pago son datos de la sede (`StoreSalesSettings.
# payment_methods`), no un enum: se agrupan por el código del medio y, si el
# código no se reconoce, por su código DIAN congelado en el documento. Lo que
# no cae en ninguno (plataformas de domicilio, bonos…) va a «Otros».
_CODE_GROUP: dict[str, str] = {
    "cash": "cash",
    "efectivo": "cash",
    "card": "card",
    "credit_card": "card",
    "debit_card": "card",
    "dataphone": "card",
    "datafono": "card",
    "datáfono": "card",
    "tarjeta": "card",
    "transfer": "transfer",
    "bank_transfer": "transfer",
    "transferencia": "transfer",
    "nequi": "transfer",
    "daviplata": "transfer",
    "qr": "transfer",
    "pse": "transfer",
}
_DIAN_GROUP: dict[str, str] = {"10": "cash", "48": "card", "49": "card", "47": "transfer", "42": "transfer"}

# Las notas que devuelven plata. La nota débito cobra más: no es «nota
# crédito» y no entra en esa columna (sí en el desglose fiscal por tarifa).
CREDIT_NOTE_TYPES = (FiscalDocumentType.ADJUSTMENT_NOTE, FiscalDocumentType.CREDIT_NOTE)

CSV_HEADER = (
    "Dia operativo",
    "Efectivo",
    "Tarjeta",
    "Transferencia",
    "Otros",
    "Total Diario",
    "Acumulado Mes",
    "Facturas",
    "Ticket Promedio",
    "Base",
    "Impuesto",
    "Notas credito",
    "Propinas",
)


def method_group(split: dict[str, Any]) -> str:
    code = str(split.get("method") or "").strip().lower()
    if code in _CODE_GROUP:
        return _CODE_GROUP[code]
    dian = str(split.get("dian_code") or "").strip()
    return _DIAN_GROUP.get(dian, "other")


def _avg(numerator: int, denominator: int) -> int | None:
    """Promedio entero half-up; `null` sin divisor (nunca un $0 inventado)."""
    if denominator <= 0 or numerator < 0:
        return None
    return money.round_half_up(numerator, denominator)


def delta_pct(current: int | None, previous: int | None) -> int | None:
    """Cambio en por ciento entero con signo, redondeado half-up lejos de
    cero. `null` si el anterior es 0/`null` o el actual es `null`."""
    if current is None or previous is None or previous <= 0:
        return None
    diff = current - previous
    magnitude = money.round_half_up(abs(diff) * 100, previous)
    return magnitude if diff >= 0 else -magnitude


# ---------------------------------------------------------------------------
# El cómputo de un período (se usa para el pedido y para el anterior).
# ---------------------------------------------------------------------------


@dataclass
class _Day:
    methods: dict[str, int] = field(default_factory=lambda: {g: 0 for g in METHOD_GROUPS})
    documents: int = 0
    #: Venta neta (sin impuesto ni propina) y comandas distintas: los dos
    #: lados del ticket promedio (`service.average_ticket`).
    net: int = 0
    order_ids: set[int] = field(default_factory=set)
    base: int = 0
    tax: int = 0
    credit_notes: int = 0
    tips: int = 0


@dataclass
class _Period:
    date_from: date
    date_to: date
    period_kind: str
    period: int
    sale_docs: list[FiscalDocument]
    note_docs: list[FiscalDocument]
    days: list[AccountantDayOut]
    summary: AccountantSummaryOut


def _days_in_period(date_from: date, date_to: date, today: date) -> int:
    """Café-sistema: mes en curso → días transcurridos (hoy incluido); mes
    cerrado → todos sus días; mes futuro → 0 (y el promedio queda `null`).
    Numerador por día operativo, divisor por calendario: un mes tiene los
    días que tiene, y «por día con venta» es el otro promedio."""
    if today < date_from:
        return 0
    if today > date_to:
        return (date_to - date_from).days + 1
    return (today - date_from).days + 1


def _compute(
    db: Session, *, store_ids: list[int], year: int, bimester: int | None, month: int | None, today: date
) -> _Period:
    date_from, date_to, period_kind, period = service._period_range(year, bimester=bimester, month=month)
    sale_docs = service._sale_documents(db, store_id=store_ids, date_from=date_from, date_to=date_to)
    note_docs = list(
        db.execute(
            select(FiscalDocument)
            .where(
                FiscalDocument.store_id.in_(store_ids),
                FiscalDocument.business_date >= date_from,
                FiscalDocument.business_date <= date_to,
                FiscalDocument.document_type.in_(service.NOTE_DOCUMENT_TYPES),
                FiscalDocument.status == "issued",
            )
            .order_by(FiscalDocument.business_date, FiscalDocument.id)
        ).scalars()
    )

    per_day: dict[date, _Day] = defaultdict(_Day)
    by_rate: dict[int, list[int]] = {}
    for doc in sale_docs:
        day = per_day[doc.business_date]
        day.documents += 1
        day.net += int(doc.total) - int(doc.tax_total)
        day.order_ids.add(doc.order_id)
        day.tips += int(doc.tip_amount or 0)
        for split in doc.payments_snapshot or []:
            day.methods[method_group(split)] += int(split.get("amount", 0))
        for line in doc.tax_lines or []:
            day.base += int(line["base"])
            day.tax += int(line["tax"])
            bucket = by_rate.setdefault(int(line["rate"]), [0, 0])
            bucket[0] += int(line["base"])
            bucket[1] += int(line["tax"])
    for doc in note_docs:
        if doc.document_type in CREDIT_NOTE_TYPES:
            per_day[doc.business_date].credit_notes += int(doc.total)

    days: list[AccountantDayOut] = []
    cumulative = 0
    for business_date in sorted(per_day):
        d = per_day[business_date]
        total = sum(d.methods.values())
        cumulative += total
        days.append(
            AccountantDayOut(
                business_date=business_date,
                cash=d.methods["cash"],
                card=d.methods["card"],
                transfer=d.methods["transfer"],
                other=d.methods["other"],
                total=total,
                cumulative=cumulative,
                documents_count=d.documents,
                orders_count=len(d.order_ids),
                avg_ticket=service.average_ticket(d.net, len(d.order_ids)),
                base=d.base,
                tax=d.tax,
                credit_notes=d.credit_notes,
                tips=d.tips,
            )
        )

    totals = {g: sum(getattr(d, g) for d in days) for g in METHOD_GROUPS}
    grand_total = sum(totals.values())
    documents = sum(d.documents_count for d in days)
    # El ticket promedio es el de «Hoy» y «Ventas» (`service.average_ticket`):
    # venta neta sin impuesto ni propina ÷ comandas distintas — no lo cobrado
    # con impuesto ÷ facturas (auditoría u9).
    period_net, period_orders = service.ticket_basis(sale_docs)
    selling_days = [d for d in days if d.documents_count > 0]
    days_in_period = _days_in_period(date_from, date_to, today)
    best = max(selling_days, key=lambda d: d.total) if selling_days else None
    worst = min(selling_days, key=lambda d: d.total) if selling_days else None

    summary = AccountantSummaryOut(
        total=grand_total,
        cash=totals["cash"],
        card=totals["card"],
        transfer=totals["transfer"],
        other=totals["other"],
        documents_count=documents,
        orders_count=period_orders,
        days_with_sales=len(selling_days),
        days_in_period=days_in_period,
        avg_daily_with_sales=_avg(grand_total, len(selling_days)),
        avg_daily_calendar=_avg(grand_total, days_in_period),
        avg_ticket=service.average_ticket(period_net, period_orders),
        base=sum(d.base for d in days),
        tax=sum(d.tax for d in days),
        credit_notes=sum(d.credit_notes for d in days),
        tips=sum(d.tips for d in days),
        shares=[
            AccountantMethodShareOut(
                method=g,  # type: ignore[arg-type]
                label=METHOD_GROUP_LABELS[g],
                amount=totals[g],
                share_bp=_avg(totals[g] * 10_000, grand_total),
            )
            for g in METHOD_GROUPS
        ],
        best_day=AccountantDayRefOut(business_date=best.business_date, total=best.total) if best else None,
        worst_day=AccountantDayRefOut(business_date=worst.business_date, total=worst.total) if worst else None,
        tax_by_rate=[AccountantRateTotalOut(rate=r, base=b, tax=t) for r, (b, t) in sorted(by_rate.items())],
    )
    return _Period(
        date_from=date_from,
        date_to=date_to,
        period_kind=period_kind,
        period=period,
        sale_docs=sale_docs,
        note_docs=note_docs,
        days=days,
        summary=summary,
    )


def _previous(year: int, *, bimester: int | None, month: int | None) -> tuple[int, int | None, int | None]:
    if month is not None:
        return (year - 1, None, 12) if month == 1 else (year, None, month - 1)
    assert bimester is not None
    return (year - 1, 6, None) if bimester == 1 else (year, bimester - 1, None)


def _legacy_rows(period: _Period) -> tuple[list[AccountantRowOut], list[MethodAmountOut], dict[str, int]]:
    """Las filas por día y tarifa de siempre (el contrato que ya existía):
    documentos y notas en columnas separadas, nunca neteadas."""
    by_date_rate: dict[tuple[date, int], dict[str, int]] = {}
    docs_per_date: dict[date, int] = defaultdict(int)
    notes_per_date: dict[date, int] = defaultdict(int)
    tips_per_date: dict[date, int] = defaultdict(int)
    methods_total: dict[str, int] = defaultdict(int)

    def bucket(key: tuple[date, int]) -> dict[str, int]:
        return by_date_rate.setdefault(key, {"documents_base": 0, "documents_tax": 0, "notes_base": 0, "notes_tax": 0})

    for doc in period.sale_docs:
        docs_per_date[doc.business_date] += 1
        tips_per_date[doc.business_date] += doc.tip_amount
        for line in doc.tax_lines or []:
            b = bucket((doc.business_date, int(line["rate"])))
            b["documents_base"] += int(line["base"])
            b["documents_tax"] += int(line["tax"])
        for split in doc.payments_snapshot or []:
            methods_total[str(split.get("method", "other"))] += int(split.get("amount", 0))
    for doc in period.note_docs:
        notes_per_date[doc.business_date] += 1
        for line in doc.tax_lines or []:
            b = bucket((doc.business_date, int(line["rate"])))
            b["notes_base"] += int(line["base"])
            b["notes_tax"] += int(line["tax"])

    totals = {"documents_base": 0, "documents_tax": 0, "notes_base": 0, "notes_tax": 0}
    rows: list[AccountantRowOut] = []
    for business_date in sorted(set(docs_per_date) | set(notes_per_date) | {d for d, _r in by_date_rate}):
        rates = [
            AccountantRateBreakdownOut(rate=rate, **values)
            for (d, rate), values in sorted(by_date_rate.items())
            if d == business_date
        ]
        for r in rates:
            for key in totals:
                totals[key] += getattr(r, key)
        rows.append(
            AccountantRowOut(
                business_date=business_date,
                documents_count=docs_per_date.get(business_date, 0),
                notes_count=notes_per_date.get(business_date, 0),
                tips_amount=tips_per_date.get(business_date, 0),
                by_rate=rates,
            )
        )
    totals["tips"] = sum(tips_per_date.values())
    methods = [MethodAmountOut(method=m, amount=a) for m, a in sorted(methods_total.items())]
    return rows, methods, totals


# ---------------------------------------------------------------------------
# La meta del mes.
# ---------------------------------------------------------------------------


def _effective_goal(db: Session, store_id: int, year: int, month: int) -> tuple[int | None, str | None, str | None]:
    """`(monto, origen, heredada_de)`. La fila del mes manda (aunque diga
    «sin meta»); sin fila, la del último mes anterior que tenga una."""
    row = db.execute(
        select(SalesGoal)
        .where(
            SalesGoal.store_id == store_id,
            (SalesGoal.year < year) | ((SalesGoal.year == year) & (SalesGoal.month <= month)),
        )
        .order_by(SalesGoal.year.desc(), SalesGoal.month.desc())
        .limit(1)
    ).scalar_one_or_none()
    if row is None or row.amount is None:
        return None, None, None
    if row.year == year and row.month == month:
        return row.amount, "month", None
    return row.amount, "inherited", f"{row.year:04d}-{row.month:02d}"


def _goal_out(*, year: int, month: int, amount: int | None, source: str | None, inherited_from: str | None,
              total: int, editable: bool) -> AccountantGoalOut:
    if amount is None or amount <= 0:
        return AccountantGoalOut(
            year=year, month=month, amount=None, source=None, inherited_from=None,
            progress_bp=None, bar_bp=None, remaining=None, met=None, editable=editable,
        )
    progress = money.round_half_up(total * 10_000, amount)
    return AccountantGoalOut(
        year=year,
        month=month,
        amount=amount,
        source=source,  # type: ignore[arg-type]
        inherited_from=inherited_from,
        progress_bp=progress,
        bar_bp=min(progress, 10_000),
        remaining=max(amount - total, 0),
        met=total >= amount,
        editable=editable,
    )


def _goal_for(db: Session, *, stores: Sequence[Store], all_stores: bool, year: int, month: int | None,
              total: int) -> AccountantGoalOut | None:
    if month is None:
        return None  # la meta es mensual: en bimestre no se inventa una suma
    if not all_stores:
        amount, source, inherited_from = _effective_goal(db, stores[0].id, year, month)
        return _goal_out(year=year, month=month, amount=amount, source=source, inherited_from=inherited_from,
                         total=total, editable=True)
    amounts = [_effective_goal(db, s.id, year, month)[0] for s in stores]
    combined = sum(a for a in amounts if a is not None) if amounts and all(a is not None for a in amounts) else None
    return _goal_out(year=year, month=month, amount=combined, source="sum" if combined else None,
                     inherited_from=None, total=total, editable=False)


def get_goal(db: Session, *, store: Store, year: int, month: int) -> AccountantGoalOut:
    """La meta del mes con su avance contra lo cobrado de ese mes (el mismo
    total del informe): quien acaba de guardarla la ve ya con su barra, sin
    que la interfaz haga la cuenta."""
    _validate_month(month)
    if year < 2000 or year > 2100:
        raise AppError("VALIDATION_ERROR", "year: elegí un año entre 2000 y 2100", status=400)
    amount, source, inherited_from = _effective_goal(db, store.id, year, month)
    total = 0
    if amount is not None:
        today = tz.today_business_date(store.cutoff_hour)
        total = _compute(db, store_ids=[store.id], year=year, bimester=None, month=month, today=today).summary.total
    return _goal_out(year=year, month=month, amount=amount, source=source, inherited_from=inherited_from,
                     total=total, editable=True)


def goal_pace(db: Session, *, store: Store) -> GoalPaceOut:
    """El ritmo del mes en curso hacia su meta (h6), sobre lo cobrado —el
    total del informe del contador, la misma base del avance de la meta—.
    Toda la cuenta acá; Hoy sólo pinta."""
    today = tz.today_business_date(store.cutoff_hour)
    year, month = today.year, today.month
    period = _compute(db, store_ids=[store.id], year=year, bimester=None, month=month, today=today)
    mtd = period.summary.total
    closed_total = sum(d.total for d in period.days if d.business_date < today)
    days_in_month = (period.date_to - period.date_from).days + 1
    days_elapsed = (today - period.date_from).days + 1
    closed_days = days_elapsed - 1
    amount, source, inherited_from = _effective_goal(db, store.id, year, month)
    goal = amount if amount is not None and amount > 0 else None

    projected: int | None = None
    projection_reason: str | None = None
    if closed_days <= 0:
        projection_reason = "El mes empezó hoy: la proyección sale con el primer día cerrado."
    else:
        projected = money.round_half_up(closed_total * days_in_month, closed_days)

    if goal is None:
        return GoalPaceOut(
            year=year, month=month, goal=None, goal_source=None, goal_inherited_from=None,
            month_to_date=mtd, closed_days=closed_days, days_elapsed=days_elapsed, days_in_month=days_in_month,
            expected_to_date=None, gap_to_expected=None, progress_bp=None,
            projected_month_end=projected, projected_vs_goal_bp=None, on_track=None,
            reason="Este mes no tiene meta de ventas: ponela en Informe del contador.",
            projection_reason=projection_reason,
        )
    expected = money.round_half_up(goal * days_elapsed, days_in_month)
    return GoalPaceOut(
        year=year,
        month=month,
        goal=goal,
        goal_source=source,  # type: ignore[arg-type]
        goal_inherited_from=inherited_from,
        month_to_date=mtd,
        closed_days=closed_days,
        days_elapsed=days_elapsed,
        days_in_month=days_in_month,
        expected_to_date=expected,
        gap_to_expected=mtd - expected,
        progress_bp=money.round_half_up(mtd * 10_000, goal),
        projected_month_end=projected,
        projected_vs_goal_bp=money.round_half_up(projected * 10_000, goal) if projected is not None else None,
        on_track=(projected >= goal) if projected is not None else (mtd >= expected),
        reason=None,
        projection_reason=projection_reason,
    )


def _validate_month(month: int) -> None:
    if month < 1 or month > 12:
        raise AppError("VALIDATION_ERROR", "month: tiene que estar entre 1 y 12", status=400)


def set_goal(db: Session, *, actor: Actor, store: Store, year: int, month: int, amount: int | None) -> SalesGoal:
    """Pone (o quita, con `amount` nulo o 0) la meta de ese mes. Auditado."""
    _validate_month(month)
    if year < 2000 or year > 2100:
        raise AppError("VALIDATION_ERROR", "year: elegí un año entre 2000 y 2100", status=400)
    if amount is not None and amount < 0:
        raise AppError("VALIDATION_ERROR", "La meta no puede ser negativa: escribí 0 para dejar el mes sin meta", status=400)
    value = amount if amount else None
    row = db.execute(
        select(SalesGoal).where(SalesGoal.store_id == store.id, SalesGoal.year == year, SalesGoal.month == month)
    ).scalar_one_or_none()
    before = {"amount": row.amount} if row is not None else None
    now = clock.now_utc()
    try:
        with db.begin_nested():
            if row is None:
                row = SalesGoal(organization_id=store.organization_id, store_id=store.id, year=year, month=month)
                db.add(row)
            row.amount = value
            row.updated_at = now
            row.updated_by_employee_id = actor.employee_id
            row.updated_by_employee_name = actor.employee_name
            db.flush()
    except IntegrityError as exc:
        raise ConflictError("Otra persona guardó la meta de este mes al mismo tiempo: recargá y volvé a intentar") from exc
    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="sales_goal",
        entity_id=f"{store.id}:{year:04d}-{month:02d}",
        action="update" if before is not None else "create",
        before=before,
        after={"amount": value, "year": year, "month": month},
    )
    return row


# ---------------------------------------------------------------------------
# El informe.
# ---------------------------------------------------------------------------


def accountant_report(
    db: Session, *, stores: Sequence[Store], all_stores: bool, year: int, bimester: int | None, month: int | None
) -> AccountantReportOut:
    store_ids = [s.id for s in stores]
    today = tz.today_business_date(stores[0].cutoff_hour if stores else 6)
    current = _compute(db, store_ids=store_ids, year=year, bimester=bimester, month=month, today=today)
    prev_year, prev_bimester, prev_month = _previous(year, bimester=bimester, month=month)
    previous = _compute(db, store_ids=store_ids, year=prev_year, bimester=prev_bimester, month=prev_month, today=today)

    rows, methods, legacy_totals = _legacy_rows(current)
    s, p = current.summary, previous.summary
    prev_period = prev_month if prev_month is not None else prev_bimester
    assert prev_period is not None
    prev_label = (
        f"{MONTH_NAMES[prev_period - 1]} {prev_year}"
        if prev_month is not None
        else f"{BIMESTER_NAMES[prev_period - 1]} {prev_year}"
    )

    def delta(cur: int | None, prev: int | None) -> AccountantDeltaOut:
        return AccountantDeltaOut(previous=prev, pct=delta_pct(cur, prev))

    return AccountantReportOut(
        store_id=None if all_stores else store_ids[0],
        all_stores=all_stores,
        year=year,
        period_kind=current.period_kind,  # type: ignore[arg-type]
        period=current.period,
        date_from=current.date_from,
        date_to=current.date_to,
        rows=rows,
        totals_by_method=methods,
        documents_total_base=legacy_totals["documents_base"],
        documents_total_tax=legacy_totals["documents_tax"],
        notes_total_base=legacy_totals["notes_base"],
        notes_total_tax=legacy_totals["notes_tax"],
        tips_total=legacy_totals["tips"],
        days=current.days,
        summary=s,
        comparison=AccountantComparisonOut(
            previous_year=prev_year,
            previous_period=prev_period,
            previous_label=prev_label,
            total=delta(s.total, p.total),
            avg_daily_calendar=delta(s.avg_daily_calendar, p.avg_daily_calendar),
            avg_daily_with_sales=delta(s.avg_daily_with_sales, p.avg_daily_with_sales),
            avg_ticket=delta(s.avg_ticket, p.avg_ticket),
        ),
        goal=_goal_for(db, stores=stores, all_stores=all_stores, year=year, month=month, total=s.total),
    )


def csv_filename(report: AccountantReportOut) -> str:
    if report.period_kind == "month":
        return f"informe-contador-{report.year:04d}-{report.period:02d}.csv"
    return f"informe-contador-{report.year:04d}-bimestre-{report.period}.csv"


def csv_lines(report: AccountantReportOut) -> Iterator[str]:
    """El «Excel» de café-sistema: `;` como separador (Excel en español lo
    abre en columnas), BOM UTF-8 para las tildes, una fila por día operativo
    y la fila TOTAL. Cifras en pesos enteros, sin separador de miles."""

    def line(values: Sequence[Any]) -> str:
        buffer = io.StringIO()
        csv.writer(buffer, delimiter=";", lineterminator="\r\n").writerow(
            ["" if v is None else v for v in values]
        )
        return buffer.getvalue()

    yield "﻿" + line(CSV_HEADER)
    for d in report.days:
        yield line(
            [
                d.business_date.isoformat(), d.cash, d.card, d.transfer, d.other, d.total, d.cumulative,
                d.documents_count, d.avg_ticket, d.base, d.tax, d.credit_notes, d.tips,
            ]
        )
    s = report.summary
    yield line(
        [
            "TOTAL", s.cash, s.card, s.transfer, s.other, s.total, "", s.documents_count, s.avg_ticket,
            s.base, s.tax, s.credit_notes, s.tips,
        ]
    )
