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

from dataclasses import dataclass, field
from datetime import date
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.auth.deps import Actor
from app.banking import hooks as banking_hooks
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
    PosDepositIn,
)
from app.channels.models import DeliveryPlatform, PlatformReceivable, PlatformReceivableStatus
from app.core import clock, tz
from app.core.errors import AppError, NotFoundError
from app.core.money import format_cop
from app.expenses import hooks as expenses_hooks
from app.payments.models import Payment
from app.photos import hooks as photos_hooks
from app.refunds.models import PendingRefund, PendingRefundStatus, SettleFrom
from app.shifts import hooks as shifts_hooks
from app.shifts.hooks import methods_in_bucket
from app.shifts.models import BusinessDay, CashPickup, Shift, ShiftCarryIn, ShiftStatus, TipPayout, TipPayoutSource
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
            message=f"Las imputaciones suman {format_cop(allocated_total)} pero la consignación es de {format_cop(amount)}",
            status=400,
        )

    # Orden determinístico de bloqueo (por `shift_id`): dos consignaciones
    # concurrentes que imputan turnos en distinto orden podrían generar un
    # deadlock en Postgres si no se bloquean siempre en el mismo orden.
    shifts = [
        _closed_shift_for_update(db, organization_id=organization_id, store_id=store_id, shift_id=line.shift_id)
        for line in sorted(allocations, key=lambda x: x.shift_id)
    ]
    # El techo es el saldo DESPUÉS de la cascada (decisión del dueño,
    # 2026-09-29): si un turno más nuevo pagó con plata de éste, lo que queda
    # por consignar de éste es menos que su `to_deposit`. La misma cuenta
    # que publica la lista de pendientes (`banking_hooks.store_balances`).
    balances = banking_hooks.balances_by_shift(db, organization_id=organization_id, store_id=store_id)
    by_id = {line.shift_id: line for line in allocations}
    for shift in shifts:
        line = by_id[shift.id]
        balance = balances.get(shift.id)
        outstanding = balance.outstanding if balance is not None else 0
        if line.amount > outstanding:
            raise AppError(
                code="DEPOSIT_EXCEEDS_PENDING",
                message=(
                    f"El turno #{shift.id} sólo tiene {format_cop(outstanding)} pendiente por consignar; "
                    f"no se le puede imputar {format_cop(line.amount)}"
                ),
                status=400,
            )


def store_of_device(db: Session, actor: Actor) -> Store:
    """La sede de la tablet que pide."""
    store = db.get(Store, actor.store_id) if actor.store_id is not None else None
    if store is None or store.organization_id != actor.organization_id:
        raise NotFoundError("La sede de este dispositivo no existe")
    return store


def _open_shift_of(db: Session, store: Store) -> Shift | None:
    return db.execute(
        select(Shift).where(Shift.store_id == store.id, Shift.status == ShiftStatus.OPEN)
    ).scalar_one_or_none()


def _reject_days_in_drawer(db: Session, *, store: Store, allocations: list[DepositAllocationIn]) -> None:
    """El administrador no imputa un día cuya plata está en el cajón del turno
    abierto: esa plata la tiene quien tiene la caja, y el cajón la cuenta en
    su esperado (`ShiftCarryIn`). Consignarla desde acá la restaría del saldo
    del día sin sacarla del cajón, y al cerrar el turno faltaría."""
    open_shift = _open_shift_of(db, store)
    if open_shift is None or not allocations:
        return
    in_drawer = shifts_hooks.carried_into(db, open_shift.id)
    for line in allocations:
        if line.shift_id in in_drawer:
            raise AppError(
                code="DAY_IN_DRAWER",
                message=(
                    f"La plata del turno #{line.shift_id} está en el cajón del turno abierto: consignala "
                    "desde el POS (Turno › Consignar), o esperá a que se cierre el turno"
                ),
                status=400,
            )


