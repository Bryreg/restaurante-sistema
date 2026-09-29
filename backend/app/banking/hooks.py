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

from dataclasses import dataclass, field
from datetime import date, datetime

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


@dataclass(frozen=True)
class CascadeLink:
    """Una línea de procedencia de la cascada: qué turno y cuánto."""

    shift_id: int
    business_date: date
    amount: int


@dataclass
class ShiftBalance:
    """El saldo por consignar de UN turno cerrado con conteo, **después de la
    cascada** (decisión del dueño, 2026-09-29, «como el café»).

    - `to_deposit`: el snapshot de cierre, leído tal cual (nunca se recalcula).
    - `deposited`: `Σ` de las imputaciones vivas.
    - `raw`: `to_deposit − deposited`. Puede ser negativo: el turno pagó del
      cajón (proveedores, gastos, retiros) más plata de la que entró.
    - `outstanding`: lo que de verdad falta consignar, `≥ 0`, ya descontado lo
      que este turno le tapó a uno más nuevo.
    - `covered` (cubrió): a qué turnos MÁS NUEVOS les tapó el hueco, y cuánto.
    - `covered_by` (cubierto por): qué turnos ANTERIORES le taparon el suyo.
    - `uncovered_shortfall` (faltante sin cubrir): el resto del hueco cuando ya
      no quedaba saldo anterior; no se inventa de dónde salió.
    """

    shift_id: int
    business_date: date
    closed_at: datetime | None
    to_deposit: int
    deposited: int
    raw: int
    outstanding: int
    covered: list[CascadeLink] = field(default_factory=list)
    covered_by: list[CascadeLink] = field(default_factory=list)
    uncovered_shortfall: int = 0

    @property
    def covered_total(self) -> int:
        return sum(link.amount for link in self.covered)


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


def _allocated_live_by_shift(db: Session, *, store_id: int) -> dict[int, int]:
    """Las imputaciones vivas de TODOS los turnos de la sede, en una consulta
    (la cascada recorre la historia completa de la sede)."""
    rows = db.execute(
        select(BankDepositAllocation.shift_id, func.coalesce(func.sum(BankDepositAllocation.amount), 0))
        .join(BankDeposit, BankDeposit.id == BankDepositAllocation.deposit_id)
        .join(Shift, Shift.id == BankDepositAllocation.shift_id)
        .where(Shift.store_id == store_id, BankDeposit.status == BankDepositStatus.LIVE)
        .group_by(BankDepositAllocation.shift_id)
    ).all()
    return {int(shift_id): int(total) for shift_id, total in rows}


def apply_cascade(balances: list[ShiftBalance]) -> None:
    """**La cascada** (decisión del dueño, 2026-09-29, a imagen de
    `consignaciones._aplicar_cascada` del café). Muta la lista in-place.

    Cuando un turno pagó del cajón —a proveedores, gastos, retiros— más plata
    de la que entró, su `raw` queda negativo: esa plata no salió del aire,
    salió de la venta de un turno anterior que seguía en el cajón sin
    consignar. El hueco se cobra del **anterior más reciente** con saldo, y
    sólo si no alcanza se sigue hacia los más viejos (el café lo corrigió con
    la semana en la mano: la plata del cajón un lunes es la del domingo, no la
    del sábado que ya está separada). Cada peso que sale de un turno entra en
    otro: `covered` y `covered_by` son espejo. Lo que no encuentra de dónde
    cobrarse queda en `uncovered_shortfall`, visible, nunca inventado.

    La lista viene en orden de cierre ascendente. Las consignaciones ya están
    restadas (`raw = to_deposit − deposited`), igual que en el café; los
    retiros del dueño (`CashPickup`) ya salieron del conteo del turno y por
    eso ya están adentro de `to_deposit`.
    """
    for i, current in enumerate(balances):
        if current.outstanding >= 0:
            continue
        deficit = -current.outstanding
        current.outstanding = 0
        for j in range(i - 1, -1, -1):
            if deficit <= 0:
                break
            older = balances[j]
            take = min(older.outstanding, deficit)
            if take <= 0:
                continue
            older.outstanding -= take
            deficit -= take
            older.covered.append(CascadeLink(current.shift_id, current.business_date, take))
            current.covered_by.append(CascadeLink(older.shift_id, older.business_date, take))
        current.uncovered_shortfall = deficit


