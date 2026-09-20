"""Toda la lógica y la matemática de `banking` (`docs/CONTEXTO-AGENTES.md §3`:
`service.py` es dueño de la matemática, `router.py` sólo del borde HTTP).

**Regla de oro de este archivo**: `Shift.to_deposit` se LEE, nunca se
recalcula (lo escribe `app.shifts.service._finalize_close`, es un snapshot
de cierre). Lo único que este módulo deriva —y nunca guarda— es la porción
de esos `to_deposit` que todavía no se imputó a una consignación viva: el
**saldo por consignar**.

**La llave anti doble conteo** (retiro vs consignación) vive en
`create_deposit`: antes de escribir una sola fila, valida que ninguna
imputación nueva haga que `Σ imputaciones vivas de un turno` supere
`Shift.to_deposit`, con el turno bloqueado (`SELECT ... FOR UPDATE`, mismo
patrón que `app.fiscal` usa para el consecutivo) para que dos consignaciones
concurrentes no imputen el mismo peso dos veces.

Todo servicio de este módulo **valida antes de escribir**
(`app.core.db.get_db` comitea también ante un `AppError`, así que lo que ya
se alcanzó a `db.add()` sobrevive a un error de negocio a mitad de camino —
`docs/CONTEXTO-AGENTES.md`, patrón que ya usan `purchases.create_payment` y
`purchases.create_reception`).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.auth.deps import Actor
from app.banking.models import (
    BankDeposit,
    BankDepositAllocation,
    BankDepositStatus,
    CardSettlement,
    PlatformSettlement,
    SettlementStatus,
)
from app.banking.schemas import (
    CardSettlementIn,
    DepositAllocationIn,
    DepositIn,
    PlatformSettlementIn,
)
from app.channels.models import DeliveryPlatform, PlatformReceivable, PlatformReceivableStatus
from app.core import clock, tz
from app.core.errors import AppError, NotFoundError
from app.payments.models import Payment
from app.refunds.models import PendingRefund, PendingRefundStatus, SettleFrom
from app.shifts.hooks import methods_in_bucket
from app.shifts.models import BusinessDay, CashPickup, Shift, ShiftStatus, TipPayout, TipPayoutSource
from app.stores.models import Store

# C6/H-5 (iteración 2, advertencia): `payment_bucket` (`app.shifts.hooks`)
# es el único lugar del sistema autorizado a decidir en qué bolsillo cae un
# medio de pago — su propio docstring documenta el bug que produjo
# clasificarlo dos veces (H-2/H-4 de 2b). Antes este módulo escribía
# `Payment.method == "card"` / `== "transfer"` a mano en dos lugares
# (conciliación de tarjeta y libro del banco), una segunda clasificación
# que se desincroniza en silencio el día que se agregue un medio nuevo.
# Estos dos conjuntos se derivan UNA vez, recorriendo el mismo catálogo que
# usa `Payment` (`PAYMENT_METHOD_VALUES`) y preguntándole a `payment_bucket`
# cuáles caen en cada bolsillo — así, si mañana se agrega un medio, lo
# clasifica la única autoridad y este módulo no lo omite en silencio.
# R-3 del cierre: la derivación se mudó a `app.shifts.hooks.methods_in_bucket`,
# al lado de la autoridad. Este módulo ya no escribe el nombre de ningún medio
# de pago — ni para compararlo contra la salida de `payment_bucket`—, así que
# el invariante que barre literales fuera de `app/shifts/` deja de tener que
# distinguir "comparo la salida de la autoridad" de "clasifico por mi cuenta".
CARD_PAYMENT_METHODS = methods_in_bucket("card")
TRANSFER_PAYMENT_METHODS = methods_in_bucket("transfer")

# ---------------------------------------------------------------------------
# Consignaciones.
# ---------------------------------------------------------------------------


def get_deposit_or_404(db: Session, *, organization_id: int, deposit_id: int) -> BankDeposit:
    row = db.get(BankDeposit, deposit_id)
    if row is None or row.organization_id != organization_id:
        raise NotFoundError("La consignación no existe en esta organización")
    return row


def get_allocations(db: Session, *, deposit_id: int) -> list[BankDepositAllocation]:
    stmt = select(BankDepositAllocation).where(BankDepositAllocation.deposit_id == deposit_id).order_by(
        BankDepositAllocation.shift_id
    )
    return list(db.execute(stmt).scalars())


def _allocated_live_for_shift(db: Session, shift_id: int) -> int:
    """`Σ amount` de las imputaciones VIVAS (su consignación no está
    reversada) de un turno. Es la mitad derivada de la llave anti doble
    conteo: nunca se guarda, se suma en cada lectura."""

    total = db.execute(
        select(func.coalesce(func.sum(BankDepositAllocation.amount), 0))
        .select_from(BankDepositAllocation)
        .join(BankDeposit, BankDeposit.id == BankDepositAllocation.deposit_id)
        .where(BankDepositAllocation.shift_id == shift_id, BankDeposit.status == BankDepositStatus.LIVE)
    ).scalar_one()
    return int(total)


def _closed_shift_for_update(db: Session, *, organization_id: int, store_id: int, shift_id: int) -> Shift:
    """El turno `shift_id`, bloqueado (`FOR UPDATE`) para que dos
    consignaciones concurrentes no lo imputen dos veces por encima de su
    `to_deposit` (mismo patrón de `SELECT ... FOR UPDATE` que
    `app.fiscal` usa para reservar el consecutivo). En SQLite el dialecto
    ignora la cláusula (no hay locking real entre conexiones de test), pero
    no falla: el bloqueo real ocurre en Postgres, que es donde corre la
    concurrencia real.
    """

    shift = db.execute(select(Shift).where(Shift.id == shift_id).with_for_update()).scalar_one_or_none()
    if shift is None or shift.organization_id != organization_id or shift.store_id != store_id:
        raise NotFoundError(f"El turno {shift_id} no existe en esta sede")
    if shift.status != ShiftStatus.CLOSED or shift.to_deposit is None:
        raise AppError(
            code="SHIFT_NOT_CLOSED",
            message=(
                f"El turno #{shift_id} no está cerrado, o cerró sin conteo; sólo un turno cerrado con "
                "conteo tiene saldo por consignar"
            ),
            status=400,
        )
    # C4/H-4 (iteración 2, decisión ratificada del Maestro): si
    # `GET /admin/deposits/pending` publica `to_deposit: null` para un turno
    # cerrado sin conteo (arriba, `pending_deposits`), imputarle una
    # consignación a ESE mismo turno tiene que rechazarse — si no, la misma
    # pregunta ("¿cuánto queda por consignar de este turno?") vuelve a tener
    # dos respuestas distintas, que es el H-4 de 2b otra vez. La cifra que
    # `_close_administrative` deja en `to_deposit` (`expected -
    # opening_cash_fixed`) es derivada del libro, no un arqueo, así que no
    # es un techo real contra el que imputar. Esto NO deja plata sin poder
    # consignarse: la consignación sigue pudiendo registrarse con
    # `allocations: []` (el monto es input del usuario, `DepositIn.amount`
    # es un campo propio que no depende de ningún turno).
    if shift.closed_without_count:
        raise AppError(
            code="SHIFT_CLOSED_WITHOUT_COUNT",
            message=(
                f"El turno #{shift_id} cerró administrativamente, sin conteo: no tiene un saldo "
                "por consignar verificable, así que no se le puede imputar una consignación. "
                "Registrá la consignación sin imputarla a este turno (allocations vacío)"
            ),
            status=400,
        )
    return shift


def _validate_allocations(
    db: Session, *, organization_id: int, store_id: int, amount: int, allocations: list[DepositAllocationIn]
) -> None:
    """Valida TODO antes de que `create_deposit` escriba una sola fila
    (`docs/CONTEXTO-AGENTES.md`: `get_db` comitea también ante `AppError`)."""

    if not allocations:
        return

    seen: set[int] = set()
    for line in allocations:
        if line.shift_id in seen:
            raise AppError(
                code="DUPLICATE_ALLOCATION",
                message=f"El turno #{line.shift_id} aparece más de una vez en las imputaciones",
                status=400,
            )
        seen.add(line.shift_id)

    allocated_total = sum(line.amount for line in allocations)
    if allocated_total > amount:
        raise AppError(
            code="ALLOCATION_EXCEEDS_DEPOSIT",
            message=f"Las imputaciones suman ${allocated_total} pero la consignación es de ${amount}",
            status=400,
        )

    # Orden determinístico de bloqueo (por `shift_id`): dos consignaciones
    # concurrentes que imputan turnos en distinto orden podrían generar un
    # deadlock en Postgres si no se bloquean siempre en el mismo orden.
    for line in sorted(allocations, key=lambda x: x.shift_id):
        shift = _closed_shift_for_update(db, organization_id=organization_id, store_id=store_id, shift_id=line.shift_id)
        outstanding = shift.to_deposit - _allocated_live_for_shift(db, shift.id)  # type: ignore[operator]
        if line.amount > outstanding:
            raise AppError(
                code="DEPOSIT_EXCEEDS_PENDING",
                message=(
                    f"El turno #{shift.id} sólo tiene ${outstanding} pendiente por consignar; "
                    f"no se le puede imputar ${line.amount}"
                ),
                status=400,
            )


def create_deposit(db: Session, *, actor: Actor, store: Store, payload: DepositIn) -> BankDeposit:
    _validate_allocations(
        db,
        organization_id=store.organization_id,
        store_id=store.id,
        amount=payload.amount,
        allocations=payload.allocations,
    )

    now = clock.now_utc()
    business_date = payload.business_date or tz.today_business_date(store.cutoff_hour)
    deposited_at = payload.deposited_at
    if deposited_at is None:
        deposited_at = now
    elif deposited_at.tzinfo is None:
        # Un `<input type="datetime-local">` entrega naive: la zona la pone
        # el servidor, nunca el navegador (`app.core.tz`).
        deposited_at = tz.from_bogota_wall_clock(deposited_at)

    deposit = BankDeposit(
        organization_id=store.organization_id,
        store_id=store.id,
        business_date=business_date,
        deposited_at=deposited_at,
        amount=payload.amount,
        bank_name=payload.bank_name,
        bank_reference=payload.bank_reference,
        receipt_photo=payload.receipt_photo,
        note=payload.note,
        employee_id=actor.employee_id,
        employee_name=actor.employee_name,
        status=BankDepositStatus.LIVE,
    )
    db.add(deposit)
    db.flush()

    for line in payload.allocations:
        db.add(BankDepositAllocation(deposit_id=deposit.id, shift_id=line.shift_id, amount=line.amount))
    db.flush()

    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="bank_deposit",
        entity_id=deposit.id,
        action="create",
        before=None,
        after={
            "amount": deposit.amount,
            "business_date": str(business_date),
            "allocations": [{"shift_id": line.shift_id, "amount": line.amount} for line in payload.allocations],
        },
        reason=None,
    )
    return deposit


def list_deposits(db: Session, *, store: Store, date_from: date, date_to: date) -> list[BankDeposit]:
    stmt = (
        select(BankDeposit)
        .where(
            BankDeposit.organization_id == store.organization_id,
            BankDeposit.store_id == store.id,
            BankDeposit.business_date >= date_from,
            BankDeposit.business_date <= date_to,
        )
        .order_by(BankDeposit.business_date, BankDeposit.id)
    )
    return list(db.execute(stmt).scalars())


def reverse_deposit(db: Session, *, actor: Actor, deposit: BankDeposit, reason: str) -> BankDeposit:
    if deposit.status == BankDepositStatus.REVERSED:
        raise AppError(code="DEPOSIT_ALREADY_REVERSED", message="Esta consignación ya fue reversada", status=400)

    before = {"status": deposit.status.value}
    deposit.status = BankDepositStatus.REVERSED
    deposit.reversed_at = clock.now_utc()
    deposit.reversed_reason = reason
    deposit.reversed_by_employee_id = actor.employee_id
    deposit.reversed_by_employee_name = actor.employee_name
    db.flush()

    record_audit(
        db,
        actor=actor,
        organization_id=deposit.organization_id,
        store_id=deposit.store_id,
        entity="bank_deposit",
        entity_id=deposit.id,
        action="reverse",
        before=before,
        after={"status": "reversed"},
        reason=reason,
    )
    return deposit


# ---------------------------------------------------------------------------
# Saldo por consignar (`GET /admin/deposits/pending`).
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PendingDepositRow:
    shift_id: int
    business_date: date
    to_deposit: int | None
    reason: str | None
    deposited: int
    outstanding: int | None


def pending_deposits(db: Session, *, store: Store, date_from: date, date_to: date) -> list[PendingDepositRow]:
    rows = db.execute(
        select(Shift, BusinessDay.business_date)
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

    out: list[PendingDepositRow] = []
    for shift, business_date in rows:
        deposited = _allocated_live_for_shift(db, shift.id)
        # C4/H-4 (iteración 2): un cierre ADMINISTRATIVO
        # (`shift.closed_without_count`, `app.shifts.service`
        # `_close_administrative`) escribe `to_deposit = expected -
        # opening_cash_fixed` — un turno sin conteo NUNCA tiene
        # `to_deposit is None`, así que esa rama sola publicaba $0 (o un
        # saldo derivado del libro) donde en realidad no hubo arqueo
        # verificable. La condición real es `closed_without_count`, no sólo
        # `to_deposit is None` (que queda como defensa: el modelo lo permite
        # nullable, aunque hoy ningún camino HTTP deja esa combinación).
        if shift.closed_without_count or shift.to_deposit is None:
            out.append(
                PendingDepositRow(
                    shift_id=shift.id,
                    business_date=business_date,
                    to_deposit=None,
                    reason=(
                        "El turno cerró administrativamente, sin conteo: la cifra que quedó en "
                        "to_deposit es derivada del libro (ventas esperadas), no un arqueo, así que "
                        "no hay saldo por consignar verificable"
                        if shift.closed_without_count
                        else "El turno cerró sin conteo; no hay saldo por consignar calculable"
                    ),
                    deposited=deposited,
                    outstanding=None,
                )
            )
        else:
            out.append(
                PendingDepositRow(
                    shift_id=shift.id,
                    business_date=business_date,
                    to_deposit=shift.to_deposit,
                    reason=None,
                    deposited=deposited,
                    outstanding=shift.to_deposit - deposited,
                )
            )
    return out


# ---------------------------------------------------------------------------
# Libro del banco (`GET /admin/bank/ledger`).
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LedgerEntry:
    kind: str
    id: int | None
    business_date: date
    amount: int
    gross_amount: int | None = None
    commission_amount: int | None = None
    retention_amount: int | None = None
    settled_business_date: date | None = None
    lag_days: int | None = None
    reference: str | None = None
    note: str | None = None
    status: str | None = None


def bank_ledger(db: Session, *, store: Store, date_from: date, date_to: date) -> tuple[list[LedgerEntry], dict[str, int]]:
    entries: list[LedgerEntry] = []

    deposits = list_deposits(db, store=store, date_from=date_from, date_to=date_to)
    deposits_total = 0
    for d in deposits:
        if d.status != BankDepositStatus.LIVE:
            continue
        entries.append(
            LedgerEntry(
                kind="deposit",
                id=d.id,
                business_date=d.business_date,
                amount=d.amount,
                reference=d.bank_reference,
                note=d.note,
                status=d.status.value,
            )
        )
        deposits_total += d.amount

    settlements = db.execute(
        select(CardSettlement).where(
            CardSettlement.organization_id == store.organization_id,
            CardSettlement.store_id == store.id,
            CardSettlement.status != SettlementStatus.REVERSED,
            CardSettlement.sales_business_date >= date_from,
            CardSettlement.sales_business_date <= date_to,
        )
    ).scalars().all()
    card_net_total = 0
    for s in settlements:
        net = s.gross_amount - s.commission_amount - s.retention_amount
        entries.append(
            LedgerEntry(
                kind="card_settlement",
                id=s.id,
                business_date=s.sales_business_date,
                amount=net,
                gross_amount=s.gross_amount,
                commission_amount=s.commission_amount,
                retention_amount=s.retention_amount,
                settled_business_date=s.settled_business_date,
                lag_days=(s.settled_business_date - s.sales_business_date).days,
                reference=s.reference,
                note=s.note,
                status=s.status.value,
            )
        )
        card_net_total += net

    # "Transferencias": plata electrónica que, igual que la tarjeta, nunca
    # pasa por el cajón (`payment_bucket` la clasifica aparte de `.cash`) y
    # llega directo al banco. No hay liquidación con rezago que registrar —
    # a diferencia del datáfono, un Nequi/transferencia se acredita el mismo
    # día— así que el renglón se DERIVA de `Payment`, sin tabla propia
    # (`app.payments` no se toca).
    transfer_rows = db.execute(
        select(Payment.business_date, func.coalesce(func.sum(Payment.amount), 0))
        .where(
            Payment.store_id == store.id,
            Payment.method.in_(TRANSFER_PAYMENT_METHODS),
            Payment.voided_at.is_(None),
            Payment.business_date >= date_from,
            Payment.business_date <= date_to,
        )
        .group_by(Payment.business_date)
    ).all()
    transfers_total = 0
    for business_date, total in transfer_rows:
        amount = int(total)
        if amount == 0:
            continue
        entries.append(LedgerEntry(kind="transfer", id=None, business_date=business_date, amount=amount))
        transfers_total += amount

    entries.sort(key=lambda e: (e.business_date, e.kind, e.id or 0))
    totals = {
        "deposits": deposits_total,
        "card_settlements_net": card_net_total,
        "transfers": transfers_total,
        "total": deposits_total + card_net_total + transfers_total,
    }
    return entries, totals


# ---------------------------------------------------------------------------
# Mano del dueño (`GET /admin/bank/owner-hand`).
# ---------------------------------------------------------------------------


def owner_hand(db: Session, *, store: Store, date_from: date, date_to: date) -> dict[str, int]:
    """`retirado − consignado − gastado = saldo` (checklist de la fase).

    **`withdrawn`** (retirado) tiene DOS fuentes, y las dos son plata que
    salió de la custodia de un turno sin pasar por el banco todavía:

    - `CashPickup` vivo (retiro explícito a mitad de turno).
    - `Shift.to_deposit` de turnos cerrados (el sobrante que queda en el
      cajón al cierre, que también hay que sacar y consignar o gastar —
      nunca se pickea aparte porque `create_pickup` exige turno `OPEN`).

    Sumarlas no duplica nada: son dos momentos distintos del mismo turno
    (durante vs. al cerrar) y `_allocated_live_for_shift`/`GET
    /admin/deposits/pending` sólo le resta a `to_deposit`, nunca a
    `CashPickup` — no hay una imputación que dependa de las dos a la vez.

    **`spent`** (gastado) es plata que salió de la mano SIN pasar por el
    banco ni por ningún `CashMovement` (si hubiera pasado por un movimiento
    de caja, ya redujo el `to_deposit` del turno que la pagó, y contarla acá
    de nuevo sería la doble resta, no el doble conteo — el error simétrico).
    Dos fuentes, las dos explícitamente "sin movimiento de caja":

    - `PendingRefund(settled_from=OWNER)` — `app.refunds.service
      .settle_pending_refund` documenta que esta rama **no** crea
      `CashMovement` (SPEC-NEGOCIO §6.3).
    - `TipPayout(method="cash")` — `app.shifts.tips.register_tip_payout`
      documenta que **no** crea `CashMovement`; si el dueño pagó del cajón,
      eso se registra aparte con su propio movimiento (que entonces ya
      redujo `to_deposit`, y no vuelve a contarse acá). El sistema no
      distingue hoy, dentro de un `TipPayout(method="cash")`, cuánto salió
      del cajón versus de la mano —lo declara `outputs/backend-banco.md §
      gaps`—, así que ante la duda se cuenta COMO gastado de la mano: es el
      sesgo que "muestra menos plata" en el saldo del dueño.
    """

    pickups_total = int(
        db.execute(
            select(func.coalesce(func.sum(CashPickup.amount), 0))
            .select_from(CashPickup)
            .join(Shift, Shift.id == CashPickup.shift_id)
            .join(BusinessDay, BusinessDay.id == Shift.business_day_id)
            .where(
                CashPickup.organization_id == store.organization_id,
                CashPickup.store_id == store.id,
                CashPickup.reversed_at.is_(None),
                BusinessDay.business_date >= date_from,
                BusinessDay.business_date <= date_to,
            )
        ).scalar_one()
    )

    # `Shift.to_deposit` es `int | None` en el modelo (nullable a propósito
    # — ver `GET /admin/deposits/pending`). El `WHERE ... is_not(None)`
    # filtra las filas en runtime, pero SQLAlchemy no refleja ese filtro en
    # el tipo de `func.sum(...)`, así que mypy sigue viendo `int | None`;
    # `coalesce(..., 0)` ya lo garantiza en runtime, y el `or 0` de abajo
    # es sólo para que el tipo estático también lo sepa.
    close_total = int(
        db.execute(
            select(func.coalesce(func.sum(Shift.to_deposit), 0))
            .select_from(Shift)
            .join(BusinessDay, BusinessDay.id == Shift.business_day_id)
            .where(
                Shift.organization_id == store.organization_id,
                Shift.store_id == store.id,
                Shift.status == ShiftStatus.CLOSED,
                Shift.to_deposit.is_not(None),
                # A-2 del cierre de la fase 3: un turno cerrado
                # ADMINISTRATIVAMENTE, sin conteo, tiene `to_deposit`
                # calculado desde el libro y no desde un arqueo — nadie abrió
                # ese cajón. Sumarlo acá publicaba como "plata en la mano del
                # dueño" una cifra que nadie contó, y con el sesgo que este
                # proyecto NO tolera: mostrando MÁS plata de la que se contó.
                #
                # El propio dominio ya sabía que esa cifra no es confiable:
                # `create_deposit` rechaza imputarle una consignación a uno de
                # estos turnos (`400 SHIFT_CLOSED_WITHOUT_COUNT`), y
                # `pending_deposits` publica `to_deposit: null` con motivo
                # para los mismos turnos. Eran dos respuestas distintas a la
                # misma pregunta; ahora es una sola.
                #
                # Se EXCLUYE (el sesgo pasa a mostrar menos plata, que es el
                # tolerado) y la exclusión NO es silenciosa: `uncounted_shifts`
                # dice cuántos turnos quedaron afuera. El monto de esos turnos
                # no se publica a propósito — es justamente la cifra de la que
                # estamos diciendo que no se puede responder.
                Shift.closed_without_count.is_(False),
                BusinessDay.business_date >= date_from,
                BusinessDay.business_date <= date_to,
            )
        ).scalar_one()
        or 0
    )

    uncounted_shifts = int(
        db.execute(
            select(func.count())
            .select_from(Shift)
            .join(BusinessDay, BusinessDay.id == Shift.business_day_id)
            .where(
                Shift.organization_id == store.organization_id,
                Shift.store_id == store.id,
                Shift.status == ShiftStatus.CLOSED,
                Shift.closed_without_count.is_(True),
                BusinessDay.business_date >= date_from,
                BusinessDay.business_date <= date_to,
            )
        ).scalar_one()
    )

    withdrawn = pickups_total + close_total

    deposited = int(
        db.execute(
            select(func.coalesce(func.sum(BankDeposit.amount), 0)).where(
                BankDeposit.organization_id == store.organization_id,
                BankDeposit.store_id == store.id,
                BankDeposit.status == BankDepositStatus.LIVE,
                BankDeposit.business_date >= date_from,
                BankDeposit.business_date <= date_to,
            )
        ).scalar_one()
    )

    refunds = db.execute(
        select(PendingRefund).where(
            PendingRefund.organization_id == store.organization_id,
            PendingRefund.store_id == store.id,
            PendingRefund.status == PendingRefundStatus.SETTLED,
            PendingRefund.settled_from == SettleFrom.OWNER,
        )
    ).scalars().all()
    spent_on_refunds = 0
    for r in refunds:
        if r.settled_at is None:
            continue
        business_date = tz.business_date_for(r.settled_at, store.cutoff_hour)
        if date_from <= business_date <= date_to:
            spent_on_refunds += r.amount

    # A-3: un reparto de propinas pagado DEL CAJÓN ya redujo el `to_deposit`
    # de su turno, y `withdrawn_from_shift_close` (arriba) suma justamente ese
    # `to_deposit`. Restarlo otra vez acá era contar la misma plata dos veces.
    #
    # Sólo salen de la mano del dueño los repartos `owner_hand` y los
    # `unknown` — las filas anteriores a la columna, donde nadie declaró el
    # origen. A `unknown` se lo trata como «de la mano» a propósito: es el
    # sesgo que muestra MENOS plata, el único que este proyecto tolera
    # (SPEC-NEGOCIO §6.1), y su cantidad se publica en
    # `tip_payouts_unknown_source` para que la suposición no sea silenciosa.
    payouts = db.execute(
        select(TipPayout).where(
            TipPayout.organization_id == store.organization_id,
            TipPayout.store_id == store.id,
            TipPayout.method == "cash",
        )
    ).scalars().all()
    spent_on_tips = 0
    tip_payouts_unknown_source = 0
    for p in payouts:
        business_date = tz.business_date_for(p.paid_at, store.cutoff_hour)
        if not (date_from <= business_date <= date_to):
            continue
        if p.paid_from == TipPayoutSource.DRAWER:
            continue
        if p.paid_from == TipPayoutSource.UNKNOWN:
            tip_payouts_unknown_source += 1
        spent_on_tips += p.total_amount

    spent = spent_on_refunds + spent_on_tips
    balance = withdrawn - deposited - spent

    return {
        "withdrawn": withdrawn,
        "deposited": deposited,
        "spent": spent,
        "balance": balance,
        "withdrawn_from_pickups": pickups_total,
        "withdrawn_from_shift_close": close_total,
        "spent_on_tips": spent_on_tips,
        "spent_on_refunds": spent_on_refunds,
        "uncounted_shifts": uncounted_shifts,
        "tip_payouts_unknown_source": tip_payouts_unknown_source,
    }


# ---------------------------------------------------------------------------
# Conciliación de datáfono.
# ---------------------------------------------------------------------------


def get_card_settlement_or_404(db: Session, *, organization_id: int, settlement_id: int) -> CardSettlement:
    row = db.get(CardSettlement, settlement_id)
    if row is None or row.organization_id != organization_id:
        raise NotFoundError("La liquidación de datáfono no existe en esta organización")
    return row


def create_card_settlement(db: Session, *, actor: Actor, store: Store, payload: CardSettlementIn) -> CardSettlement:
    if payload.settled_business_date < payload.sales_business_date:
        raise AppError(
            code="SETTLEMENT_DATE_ORDER",
            message="La fecha en que llegó la plata no puede ser anterior a la fecha de las ventas liquidadas",
            status=400,
        )
    row = CardSettlement(
        organization_id=store.organization_id,
        store_id=store.id,
        sales_business_date=payload.sales_business_date,
        settled_business_date=payload.settled_business_date,
        gross_amount=payload.gross_amount,
        commission_amount=payload.commission_amount,
        retention_amount=payload.retention_amount,
        reference=payload.reference,
        note=payload.note,
        status=SettlementStatus.RECORDED,
        employee_id=actor.employee_id,
        employee_name=actor.employee_name,
        created_at=clock.now_utc(),
    )
    db.add(row)
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="card_settlement",
        entity_id=row.id,
        action="create",
        before=None,
        after={"gross_amount": row.gross_amount, "sales_business_date": str(row.sales_business_date)},
        reason=None,
    )
    return row


def list_card_settlements(
    db: Session, *, store: Store, date_from: date, date_to: date, status: str | None = None
) -> list[CardSettlement]:
    stmt = select(CardSettlement).where(
        CardSettlement.organization_id == store.organization_id,
        CardSettlement.store_id == store.id,
        CardSettlement.sales_business_date >= date_from,
        CardSettlement.sales_business_date <= date_to,
    )
    if status is not None:
        stmt = stmt.where(CardSettlement.status == status)
    stmt = stmt.order_by(CardSettlement.sales_business_date, CardSettlement.id)
    return list(db.execute(stmt).scalars())


def match_card_settlement(db: Session, *, actor: Actor, settlement: CardSettlement, note: str | None) -> CardSettlement:
    if settlement.status == SettlementStatus.REVERSED:
        raise AppError(code="SETTLEMENT_REVERSED", message="Esta liquidación fue reversada; no se puede conciliar", status=400)
    if settlement.status == SettlementStatus.MATCHED:
        raise AppError(code="SETTLEMENT_ALREADY_MATCHED", message="Esta liquidación ya está conciliada", status=400)

    before = {"status": settlement.status.value}
    settlement.status = SettlementStatus.MATCHED
    settlement.matched_at = clock.now_utc()
    settlement.matched_by_employee_id = actor.employee_id
    settlement.matched_by_employee_name = actor.employee_name
    if note:
        settlement.note = note
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=settlement.organization_id,
        store_id=settlement.store_id,
        entity="card_settlement",
        entity_id=settlement.id,
        action="match",
        before=before,
        after={"status": "matched"},
        reason=None,
    )
    return settlement


def reverse_card_settlement(db: Session, *, actor: Actor, settlement: CardSettlement, reason: str) -> CardSettlement:
    if settlement.status == SettlementStatus.REVERSED:
        raise AppError(code="SETTLEMENT_ALREADY_REVERSED", message="Esta liquidación ya fue reversada", status=400)

    before = {"status": settlement.status.value}
    settlement.status = SettlementStatus.REVERSED
    settlement.reversed_at = clock.now_utc()
    settlement.reversed_reason = reason
    settlement.reversed_by_employee_id = actor.employee_id
    settlement.reversed_by_employee_name = actor.employee_name
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=settlement.organization_id,
        store_id=settlement.store_id,
        entity="card_settlement",
        entity_id=settlement.id,
        action="reverse",
        before=before,
        after={"status": "reversed"},
        reason=reason,
    )
    return settlement


def card_reconciliation_rows(db: Session, *, store: Store, date_from: date, date_to: date) -> list[dict[str, Any]]:
    expected_rows = db.execute(
        select(Payment.business_date, func.coalesce(func.sum(Payment.amount), 0))
        .where(
            Payment.store_id == store.id,
            Payment.method.in_(CARD_PAYMENT_METHODS),
            Payment.voided_at.is_(None),
            Payment.business_date >= date_from,
            Payment.business_date <= date_to,
        )
        .group_by(Payment.business_date)
    ).all()
    expected_by_date: dict[date, int] = {d: int(total) for d, total in expected_rows}

    settlements = list_card_settlements(db, store=store, date_from=date_from, date_to=date_to)
    settled_by_date: dict[date, int] = {}
    matched_by_date: dict[date, bool] = {}
    ids_by_date: dict[date, list[int]] = {}
    for s in settlements:
        if s.status == SettlementStatus.REVERSED:
            continue
        settled_by_date[s.sales_business_date] = settled_by_date.get(s.sales_business_date, 0) + s.gross_amount
        ids_by_date.setdefault(s.sales_business_date, []).append(s.id)
        if s.status == SettlementStatus.MATCHED:
            matched_by_date[s.sales_business_date] = True

    all_dates = sorted(set(expected_by_date) | set(settled_by_date))
    rows: list[dict[str, Any]] = []
    for d in all_dates:
        expected = expected_by_date.get(d, 0)
        settled = settled_by_date.get(d, 0)
        rows.append(
            {
                "business_date": d,
                "expected": expected,
                "settled": settled,
                "difference": settled - expected,
                "matched": matched_by_date.get(d, False),
                "settlement_ids": sorted(ids_by_date.get(d, [])),
            }
        )
    return rows


# ---------------------------------------------------------------------------
# Conciliación de plataformas.
# ---------------------------------------------------------------------------


def get_platform_settlement_or_404(db: Session, *, organization_id: int, settlement_id: int) -> PlatformSettlement:
    row = db.get(PlatformSettlement, settlement_id)
    if row is None or row.organization_id != organization_id:
        raise NotFoundError("La liquidación de plataforma no existe en esta organización")
    return row


def _get_active_or_any_platform(db: Session, *, store_id: int, platform_id: int) -> DeliveryPlatform:
    row = db.get(DeliveryPlatform, platform_id)
    if row is None or row.store_id != store_id:
        raise NotFoundError("La plataforma no existe en esta sede")
    return row


def create_platform_settlement(
    db: Session, *, actor: Actor, store: Store, payload: PlatformSettlementIn
) -> PlatformSettlement:
    if payload.period_to < payload.period_from:
        raise AppError(
            code="SETTLEMENT_DATE_ORDER",
            message="La fecha final del período no puede ser anterior a la inicial",
            status=400,
        )
    _get_active_or_any_platform(db, store_id=store.id, platform_id=payload.platform_id)

    row = PlatformSettlement(
        organization_id=store.organization_id,
        store_id=store.id,
        platform_id=payload.platform_id,
        period_from=payload.period_from,
        period_to=payload.period_to,
        gross_amount=payload.gross_amount,
        commission_amount=payload.commission_amount,
        reference=payload.reference,
        note=payload.note,
        status=SettlementStatus.RECORDED,
        employee_id=actor.employee_id,
        employee_name=actor.employee_name,
        created_at=clock.now_utc(),
    )
    db.add(row)
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="platform_settlement",
        entity_id=row.id,
        action="create",
        before=None,
        after={"gross_amount": row.gross_amount, "platform_id": row.platform_id},
        reason=None,
    )
    return row


def list_platform_settlements(
    db: Session, *, store: Store, date_from: date, date_to: date, status: str | None = None
) -> list[PlatformSettlement]:
    stmt = select(PlatformSettlement).where(
        PlatformSettlement.organization_id == store.organization_id,
        PlatformSettlement.store_id == store.id,
        PlatformSettlement.period_from <= date_to,
        PlatformSettlement.period_to >= date_from,
    )
    if status is not None:
        stmt = stmt.where(PlatformSettlement.status == status)
    stmt = stmt.order_by(PlatformSettlement.period_from, PlatformSettlement.id)
    return list(db.execute(stmt).scalars())


def match_platform_settlement(
    db: Session, *, actor: Actor, settlement: PlatformSettlement, note: str | None
) -> PlatformSettlement:
    if settlement.status == SettlementStatus.REVERSED:
        raise AppError(code="SETTLEMENT_REVERSED", message="Esta liquidación fue reversada; no se puede conciliar", status=400)
    if settlement.status == SettlementStatus.MATCHED:
        raise AppError(code="SETTLEMENT_ALREADY_MATCHED", message="Esta liquidación ya está conciliada", status=400)

    before = {"status": settlement.status.value}
    settlement.status = SettlementStatus.MATCHED
    settlement.matched_at = clock.now_utc()
    settlement.matched_by_employee_id = actor.employee_id
    settlement.matched_by_employee_name = actor.employee_name
    if note:
        settlement.note = note
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=settlement.organization_id,
        store_id=settlement.store_id,
        entity="platform_settlement",
        entity_id=settlement.id,
        action="match",
        before=before,
        after={"status": "matched"},
        reason=None,
    )
    return settlement


def reverse_platform_settlement(db: Session, *, actor: Actor, settlement: PlatformSettlement, reason: str) -> PlatformSettlement:
    if settlement.status == SettlementStatus.REVERSED:
        raise AppError(code="SETTLEMENT_ALREADY_REVERSED", message="Esta liquidación ya fue reversada", status=400)

    before = {"status": settlement.status.value}
    settlement.status = SettlementStatus.REVERSED
    settlement.reversed_at = clock.now_utc()
    settlement.reversed_reason = reason
    settlement.reversed_by_employee_id = actor.employee_id
    settlement.reversed_by_employee_name = actor.employee_name
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=settlement.organization_id,
        store_id=settlement.store_id,
        entity="platform_settlement",
        entity_id=settlement.id,
        action="reverse",
        before=before,
        after={"status": "reversed"},
        reason=reason,
    )
    return settlement


def platform_reconciliation_rows(db: Session, *, store: Store, date_from: date, date_to: date) -> list[dict[str, Any]]:
    receivables = db.execute(
        select(PlatformReceivable).where(
            PlatformReceivable.store_id == store.id,
            PlatformReceivable.status == PlatformReceivableStatus.PENDING,
            PlatformReceivable.business_date >= date_from,
            PlatformReceivable.business_date <= date_to,
        )
    ).scalars().all()
    expected_by_platform: dict[int, int] = {}
    for r in receivables:
        expected_by_platform[r.platform_id] = expected_by_platform.get(r.platform_id, 0) + r.amount + r.tip_amount

    settlements = list_platform_settlements(db, store=store, date_from=date_from, date_to=date_to)
    settled_by_platform: dict[int, int] = {}
    matched_by_platform: dict[int, bool] = {}
    ids_by_platform: dict[int, list[int]] = {}
    for s in settlements:
        if s.status == SettlementStatus.REVERSED:
            continue
        settled_by_platform[s.platform_id] = settled_by_platform.get(s.platform_id, 0) + s.gross_amount
        ids_by_platform.setdefault(s.platform_id, []).append(s.id)
        if s.status == SettlementStatus.MATCHED:
            matched_by_platform[s.platform_id] = True

    platform_ids = sorted(set(expected_by_platform) | set(settled_by_platform))
    names: dict[int, str] = {}
    if platform_ids:
        for row in db.execute(select(DeliveryPlatform).where(DeliveryPlatform.id.in_(platform_ids))).scalars():
            names[row.id] = row.name

    rows: list[dict[str, Any]] = []
    for platform_id in platform_ids:
        expected = expected_by_platform.get(platform_id, 0)
        settled = settled_by_platform.get(platform_id, 0)
        rows.append(
            {
                "platform_id": platform_id,
                "platform_name": names.get(platform_id, f"Plataforma #{platform_id}"),
                "expected": expected,
                "settled": settled,
                "difference": settled - expected,
                "matched": matched_by_platform.get(platform_id, False),
                "settlement_ids": sorted(ids_by_platform.get(platform_id, [])),
            }
        )
    return rows