def create_deposit(db: Session, *, actor: Actor, store: Store, payload: DepositIn) -> BankDeposit:
    _reject_days_in_drawer(db, store=store, allocations=payload.allocations)
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
        receipt_photo=photos_hooks.store_photo(
            db, payload.receipt_photo, organization_id=store.organization_id, store_id=store.id
        )
        or "",
        note=payload.note,
        employee_id=actor.employee_id,
        employee_name=actor.employee_name,
        status=BankDepositStatus.LIVE,
        # La registra el administrador: nace confirmada.
        source="admin",
        confirmed_at=now,
        confirmed_by_employee_id=actor.employee_id,
        confirmed_by_employee_name=actor.employee_name,
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


# ---------------------------------------------------------------------------
# Consignar desde el POS (2026-09-24).
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DrawerDay:
    source_shift_id: int
    business_date: date
    carried: int
    deposited_from_drawer: int
    remaining: int


def drawer_days(db: Session, *, store: Store) -> tuple[Shift | None, list[DrawerDay]]:
    """Los días anteriores cuya plata está en el cajón del turno abierto, con
    lo que queda de cada uno para consignar."""
    open_shift = _open_shift_of(db, store)
    if open_shift is None:
        return None, []
    carried = shifts_hooks.carried_into(db, open_shift.id)
    if not carried:
        return open_shift, []
    dates: dict[int, date] = {
        shift_id: business_date
        for shift_id, business_date in db.execute(
            select(Shift.id, BusinessDay.business_date)
            .join(BusinessDay, BusinessDay.id == Shift.business_day_id)
            .where(Shift.id.in_(carried))
        ).all()
    }
    days: list[DrawerDay] = []
    for source_id, amount in sorted(carried.items(), key=lambda kv: (dates[kv[0]], kv[0])):
        deposited = banking_hooks.drawer_deposits_to(db, shift_id=open_shift.id, source_shift_id=source_id)
        days.append(
            DrawerDay(
                source_shift_id=source_id,
                business_date=dates[source_id],
                carried=amount,
                deposited_from_drawer=deposited,
                remaining=max(0, amount - deposited),
            )
        )
    return open_shift, days


def create_pos_deposit(db: Session, *, actor: Actor, store: Store, payload: PosDepositIn) -> BankDeposit:
    """Quien tiene la caja consigna la plata de un día anterior que está en el
    cajón. Descuenta del saldo del día desde ya y sale del esperado del cajón
    (`app.shifts.service.compute_breakdown`); queda **por confirmar** hasta
    que el administrador la confirma o la rechaza. Todo se valida antes de
    escribir."""
    open_shift, days = drawer_days(db, store=store)
    if open_shift is None:
        raise AppError("NO_OPEN_SHIFT", "No hay turno abierto: la plata por consignar está en el cajón de un turno", status=409)
    day = next((d for d in days if d.source_shift_id == payload.source_shift_id), None)
    if day is None:
        raise AppError(
            "DEPOSIT_NOT_IN_DRAWER",
            "Ese día no se marcó como presente en el cajón al abrir el turno: no se puede consignar desde acá",
            status=400,
        )
    if payload.amount > day.remaining:
        raise AppError(
            "DEPOSIT_EXCEEDS_DRAWER",
            f"De ese día quedan {format_cop(day.remaining)} en el cajón; no se pueden consignar {format_cop(payload.amount)}",
            status=400,
        )
    allocation = DepositAllocationIn(shift_id=day.source_shift_id, amount=payload.amount)
    _validate_allocations(
        db, organization_id=store.organization_id, store_id=store.id, amount=payload.amount, allocations=[allocation]
    )

    now = clock.now_utc()
    deposit = BankDeposit(
        organization_id=store.organization_id,
        store_id=store.id,
        business_date=tz.today_business_date(store.cutoff_hour),
        deposited_at=now,
        amount=payload.amount,
        bank_name=payload.bank_name,
        bank_reference=payload.bank_reference,
        receipt_photo=photos_hooks.store_photo(
            db, payload.receipt_photo, organization_id=store.organization_id, store_id=store.id
        )
        or "",
        note=payload.note,
        employee_id=actor.employee_id,
        employee_name=actor.employee_name,
        status=BankDepositStatus.LIVE,
        source="pos",
        from_shift_id=open_shift.id,
    )
    db.add(deposit)
    db.flush()
    db.add(BankDepositAllocation(deposit_id=deposit.id, shift_id=day.source_shift_id, amount=payload.amount))
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
            "source": "pos",
            "from_shift_id": open_shift.id,
            "allocations": [{"shift_id": day.source_shift_id, "amount": payload.amount}],
        },
        reason=None,
    )
    return deposit