def store_balances(db: Session, *, organization_id: int, store_id: int) -> list[ShiftBalance]:
    """**La única cuenta del saldo por consignar** de la sede, turno por turno,
    con la cascada aplicada. La leen la lista de pendientes del banco, Hoy, la
    apertura del cajón (qué días debería haber), la plata del cajón y la
    validación de las consignaciones: una sola respuesta a «¿cuánto falta
    consignar de este turno?».

    Recorre la historia completa de la sede, en orden de cierre (`closed_at`,
    `id` como desempate: la cascada cobra al anterior, y el orden no puede
    depender del motor). Un turno cerrado **sin conteo** no entra: su
    `to_deposit` sale del libro, no de un arqueo (`SHIFT_CLOSED_WITHOUT_COUNT`),
    así que ni tapa ni lo tapan."""
    rows = db.execute(
        select(Shift, BusinessDay.business_date)
        .join(BusinessDay, BusinessDay.id == Shift.business_day_id)
        .where(
            Shift.organization_id == organization_id,
            Shift.store_id == store_id,
            Shift.status == ShiftStatus.CLOSED,
            Shift.closed_without_count.is_(False),
            Shift.to_deposit.is_not(None),
        )
        .order_by(Shift.closed_at, Shift.id)
    ).all()
    allocated = _allocated_live_by_shift(db, store_id=store_id)
    balances: list[ShiftBalance] = []
    for shift, business_date in rows:
        to_deposit = int(shift.to_deposit or 0)
        deposited = allocated.get(shift.id, 0)
        raw = to_deposit - deposited
        balances.append(
            ShiftBalance(
                shift_id=shift.id,
                business_date=business_date,
                closed_at=shift.closed_at,
                to_deposit=to_deposit,
                deposited=deposited,
                raw=raw,
                outstanding=raw,
            )
        )
    apply_cascade(balances)
    return balances


def balances_by_shift(db: Session, *, organization_id: int, store_id: int) -> dict[int, ShiftBalance]:
    return {b.shift_id: b for b in store_balances(db, organization_id=organization_id, store_id=store_id)}


def outstanding_of(db: Session, shift: Shift) -> int | None:
    """Lo que falta consignar de un turno cerrado **con conteo**, después de
    la cascada; `None` si no tiene un saldo verificable (cerró sin conteo, o
    no está cerrado)."""
    if shift.status != ShiftStatus.CLOSED or shift.closed_without_count or shift.to_deposit is None:
        return None
    balance = balances_by_shift(db, organization_id=shift.organization_id, store_id=shift.store_id).get(shift.id)
    return balance.outstanding if balance is not None else None


def pending_shifts(db: Session, *, organization_id: int, store_id: int) -> list[PendingShift]:
    """Los turnos cerrados con conteo que todavía tienen saldo por consignar
    (después de la cascada), del más viejo al más nuevo: los días que quien
    abre encuentra en el cajón."""
    balances = [
        b for b in store_balances(db, organization_id=organization_id, store_id=store_id) if b.outstanding > 0
    ]
    balances.sort(key=lambda b: (b.business_date, b.shift_id))
    return [PendingShift(shift_id=b.shift_id, business_date=b.business_date, outstanding=b.outstanding) for b in balances]


def drawer_deposits(db: Session, shift_id: int, *, as_of: datetime | None = None) -> int:
    """`Σ` de lo que se consignó **desde el cajón** de este turno (desde el
    POS) y sigue vivo: esa plata ya no está en el cajón. Una consignación
    rechazada (reversada) deja de restar: el monto vuelve al cajón. Con
    `as_of`, sólo lo consignado hasta ese instante (el esperado por hora)."""
    stmt = select(func.coalesce(func.sum(BankDeposit.amount), 0)).where(
        BankDeposit.from_shift_id == shift_id, BankDeposit.status == BankDepositStatus.LIVE
    )
    if as_of is not None:
        stmt = stmt.where(BankDeposit.deposited_at <= as_of)
    return int(db.execute(stmt).scalar_one())


def drawer_deposit_rows(db: Session, shift_id: int) -> list[dict[str, object]]:
    """Las consignaciones vivas hechas **desde el cajón** de este turno, una
    por una: «Movimientos de caja» de Cuadres (2026-09-29) las pinta como
    salidas del cajón, con banco, foto y nota. La suma es `drawer_deposits`."""
    rows = db.execute(
        select(BankDeposit)
        .where(BankDeposit.from_shift_id == shift_id, BankDeposit.status == BankDepositStatus.LIVE)
        .order_by(BankDeposit.deposited_at, BankDeposit.id)
    ).scalars()
    return [
        {
            "id": d.id,
            "at": d.deposited_at,
            "amount": d.amount,
            "bank_name": d.bank_name,
            "photo": d.receipt_photo,
            "note": d.note,
            "employee_name": d.employee_name,
        }
        for d in rows
    ]


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
