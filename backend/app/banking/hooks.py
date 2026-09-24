"""Contratos publicados de `banking` hacia otros dominios.

**Actualizado (2026-09-24):** `app.shifts.service` lee de acá los saldos por
consignar y lo consignado desde el cajón (ver abajo), y `app.reports` las
consignaciones por confirmar. Lo que sigue es la historia de cuando no lo
leía nadie.

Ningún dominio de esta fase necesitaba leer `banking` (T2 arrastra las cuentas
por pagar al resultado del período leyendo `app.reports`/`app.purchases`,
nunca el banco; T3 y T4 tampoco lo tocan — ver
`features/fase-3-dinero-control/spec.md § 2`). Este archivo existe vacío a
propósito, para que la anatomía del dominio (`docs/CONTEXTO-AGENTES.md §3`:
`hooks.py` es el único import cruzado permitido) esté completa desde el
día uno: si un futuro pedido necesita leer algo de `banking` (por ejemplo,
si el punto de equilibrio de una fase posterior quisiera incorporar el neto
del datáfono), esto es lo único que otro dominio puede importar de acá —
nunca `app.banking.service` directo.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.banking.models import BankDeposit, BankDepositAllocation, BankDepositStatus
from app.shifts.models import BusinessDay, Shift, ShiftStatus

# ---------------------------------------------------------------------------
# La plata de días anteriores en el cajón (2026-09-24).
#
# `app.shifts.service` necesita dos cosas del banco para abrir y cerrar un
# turno con esa plata adentro: qué turnos tienen saldo por consignar (para
# que quien abre marque cuáles están en el cajón) y cuánto se consignó desde
# el cajón durante el turno (sale del esperado). Las dos se leen acá, con la
# misma regla de «imputación viva» que usa `app.banking.service`.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PendingShift:
    shift_id: int
    business_date: date
    outstanding: int


def allocated_live(db: Session, shift_id: int) -> int:
    """`Σ` de las imputaciones vivas de un turno (su consignación no está
    reversada). La misma cuenta que `app.banking.service._allocated_live_for_shift`."""
    total = db.execute(
        select(func.coalesce(func.sum(BankDepositAllocation.amount), 0))
        .select_from(BankDepositAllocation)
        .join(BankDeposit, BankDeposit.id == BankDepositAllocation.deposit_id)
        .where(BankDepositAllocation.shift_id == shift_id, BankDeposit.status == BankDepositStatus.LIVE)
    ).scalar_one()
    return int(total)


def outstanding_of(db: Session, shift: Shift) -> int | None:
    """Lo que falta consignar de un turno cerrado **con conteo**; `None` si
    no tiene un saldo verificable (cerró sin conteo, o no está cerrado)."""
    if shift.status != ShiftStatus.CLOSED or shift.closed_without_count or shift.to_deposit is None:
        return None
    return shift.to_deposit - allocated_live(db, shift.id)


def pending_shifts(db: Session, *, organization_id: int, store_id: int) -> list[PendingShift]:
    """Los turnos cerrados con conteo que todavía tienen saldo por consignar,
    del más viejo al más nuevo: los que quien abre puede marcar como
    presentes en el cajón."""
    rows = db.execute(
        select(Shift, BusinessDay.business_date)
        .join(BusinessDay, BusinessDay.id == Shift.business_day_id)
        .where(
            Shift.organization_id == organization_id,
            Shift.store_id == store_id,
            Shift.status == ShiftStatus.CLOSED,
            Shift.closed_without_count.is_(False),
            Shift.to_deposit.is_not(None),
            Shift.to_deposit > 0,
        )
        .order_by(BusinessDay.business_date, Shift.id)
    ).all()
    out: list[PendingShift] = []
    for shift, business_date in rows:
        outstanding = outstanding_of(db, shift)
        if outstanding is not None and outstanding > 0:
            out.append(PendingShift(shift_id=shift.id, business_date=business_date, outstanding=outstanding))
    return out


def drawer_deposits(db: Session, shift_id: int) -> int:
    """`Σ` de lo que se consignó **desde el cajón** de este turno (desde el
    POS) y sigue vivo: esa plata ya no está en el cajón. Una consignación
    rechazada (reversada) deja de restar: el monto vuelve al cajón."""
    total = db.execute(
        select(func.coalesce(func.sum(BankDeposit.amount), 0)).where(
            BankDeposit.from_shift_id == shift_id, BankDeposit.status == BankDepositStatus.LIVE
        )
    ).scalar_one()
    return int(total)


def drawer_deposits_to(db: Session, *, shift_id: int, source_shift_id: int) -> int:
    """Lo consignado desde el cajón de `shift_id` e imputado a `source_shift_id`."""
    total = db.execute(
        select(func.coalesce(func.sum(BankDepositAllocation.amount), 0))
        .select_from(BankDepositAllocation)
        .join(BankDeposit, BankDeposit.id == BankDepositAllocation.deposit_id)
        .where(
            BankDeposit.from_shift_id == shift_id,
            BankDeposit.status == BankDepositStatus.LIVE,
            BankDepositAllocation.shift_id == source_shift_id,
        )
    ).scalar_one()
    return int(total)


def unconfirmed_count(db: Session, *, store_id: int) -> int:
    """Consignaciones hechas desde el POS que el administrador todavía no
    confirmó ni rechazó."""
    return int(
        db.execute(
            select(func.count(BankDeposit.id)).where(
                BankDeposit.store_id == store_id,
                BankDeposit.status == BankDepositStatus.LIVE,
                BankDeposit.confirmed_at.is_(None),
            )
        ).scalar_one()
    )