def confirm_deposit(db: Session, *, actor: Actor, deposit: BankDeposit) -> BankDeposit:
    """El administrador confirma una consignación hecha desde el POS (vio el
    comprobante). Rechazarla es reversarla (`reverse_deposit`)."""
    if deposit.status == BankDepositStatus.REVERSED:
        raise AppError("DEPOSIT_ALREADY_REVERSED", "Esta consignación fue rechazada o reversada: no se puede confirmar", status=400)
    if deposit.confirmed_at is not None:
        raise AppError("DEPOSIT_ALREADY_CONFIRMED", "Esta consignación ya está confirmada", status=400)
    deposit.confirmed_at = clock.now_utc()
    deposit.confirmed_by_employee_id = actor.employee_id
    deposit.confirmed_by_employee_name = actor.employee_name
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=deposit.organization_id,
        store_id=deposit.store_id,
        entity="bank_deposit",
        entity_id=deposit.id,
        action="confirm",
        before={"confirmed_at": None},
        after={"confirmed_at": deposit.confirmed_at.isoformat()},
        reason=None,
    )
    return deposit


def unconfirm_deposit(db: Session, *, actor: Actor, deposit: BankDeposit, reason: str) -> BankDeposit:
    """Reversa **la confirmación** (no la consignación): el administrador la
    confirmó por error y vuelve a quedar por confirmar. La consignación sigue
    viva —si la plata no llegó al banco, eso es `reverse_deposit`—. Nada se
    borra: quién la había confirmado y cuándo quedan en la auditoría, con el
    motivo."""
    clean = reason.strip()
    if not clean:
        raise AppError("REASON_REQUIRED", "Escribí el motivo: queda en el historial de la consignación", status=400)
    if deposit.status == BankDepositStatus.REVERSED:
        raise AppError("DEPOSIT_ALREADY_REVERSED", "Esta consignación fue rechazada o reversada: no hay confirmación que reversar", status=400)
    if deposit.confirmed_at is None:
        raise AppError("DEPOSIT_NOT_CONFIRMED", "Esta consignación no está confirmada: no hay confirmación que reversar", status=400)
    before = {
        "confirmed_at": deposit.confirmed_at.isoformat(),
        "confirmed_by_employee_id": deposit.confirmed_by_employee_id,
        "confirmed_by_employee_name": deposit.confirmed_by_employee_name,
    }
    deposit.confirmed_at = None
    deposit.confirmed_by_employee_id = None
    deposit.confirmed_by_employee_name = None
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=deposit.organization_id,
        store_id=deposit.store_id,
        entity="bank_deposit",
        entity_id=deposit.id,
        action="unconfirm",
        before=before,
        after={"confirmed_at": None},
        reason=clean,
    )
    return deposit


def list_drawer_deposits(db: Session, *, shift_id: int) -> list[BankDeposit]:
    return list(
        db.execute(select(BankDeposit).where(BankDeposit.from_shift_id == shift_id).order_by(BankDeposit.id)).scalars()
    )


#: Cuántos bancos recientes se ofrecen como botones al consignar.
RECENT_BANKS_LIMIT = 4


