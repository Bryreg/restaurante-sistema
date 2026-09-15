"""Propinas del turno (`docs/SPEC-NEGOCIO.md §6.2`, Ley 1935 de 2018):
`GET /shifts/{id}/tips` y el registro (no el cálculo) del reparto,
`POST /admin/tips/payouts`.

Separado de `app.shifts.service` para no inflar ese archivo; el router llama
estas funciones directo.
"""

from __future__ import annotations

import importlib
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import AppError, NotFoundError
from app.core.modules import find_spec_safe
from app.shifts import hooks
from app.shifts.models import Shift, TipPayout, TipPayoutDistribution
from app.shifts.schemas import (
    EmployeeRef,
    SalesByMethodOut,
    ShiftTipsOut,
    TipPayoutDistributionIn,
    TipPayoutDistributionOut,
    TipPayoutOut,
    TipsByEmployeeOut,
)

_OTHER_METHODS = {"platform", "voucher", "other"}


def get_shift_tips(db: Session, *, shift: Shift) -> ShiftTipsOut:
    """`by_method`/`cash_out`/`electronic_liability` reutilizan
    `app.shifts.hooks.get_sales_totals` (mismo agrupamiento que ya usa
    `GET /shifts/{id}`); `by_employee` agrupa por `Payment.employee_id`
    (quien cobró — no hay un campo de "quien atendió" distinto en el modelo
    de pagos; decisión declarada en el entregable)."""

    totals = hooks.get_sales_totals(db, shift.id)
    by_method = SalesByMethodOut(
        cash=totals.tips_cash, card=totals.tips_card, transfer=totals.tips_transfer, other=totals.tips_other
    )
    cash_out = totals.tips_cash
    electronic_liability = totals.tips_card + totals.tips_transfer + totals.tips_other

    by_employee: list[TipsByEmployeeOut] = []
    if find_spec_safe("app.payments.models") is not None:
        payments_models = importlib.import_module("app.payments.models")
        Payment = payments_models.Payment
        rows = db.execute(
            select(Payment.employee_id, Payment.employee_name, Payment.method, Payment.tip_amount).where(
                Payment.shift_id == shift.id, Payment.voided_at.is_(None)
            )
        ).all()
        by_employee_map: dict[int, dict[str, Any]] = {}
        for employee_id, employee_name, method, tip_amount in rows:
            method_key = method.value if hasattr(method, "value") else str(method)
            bucket = "other" if method_key in _OTHER_METHODS else method_key
            if bucket not in ("cash", "card", "transfer", "other"):
                bucket = "other"
            entry = by_employee_map.setdefault(
                employee_id, {"employee_name": employee_name, "cash": 0, "card": 0, "transfer": 0, "other": 0}
            )
            entry[bucket] += int(tip_amount or 0)
        by_employee = [
            TipsByEmployeeOut(
                employee_id=eid,
                employee_name=data["employee_name"],
                cash=data["cash"],
                card=data["card"],
                transfer=data["transfer"],
                other=data["other"],
                total=data["cash"] + data["card"] + data["transfer"] + data["other"],
            )
            for eid, data in sorted(by_employee_map.items(), key=lambda kv: kv[1]["employee_name"])
        ]

    return ShiftTipsOut(
        by_method=by_method, by_employee=by_employee, cash_out=cash_out, electronic_liability=electronic_liability
    )


def register_tip_payout(
    db: Session,
    *,
    actor: Any,
    organization_id: int,
    store_id: int,
    shift_ids: list[int],
    distribution: list[TipPayoutDistributionIn],
    paid_at: datetime,
    method: str,
    now: datetime,
) -> TipPayout:
    """Registra el reparto (SPEC-NEGOCIO §6.2: el cálculo es manual en esta
    fase, nunca automático). No crea ningún `CashMovement`: si el dueño paga
    del cajón, ese egreso (causa `tip_payout`, ya existe en el enum desde
    1b-1) se registra aparte por `POST /shifts/{shift_id}/cash-movements`
    sobre el turno abierto que corresponda — este endpoint no recibe un
    turno "destino" del pago, sólo los turnos cuyas propinas se están
    repartiendo (`shift_ids`), que pueden ya estar cerrados."""

    from app.auth.models import Employee

    for shift_id in shift_ids:
        shift = db.get(Shift, shift_id)
        if shift is None or shift.organization_id != organization_id or shift.store_id != store_id:
            raise NotFoundError(f"El turno {shift_id} no existe en esta sede")

    total_amount = sum(d.amount for d in distribution)
    if total_amount <= 0:
        raise AppError(
            code="TIP_PAYOUT_EMPTY",
            message="El reparto tiene que repartir un monto mayor a cero",
            status=400,
        )

    # Validar TODOS los empleados antes de escribir nada (regla dura del
    # proyecto: `get_db` comitea también ante `AppError`, así que un
    # `employee_id` inválido a mitad de la lista no puede dejar un
    # `TipPayout` huérfano sin sus líneas).
    employees: dict[int, Employee] = {}
    for line in distribution:
        employee = db.get(Employee, line.employee_id)
        if employee is None or employee.organization_id != organization_id:
            raise NotFoundError(f"El empleado {line.employee_id} no existe en esta organización")
        employees[line.employee_id] = employee

    payout = TipPayout(
        organization_id=organization_id,
        store_id=store_id,
        shift_ids=list(shift_ids),
        paid_at=paid_at,
        method=method,
        total_amount=total_amount,
        created_by_employee_id=getattr(actor, "employee_id", None),
        created_by_employee_name=getattr(actor, "employee_name", None),
        created_at=now,
    )
    db.add(payout)
    db.flush()

    for line in distribution:
        employee = employees[line.employee_id]
        db.add(
            TipPayoutDistribution(
                payout_id=payout.id,
                employee_id=employee.id,
                employee_name=employee.name,
                amount=line.amount,
            )
        )
    db.flush()
    return payout


def tip_payout_out(db: Session, *, payout: TipPayout) -> TipPayoutOut:
    rows = list(
        db.execute(select(TipPayoutDistribution).where(TipPayoutDistribution.payout_id == payout.id)).scalars()
    )
    return TipPayoutOut(
        id=payout.id,
        shift_ids=list(payout.shift_ids),
        paid_at=payout.paid_at,
        method=payout.method,
        total_amount=payout.total_amount,
        created_by=EmployeeRef(id=payout.created_by_employee_id, name=payout.created_by_employee_name),
        created_at=payout.created_at,
        distribution=[
            TipPayoutDistributionOut(employee_id=r.employee_id, employee_name=r.employee_name, amount=r.amount)
            for r in rows
        ],
    )
