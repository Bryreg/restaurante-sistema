"""Propinas del turno (`docs/SPEC-NEGOCIO.md §6.2`, Ley 1935 de 2018):
`GET /shifts/{id}/tips` y el registro (no el cálculo) del reparto,
`POST /admin/tips/payouts`.

**c3 — probar el 100 % entregado.** Además: el historial de repartos
(`GET /admin/tips/payouts`), su reversa con motivo
(`POST /admin/tips/payouts/{id}/reverse`), el balance recogido / entregado /
pendiente por período (`GET /admin/tips/balance`) y la validación de que un
reparto no entregue más de lo que queda pendiente en sus turnos. La única
cuenta de «cuánto se le entregó a cada turno» es `allocate_payouts`.

Separado de `app.shifts.service` para no inflar ese archivo; el router llama
estas funciones directo.
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import money, tz
from app.core.errors import AppError, NotFoundError
from app.core.modules import find_spec_safe
from app.shifts import hooks
from app.shifts.models import BusinessDay, Shift, ShiftStatus, TipPayout, TipPayoutDistribution, TipPayoutSource
from app.shifts.schemas import (
    EmployeeRef,
    SalesByMethodOut,
    ShiftTipBalanceOut,
    ShiftTipsOut,
    TipsBalanceOut,
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

    # Un turno repetido en la lista no reparte su propina dos veces.
    shift_ids = sorted(set(shift_ids))
    # Bloqueo de los turnos (no-op en SQLite): dos repartos concurrentes sobre
    # el mismo turno no pueden validar los dos contra el mismo pendiente.
    locked = {
        s.id: s for s in db.execute(select(Shift).where(Shift.id.in_(shift_ids)).with_for_update()).scalars()
    }
    for shift_id in shift_ids:
        shift = locked.get(shift_id)
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

    # c3: nada impedía pagar dos veces el mismo turno ni entregar más de lo
    # recogido. El reparto no puede pasar lo que todavía queda pendiente en
    # sus turnos, con la misma cuenta que publica `GET /admin/tips/balance`.
    balances = allocate_payouts(db, organization_id=organization_id, store_id=store_id, shift_ids=shift_ids)
    pending = sum(balances[sid].pending for sid in shift_ids)
    if total_amount > pending:
        raise AppError(
            code="TIP_PAYOUT_EXCEEDS_PENDING",
            message=(
                f"El reparto entrega {money.format_cop(total_amount)} y en esos turnos sólo quedan "
                f"{money.format_cop(pending)} de propina por entregar. Revisá el historial de repartos: "
                "si uno quedó mal, reversalo con su motivo y volvé a registrar este."
            ),
            status=400,
        )

    payout = TipPayout(
        organization_id=organization_id,
        store_id=store_id,
        shift_ids=list(shift_ids),
        # `<input type="datetime-local">` manda la hora sin zona: la pone el servidor.
        paid_at=tz.from_bogota_wall_clock(paid_at),
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
        reversed_at=payout.reversed_at,
        reversed_reason=payout.reversed_reason,
        reversed_by=(
            EmployeeRef(id=payout.reversed_by_employee_id, name=payout.reversed_by_employee_name or "")
            if payout.reversed_by_employee_id is not None
            else None
        ),
    )


# ---------------------------------------------------------------------------
# c3 — recogido vs. entregado vs. pendiente (Ley 1935 de 2018).
# ---------------------------------------------------------------------------


def shift_tip_collected(db: Session, *, shift: Shift) -> int:
    """La propina que generó un turno: todos los medios más la de domicilio
    (liquidada o no). Es la misma suma que reparte la propuesta
    (`app.payroll.service._shift_tip_total`), leída de `get_shift_tips`."""
    tips = get_shift_tips(db, shift=shift)
    return tips.by_method.cash + tips.by_method.card + tips.by_method.transfer + tips.by_method.other + tips.delivery_tips


@dataclass
class ShiftTipBalance:
    collected: int
    paid: int = 0

    @property
    def pending(self) -> int:
        return max(self.collected - self.paid, 0)

    @property
    def overpaid(self) -> int:
        return max(self.paid - self.collected, 0)


def _live_payouts(db: Session, *, organization_id: int, store_id: int) -> list[TipPayout]:
    return list(
        db.execute(
            select(TipPayout)
            .where(
                TipPayout.organization_id == organization_id,
                TipPayout.store_id == store_id,
                TipPayout.reversed_at.is_(None),
            )
            .order_by(TipPayout.created_at, TipPayout.id)
        ).scalars()
    )


def allocate_payouts(
    db: Session, *, organization_id: int, store_id: int, shift_ids: list[int] | set[int]
) -> dict[int, ShiftTipBalance]:
    """**La única cuenta de cuánto se le entregó a cada turno.**

    Un reparto (`TipPayout`) cubre una LISTA de turnos con un solo total; no
    guarda cuánto le tocó a cada uno. La imputación se deriva, siempre igual:
    los repartos vivos en orden de registro (`created_at`, `id`), y cada uno
    llena sus turnos del más viejo (`id`) al más nuevo, hasta lo pendiente
    de cada uno. Lo que no cabe (sólo en repartos anteriores a la validación
    de c3) se imputa al último turno del reparto y se publica como
    `overpaid`, nunca se esconde.

    Para no recorrer la historia entera de la sede, se cierra el conjunto de
    turnos sobre los repartos que los tocan: un reparto que comparte un turno
    con los pedidos trae a sus otros turnos, porque su imputación depende de
    ellos. Los repartos fuera de ese cierre no tocan ningún turno del
    conjunto y no cambian nada.

    Un reparto reversado no cuenta: su plata vuelve a quedar pendiente."""
    payouts = _live_payouts(db, organization_id=organization_id, store_id=store_id)
    closure: set[int] = set(shift_ids)
    relevant: list[TipPayout] = []
    changed = True
    while changed:
        changed = False
        relevant = [p for p in payouts if closure.intersection(int(x) for x in p.shift_ids)]
        for p in relevant:
            for x in p.shift_ids:
                if int(x) not in closure:
                    closure.add(int(x))
                    changed = True

    balances: dict[int, ShiftTipBalance] = {}
    for shift_id in closure:
        shift = db.get(Shift, shift_id)
        if shift is None or shift.organization_id != organization_id or shift.store_id != store_id:
            balances[shift_id] = ShiftTipBalance(collected=0)
            continue
        balances[shift_id] = ShiftTipBalance(collected=shift_tip_collected(db, shift=shift))

    for p in relevant:
        ids = sorted({int(x) for x in p.shift_ids})
        if not ids:
            continue
        remaining = p.total_amount
        for sid in ids:
            take = min(remaining, balances[sid].pending)
            balances[sid].paid += take
            remaining -= take
        if remaining > 0:
            balances[ids[-1]].paid += remaining
    return balances


def tips_balance(db: Session, *, store: Any, date_from: date, date_to: date) -> TipsBalanceOut:
    """Recogido vs. entregado vs. pendiente de los turnos **cerrados** del
    período (fecha de negocio), los mismos que usa la propuesta de reparto
    (`app.payroll.service.resolve_period_shift_ids`, misma consulta).

    `paid` es lo que los repartos le imputan a los turnos DEL PERÍODO, no lo
    que se entregó en esas fechas: la pregunta es «¿la propina de estos días
    ya llegó a quien la generó?»."""
    rows = db.execute(
        select(Shift.id, BusinessDay.business_date)
        .join(BusinessDay, BusinessDay.id == Shift.business_day_id)
        .where(
            Shift.organization_id == store.organization_id,
            Shift.store_id == store.id,
            Shift.status == ShiftStatus.CLOSED,
            BusinessDay.business_date >= date_from,
            BusinessDay.business_date <= date_to,
        )
        .order_by(BusinessDay.business_date, Shift.id)
    ).all()
    balances = allocate_payouts(
        db, organization_id=store.organization_id, store_id=store.id, shift_ids=[r[0] for r in rows]
    )
    shifts = [
        ShiftTipBalanceOut(
            shift_id=shift_id,
            business_date=business_date,
            collected=balances[shift_id].collected,
            paid=balances[shift_id].paid,
            pending=balances[shift_id].pending,
            overpaid=balances[shift_id].overpaid,
        )
        for shift_id, business_date in rows
    ]
    pending = sum(s.pending for s in shifts)
    return TipsBalanceOut(
        date_from=date_from,
        date_to=date_to,
        collected=sum(s.collected for s in shifts),
        paid=sum(s.paid for s in shifts),
        pending=pending,
        overpaid=sum(s.overpaid for s in shifts),
        fully_delivered=(pending == 0) if shifts else None,
        shifts=shifts,
    )


def list_tip_payouts(
    db: Session,
    *,
    store: Any,
    date_from: date | None,
    date_to: date | None,
    status: str = "all",
    employee_id: int | None = None,
    shift_id: int | None = None,
    method: str | None = None,
) -> list[TipPayout]:
    """El historial de repartos de la sede, del más nuevo al más viejo. El
    período se lee sobre la fecha de negocio de la ENTREGA (`paid_at`), con
    la hora de corte de la sede — nunca la fecha UTC."""
    stmt = select(TipPayout).where(TipPayout.organization_id == store.organization_id, TipPayout.store_id == store.id)
    if status == "live":
        stmt = stmt.where(TipPayout.reversed_at.is_(None))
    elif status == "reversed":
        stmt = stmt.where(TipPayout.reversed_at.is_not(None))
    if method is not None:
        stmt = stmt.where(TipPayout.method == method)
    if employee_id is not None:
        stmt = stmt.where(
            TipPayout.id.in_(
                select(TipPayoutDistribution.payout_id).where(TipPayoutDistribution.employee_id == employee_id)
            )
        )
    stmt = stmt.order_by(TipPayout.paid_at.desc(), TipPayout.id.desc())
    result: list[TipPayout] = []
    for payout in db.execute(stmt).scalars():
        business_date = tz.business_date_for(payout.paid_at, store.cutoff_hour)
        if date_from is not None and business_date < date_from:
            continue
        if date_to is not None and business_date > date_to:
            continue
        if shift_id is not None and shift_id not in {int(x) for x in payout.shift_ids}:
            continue
        result.append(payout)
    return result


def reverse_tip_payout(
    db: Session, *, actor: Any, organization_id: int, store_id: int, payout_id: int, reason: str, now: datetime
) -> TipPayout:
    """Reversa con motivo: la fila y sus líneas quedan (nada se borra), y el
    reparto deja de contar como entregado y como gastado de la mano del
    dueño. Si el reparto se pagó del cajón, el egreso de caja que lo
    acompañó se reversa aparte, por su propia puerta — este libro nunca
    movió plata."""
    from app.audit.service import record_audit

    payout = db.get(TipPayout, payout_id)
    if payout is None or payout.organization_id != organization_id or payout.store_id != store_id:
        raise NotFoundError("El reparto de propinas no existe en esta sede")
    if payout.reversed_at is not None:
        raise AppError(
            code="TIP_PAYOUT_ALREADY_REVERSED",
            message="Este reparto ya está reversado; si hace falta, registrá uno nuevo",
            status=400,
        )
    clean_reason = reason.strip()
    if len(clean_reason) < 3:
        raise AppError(code="REASON_REQUIRED", message="Escribí por qué se reversa el reparto", status=400)
    payout.reversed_at = now
    payout.reversed_reason = clean_reason
    payout.reversed_by_employee_id = getattr(actor, "employee_id", None)
    payout.reversed_by_employee_name = getattr(actor, "employee_name", None)
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=organization_id,
        store_id=payout.store_id,
        entity="tip_payout",
        entity_id=payout.id,
        action="reverse",
        before={"total_amount": payout.total_amount, "status": "live"},
        after={"status": "reversed"},
        reason=clean_reason,
    )
    return payout