def recent_bank_names(db: Session, *, store: Store) -> list[str]:
    """Los bancos a los que la sede consignó últimamente, el más reciente
    primero y sin repetir (el primero es el último usado). No hay una tabla
    de cuentas bancarias de la sede: el banco se recuerda de las
    consignaciones mismas, que es donde ya está escrito."""
    rows = db.execute(
        select(BankDeposit.bank_name)
        .where(
            BankDeposit.organization_id == store.organization_id,
            BankDeposit.store_id == store.id,
            BankDeposit.bank_name.is_not(None),
        )
        .order_by(BankDeposit.id.desc())
        .limit(50)
    ).scalars()
    seen: dict[str, str] = {}
    for name in rows:
        clean = (name or "").strip()
        key = clean.casefold()
        if clean and key not in seen:
            seen[key] = clean
        if len(seen) >= RECENT_BANKS_LIMIT:
            break
    return list(seen.values())


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
    covered: list[dict[str, Any]] = field(default_factory=list)
    covered_by: list[dict[str, Any]] = field(default_factory=list)
    uncovered_shortfall: int = 0


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

    balances = banking_hooks.balances_by_shift(db, organization_id=store.organization_id, store_id=store.id)
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
            balance = balances.get(shift.id)
            out.append(
                PendingDepositRow(
                    shift_id=shift.id,
                    business_date=business_date,
                    to_deposit=shift.to_deposit,
                    reason=None,
                    deposited=deposited,
                    # Después de la cascada: nunca negativo; lo que este turno
                    # le tapó a otro y lo que otro le tapó a él viajan aparte.
                    outstanding=balance.outstanding if balance is not None else shift.to_deposit - deposited,
                    covered=[_link(link) for link in balance.covered] if balance is not None else [],
                    covered_by=[_link(link) for link in balance.covered_by] if balance is not None else [],
                    uncovered_shortfall=balance.uncovered_shortfall if balance is not None else 0,
                )
            )
    return out


def _link(link: banking_hooks.CascadeLink) -> dict[str, Any]:
    return {"shift_id": link.shift_id, "business_date": link.business_date, "amount": link.amount}


# El libro del banco (`GET /admin/bank/ledger`) vive en `app.banking.book`
# desde 0046: entradas Y salidas, por cuenta, con su ancla y su 4×1000.


# ---------------------------------------------------------------------------
# Mano del dueño (`GET /admin/bank/owner-hand`).
# ---------------------------------------------------------------------------


def _drawer_holds(db: Session, *, store: Store) -> tuple[Shift | None, set[int]]:
    """El último turno abierto de la sede (sin los cancelados) y los turnos
    cuya plata dejó marcada en el cajón al abrir (`ShiftCarryIn` vivas).

    Con la apertura «igual al café» la plata por consignar de un turno
    cerrado **se queda en el cajón** y el siguiente la cuenta al abrir; lo
    que ese siguiente desmarca no estaba ahí: salió en sobre."""
    latest = db.execute(
        select(Shift)
        .where(
            Shift.organization_id == store.organization_id,
            Shift.store_id == store.id,
            Shift.status != ShiftStatus.CANCELLED,
        )
        .order_by(Shift.opened_at.desc(), Shift.id.desc())
        .limit(1)
    ).scalar_one_or_none()
    if latest is None:
        return None, set()
    carried = set(
        db.execute(
            select(ShiftCarryIn.source_shift_id).where(
                ShiftCarryIn.shift_id == latest.id, ShiftCarryIn.reversed_at.is_(None)
            )
        ).scalars()
    )
    return latest, carried


