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
from app.shifts.models import Shift, TipPayout, TipPayoutDistribution, TipPayoutSource
from app.shifts.schemas import (
    EmployeeRef,
    SalesByMethodOut,
    ShiftTipsOut,
    TipPayoutDistributionIn,
    TipPayoutDistributionOut,
    TipPayoutOut,
    TipsByEmployeeOut,
)

def get_shift_tips(db: Session, *, shift: Shift) -> ShiftTipsOut:
    """`by_method`/`cash_out`/`electronic_liability` reutilizan
    `app.shifts.hooks.get_sales_totals` (mismo agrupamiento que ya usa
    `GET /shifts/{id}`); `by_employee` agrupa por `Payment.employee_id`
    (quien cobró — no hay un campo de "quien atendió" distinto en el modelo
    de pagos; decisión declarada en el entregable).

    **Ronda 2 del pedido 2c, cierre de H-2.** Este cuerpo respondía la misma
    pregunta con dos fórmulas: `by_method`/`cash_out` salían de
    `get_sales_totals`, que desde 2c saca la propina en efectivo de un
    domicilio de `.tips_cash`, y `by_employee` la reclasificaba a mano acá
    sin esa exclusión. Con $10.000 de propina de mostrador y $10.000 de
    domicilio, el mismo JSON decía `by_method.cash = 10.000` y
    `sum(by_employee[*].cash) = 20.000`: el reparto por persona ofrecía
    plata que `cash_out` no autoriza a sacar del cajón, y es propina de un
    empleado (Ley 1935 de 2018). Ahora hay **una sola función que clasifica
    un `Payment` en su bolsillo**, `hooks.payment_bucket`, y los dos lados
    la llaman. Vale billete por billete:

        by_method.cash == cash_out == sum(e.cash for e in by_employee)

    y lo mismo para `card`, `transfer` y `other`.

    Para que la propina de domicilio no DESAPAREZCA de la pantalla al dejar
    de contarse en `.cash`, se publica en su propio renglón, aditivo:
    `TipsByEmployeeOut.delivery` por persona y `delivery_tips` /
    `delivery_tips_pending` / `delivery_tips_settled` en el cuerpo.

    **Ronda 3 del pedido 2c, cierre de H-8.** Antes `cash_out` era
    exactamente `totals.tips_cash`, y este docstring prometía que la propina
    de domicilio «no se puede pagar del cajón hasta que entre». La segunda
    mitad de esa frase no estaba escrita en ninguna parte: una vez que
    entraba, tampoco se podía pagar — `cash_out` nunca la miraba—. La plata
    quedaba físicamente en el cajón (el domiciliario entrega venta +
    propina, `DeliverySettlement.tip_amount`) y ninguna lectura autorizaba
    sacarla, así que `to_deposit` (`app/shifts/service.py:1035`) la mandaba
    a consignar como si fuera venta: propina de una persona consignada al
    banco (Ley 1935 de 2018). **Ahora `cash_out` suma la propina de
    domicilio YA LIQUIDADA**:

        cash_out == by_method.cash + delivery_tips_settled

    Lo que NO cambia, y es deliberado: `by_method.cash` sigue siendo sólo la
    propina en efectivo de mostrador, y por lo tanto sigue valiendo
    `by_method.cash == sum(by_employee[*].cash)` — el invariante de H-2.
    Meter la propina de domicilio en `.cash` reabriría H-2: `by_method` y
    `by_employee` volverían a responder distinto. Son dos preguntas
    distintas: `by_method` dice **por qué medio entró**; `cash_out`, **cuánto
    se puede sacar hoy del cajón**."""

    totals = hooks.get_sales_totals(db, shift.id)
    by_method = SalesByMethodOut(
        cash=totals.tips_cash, card=totals.tips_card, transfer=totals.tips_transfer, other=totals.tips_other
    )
    # Una sola vez, y del lado del servidor: el cliente no resta nada.
    delivery_tips_settled = totals.tips_delivery - totals.tips_delivery_pending
    cash_out = totals.tips_cash + delivery_tips_settled
    electronic_liability = totals.tips_card + totals.tips_transfer + totals.tips_other

    by_employee: list[TipsByEmployeeOut] = []
    if find_spec_safe("app.payments.models") is not None:
        payments_models = importlib.import_module("app.payments.models")
        Payment = payments_models.Payment
        courier_col = getattr(Payment, "delivery_courier_employee_id", None)
        columns = [Payment.employee_id, Payment.employee_name, Payment.method, Payment.tip_amount]
        if courier_col is not None:
            columns.append(courier_col)
        rows = db.execute(
            select(*columns).where(Payment.shift_id == shift.id, Payment.voided_at.is_(None))
        ).all()
        by_employee_map: dict[int, dict[str, Any]] = {}
        for row in rows:
            employee_id, employee_name, method, tip_amount = row[0], row[1], row[2], row[3]
            courier_id = row[4] if len(row) > 4 else None
            # LA MISMA función que usa `get_sales_totals`. Si esta línea
            # vuelve a clasificar a mano, H-2 vuelve.
            bucket = hooks.payment_bucket(method, courier_id)
            entry = by_employee_map.setdefault(
                employee_id,
                {"employee_name": employee_name, "cash": 0, "card": 0, "transfer": 0, "other": 0, "delivery": 0},
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
                delivery=data["delivery"],
                total=data["cash"] + data["card"] + data["transfer"] + data["other"] + data["delivery"],
            )
            for eid, data in sorted(by_employee_map.items(), key=lambda kv: kv[1]["employee_name"])
        ]

    return ShiftTipsOut(
        by_method=by_method,
        by_employee=by_employee,
        cash_out=cash_out,
        electronic_liability=electronic_liability,
        total_liability=cash_out + electronic_liability,
        delivery_tips=totals.tips_delivery,
        delivery_tips_pending=totals.tips_delivery_pending,
        delivery_tips_settled=delivery_tips_settled,
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
    paid_from: str = "owner_hand",
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
        paid_from=TipPayoutSource(paid_from),
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
        paid_from=payout.paid_from.value,  # type: ignore[arg-type]
        total_amount=payout.total_amount,
        created_by=EmployeeRef(id=payout.created_by_employee_id, name=payout.created_by_employee_name),
        created_at=payout.created_at,
        distribution=[
            TipPayoutDistributionOut(employee_id=r.employee_id, employee_name=r.employee_name, amount=r.amount)
            for r in rows
        ],
    )
