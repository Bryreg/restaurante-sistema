"""Endpoints de `expenses` (`/api/v1/...`). Todo de admin, todo detrás de
`require_feature("money.obligations")`. `router.py` es sólo borde HTTP: la
matemática (punto de equilibrio, utilidad, la llave anti doble conteo) vive
en `service.py`.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from app.auth.deps import Actor, admin_store, current_admin
from app.core import clock
from app.core.db import get_db
from app.core.features import require_feature
from app.core.idempotency import hash_request_body, idempotency_key, run_idempotent
from app.expenses import service
from app.expenses.models import Expense, ObligationStatus, Obligation
from app.expenses.schemas import (
    BreakEvenOut,
    ExpenseIn,
    ExpenseOut,
    ExpensesSettingsIn,
    ExpensesSettingsOut,
    ExpenseVoidIn,
    ObligationCancelIn,
    ObligationIn,
    ObligationOut,
    ObligationSettleIn,
    ProfitOut,
)

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


def _obligation_out(row: Obligation) -> ObligationOut:
    today = clock.now_utc().date()
    overdue = row.cancelled_at is None and row.status == ObligationStatus.PENDING and row.due_date < today
    return ObligationOut(
        id=row.id,
        store_id=row.store_id,
        category=row.category.value,  # type: ignore[arg-type]
        description=row.description,
        amount=row.amount,
        due_date=row.due_date,
        status=row.status.value,  # type: ignore[arg-type]
        overdue=overdue,
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


@router.get("/admin/expenses")
def list_expenses(
    store_id: int,
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    category: str | None = None,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> list[ExpenseOut]:
    store = admin_store(db, actor, store_id)
    rows = service.list_expenses(db, store_id=store.id, date_from=date_from, date_to=date_to, category=category)
    return [_expense_out(r) for r in rows]


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
# ---------------------------------------------------------------------------


@router.get("/admin/obligations")
def list_obligations(
    store_id: int,
    status: str | None = None,
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> list[ObligationOut]:
    store = admin_store(db, actor, store_id)
    rows = service.list_obligations(db, store_id=store.id, status=status, date_from=date_from, date_to=date_to)
    return [_obligation_out(r) for r in rows]


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
        return 201, _obligation_out(row).model_dump(mode="json")

    _status_code, body = _idempotent(
        db, organization_id=actor.organization_id, scope="obligations.create", request=request, payload=payload, fn=_do
    )
    return ObligationOut.model_validate(body)


@router.post("/admin/obligations/{obligation_id}/settle")
def post_settle_obligation(
    obligation_id: int,
    payload: ObligationSettleIn,
    request: Request,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> ObligationOut:
    obligation = service.get_obligation_or_404(db, organization_id=actor.organization_id, obligation_id=obligation_id)
    admin_store(db, actor, obligation.store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        updated = service.settle_obligation(db, actor=actor, obligation=obligation, payload=payload)
        return 200, _obligation_out(updated).model_dump(mode="json")

    _status_code, body = _idempotent(
        db, organization_id=actor.organization_id, scope="obligations.settle", request=request, payload=payload, fn=_do
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
    obligation = service.get_obligation_or_404(db, organization_id=actor.organization_id, obligation_id=obligation_id)
    admin_store(db, actor, obligation.store_id)

    def _do() -> tuple[int, dict[str, Any]]:
        updated = service.cancel_obligation(db, actor=actor, obligation=obligation, reason=payload.reason)
        return 200, _obligation_out(updated).model_dump(mode="json")

    _status_code, body = _idempotent(
        db, organization_id=actor.organization_id, scope="obligations.cancel", request=request, payload=payload, fn=_do
    )
    return ObligationOut.model_validate(body)


# ---------------------------------------------------------------------------
# Configuración (costos fijos) — no está en el contrato mínimo, agregada
# porque `GET /admin/break-even` la necesita para publicar `fixed_costs` (ver
# entregable de este agente).
# ---------------------------------------------------------------------------


@router.get("/admin/expenses/settings")
def get_settings(
    store_id: int, actor: Actor = Depends(current_admin), db: Session = Depends(get_db)
) -> ExpensesSettingsOut:
    store = admin_store(db, actor, store_id)
    row = service.get_settings(db, store_id=store.id)
    if row is None:
        return ExpensesSettingsOut(store_id=store.id, fixed_costs=None, updated_at=None)
    return ExpensesSettingsOut.model_validate(row)


@router.patch("/admin/expenses/settings")
def patch_settings(
    payload: ExpensesSettingsIn,
    store_id: int,
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> ExpensesSettingsOut:
    store = admin_store(db, actor, store_id)
    row = service.update_settings(db, store=store, actor=actor, fixed_costs=payload.fixed_costs)
    return ExpensesSettingsOut.model_validate(row)


# ---------------------------------------------------------------------------
# Punto de equilibrio y utilidad del período.
# ---------------------------------------------------------------------------


@router.get("/admin/break-even")
def get_break_even(
    store_id: int,
    date_from: date = Query(..., alias="from"),
    date_to: date = Query(..., alias="to"),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> BreakEvenOut:
    store = admin_store(db, actor, store_id)
    result = service.compute_break_even(db, store=store, date_from=date_from, date_to=date_to)
    return BreakEvenOut(
        store_id=store.id,
        date_from=date_from,
        date_to=date_to,
        fixed_costs=result.fixed_costs,
        contribution_margin_pct_bp=result.contribution_margin_pct_bp,
        break_even_amount=result.break_even_amount,
        available=result.available,
        reason=result.reason,
    )


@router.get("/admin/profit")
def get_profit(
    store_id: int,
    date_from: date = Query(..., alias="from"),
    date_to: date = Query(..., alias="to"),
    actor: Actor = Depends(current_admin),
    db: Session = Depends(get_db),
) -> ProfitOut:
    store = admin_store(db, actor, store_id)
    result = service.compute_profit(db, store=store, date_from=date_from, date_to=date_to)
    return ProfitOut(
        store_id=store.id,
        date_from=date_from,
        date_to=date_to,
        net_sales=result.net_sales,
        cost=result.cost,
        expenses=result.expenses,
        obligations=result.obligations,
        payroll=result.payroll,
        payroll_reason=result.payroll_reason,
        profit=result.profit,
        available=result.available,
        reason=result.reason,
    )