def _admin_allocations_by_shift(db: Session, *, store: Store) -> dict[int, int]:
    """Lo imputado a cada turno por consignaciones vivas del ADMINISTRADOR
    (`from_shift_id` nulo): plata que pasó por la mano del dueño camino al
    banco. Lo consignado desde el cajón (POS) nunca estuvo en la mano."""
    rows = db.execute(
        select(BankDepositAllocation.shift_id, func.coalesce(func.sum(BankDepositAllocation.amount), 0))
        .join(BankDeposit, BankDeposit.id == BankDepositAllocation.deposit_id)
        .where(
            BankDeposit.organization_id == store.organization_id,
            BankDeposit.store_id == store.id,
            BankDeposit.status == BankDepositStatus.LIVE,
            BankDeposit.from_shift_id.is_(None),
        )
        .group_by(BankDepositAllocation.shift_id)
    ).all()
    return {int(shift_id): int(total) for shift_id, total in rows}


def owner_hand(db: Session, *, store: Store, date_from: date, date_to: date) -> dict[str, Any]:
    """`retirado − consignado − gastado = saldo`, contando **sólo la plata que
    de verdad salió del cajón hacia el dueño** (c9, revisión de la fórmula).

    Antes `withdrawn` sumaba el `to_deposit` de TODOS los turnos cerrados.
    Con la apertura «igual al café» (2026-09-29) esa plata se queda en el
    cajón hasta que se consigna, así que la pantalla le atribuía al dueño
    plata que estaba en la registradora. Ahora:

    **`withdrawn`** (retirado) = retiros + sobres entregados:

    - `CashPickup` vivo: el retiro explícito a mitad de turno.
    - **Sobres entregados** (`withdrawn_from_envelopes`), por turno cerrado
      CONTADO del período: lo que el administrador consignó imputándoselo
      (pasó por su mano camino al banco) más, si la plata ya **no** está en
      el cajón, lo que queda por consignar después de la cascada. La plata
      sigue en el cajón cuando el último turno abierto la marcó al abrir
      (`ShiftCarryIn` viva), o cuando todavía no abrió nadie después de un
      turno con apertura «igual al café». Lo que sigue en el cajón no se
      cuenta y se publica aparte (`still_in_drawer`) para que la exclusión
      no sea silenciosa. Lo consignado desde el cajón (POS) y lo que la
      cascada usó para tapar el hueco de otro turno nunca llegó a la mano.

    **`deposited`** (consignado) = sólo las consignaciones del
    administrador (`from_shift_id` nulo). Las del POS salen del cajón
    directo al banco y no pasan por la mano: se publican aparte
    (`deposited_from_drawer`) y no restan.

    **`spent`** (gastado) = plata que salió de la mano SIN movimiento de
    caja: devoluciones saldadas por el dueño, repartos de propina en
    efectivo pagados de la mano (los `unknown` también, el sesgo que muestra
    menos plata; los reversados no) y, desde c9, gastos y obligaciones
    pagados «de la mano del dueño» (`ExpenseSource.OWNER_HAND`).

    Un turno cerrado sin conteo sigue sin aportar (A-2): `uncounted_shifts`.
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

    # Los turnos cerrados CONTADOS, con su saldo después de la cascada: la
    # misma cuenta que «Por consignar» (`banking_hooks.store_balances`). Un
    # cierre administrativo (A-2) no entra ahí: su cifra sale del libro.
    latest, carried = _drawer_holds(db, store=store)
    admin_allocated = _admin_allocations_by_shift(db, store=store)
    envelopes_total = 0
    still_in_drawer = 0
    for shift_balance in banking_hooks.store_balances(db, organization_id=store.organization_id, store_id=store.id):
        if not (date_from <= shift_balance.business_date <= date_to):
            continue
        shift = db.get(Shift, shift_balance.shift_id)
        if shift is None:
            continue
        # Un turno por sede a la vez: uno con id mayor abrió después que este
        # (el reloj no alcanza para ordenarlos, dos instantes pueden empatar).
        if latest is None or latest.id <= shift.id:
            # Nadie abrió después: con la apertura «igual al café» la plata
            # espera en el cajón al que abra; con la base fija de antes salía
            # al cerrar.
            in_drawer = shift.opening_mode == "envelopes"
        else:
            in_drawer = shift.id in carried
        envelopes_total += admin_allocated.get(shift.id, 0)
        if in_drawer:
            still_in_drawer += shift_balance.outstanding
        else:
            envelopes_total += shift_balance.outstanding

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

    withdrawn = pickups_total + envelopes_total

    def _deposits(from_drawer: bool) -> int:
        origin = BankDeposit.from_shift_id.is_not(None) if from_drawer else BankDeposit.from_shift_id.is_(None)
        return int(
            db.execute(
                select(func.coalesce(func.sum(BankDeposit.amount), 0)).where(
                    BankDeposit.organization_id == store.organization_id,
                    BankDeposit.store_id == store.id,
                    BankDeposit.status == BankDepositStatus.LIVE,
                    BankDeposit.business_date >= date_from,
                    BankDeposit.business_date <= date_to,
                    origin,
                )
            ).scalar_one()
        )

    deposited = _deposits(from_drawer=False)
    deposited_from_drawer = _deposits(from_drawer=True)

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

    # A-3: un reparto de propinas pagado DEL CAJÓN no salió de la mano. Sólo
    # restan los `owner_hand` y los `unknown` (las filas anteriores a la
    # columna, tratadas como «de la mano»: el sesgo que muestra MENOS plata,
    # publicado en `tip_payouts_unknown_source`). c3: los reversados no.
    payouts = db.execute(
        select(TipPayout).where(
            TipPayout.organization_id == store.organization_id,
            TipPayout.store_id == store.id,
            TipPayout.method == "cash",
            TipPayout.reversed_at.is_(None),
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

    # c9: gastos y obligaciones pagados de la mano del dueño.
    owner_expenses = expenses_hooks.owner_hand_spent(db, store=store, date_from=date_from, date_to=date_to)
    spent_on_expenses = owner_expenses["expenses"] + owner_expenses["obligations"]

    spent = spent_on_refunds + spent_on_tips + spent_on_expenses
    balance = withdrawn - deposited - spent

    oldest_date, oldest_days = _oldest_undeposited(db, store=store, date_to=date_to)

    return {
        "withdrawn": withdrawn,
        "deposited": deposited,
        "spent": spent,
        "balance": balance,
        "withdrawn_from_pickups": pickups_total,
        "withdrawn_from_envelopes": envelopes_total,
        "still_in_drawer": still_in_drawer,
        "deposited_from_drawer": deposited_from_drawer,
        "spent_on_tips": spent_on_tips,
        "spent_on_refunds": spent_on_refunds,
        "spent_on_expenses": spent_on_expenses,
        "uncounted_shifts": uncounted_shifts,
        "tip_payouts_unknown_source": tip_payouts_unknown_source,
        "oldest_undeposited_date": oldest_date,
        "oldest_undeposited_days": oldest_days,
    }


def _oldest_undeposited(db: Session, *, store: Store, date_to: date) -> tuple[date | None, int | None]:
    """La plata más vieja que sigue sin consignar (informe de visualización
    #15): el cierre de turno CONTADO más antiguo, hasta `date_to`, al que
    todavía le queda saldo por consignar (`to_deposit` − imputaciones vivas,
    la misma cuenta de `GET /admin/deposits/pending`). Devuelve su fecha de
    negocio y cuántos días lleva a hoy (fecha de negocio de la sede).

    No se acota a `date_from` a propósito: la plata de antes del período que
    sigue en la mano es justamente la más vieja. Los retiros a mitad de
    turno (`CashPickup`) no se imputan a una consignación, así que no tienen
    antigüedad medible y no entran; los cierres sin conteo tampoco (su
    `to_deposit` no es un arqueo). `(None, None)` si no queda nada."""
    for pending in banking_hooks.pending_shifts(db, organization_id=store.organization_id, store_id=store.id):
        if pending.business_date <= date_to:
            today = tz.today_business_date(store.cutoff_hour)
            return pending.business_date, max((today - pending.business_date).days, 0)
    return None, None


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
