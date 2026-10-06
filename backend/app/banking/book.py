"""El libro del banco completo (c2, «igual que la Plata del café», 0046).

Responde **«cuánto hay en el banco hoy, y de dónde salió»**:

- **Entradas** que el sistema ya conoce: consignaciones vivas, liquidaciones
  del datáfono (neto, el día en que el banco abonó), transferencias de
  clientes (derivadas de `Payment`) y liquidaciones de plataformas (neto).
- **Salidas** que el sistema ya conoce: gastos pagados del banco
  (`Expense.source = bank`), obligaciones saldadas del banco
  (`Obligation.settled_source = bank`) y pagos a proveedores por
  transferencia o tarjeta (`purchase_payments`).
- **Lo que el sistema no sabe por otro lado** lo teclea el dueño
  (`BankMovement`, causa tipada): la nómina —la liquidación de nómina no
  registra cuándo ni de dónde se pagó, así que no hay fuente para derivarla—,
  la cuota de manejo, aportes y retiros, traslados entre cuentas.
- **El 4×1000 (GMF)** se deriva en cada salida de una cuenta no exenta;
  nunca se guarda. Se redondea hacia arriba: el error tolerable es el que
  muestra menos plata.
- **El ancla**: el saldo del extracto que el dueño teclea es el saldo AL
  CIERRE de `balance_date`; el saldo de cada día posterior es
  `ancla + Σ efectos de los días (ancla, día]`. Antes del ancla nadie sabe
  cuánto había: `balance_after = None`, nunca 0.

**La cuenta principal**: todo renglón derivado va a la cuenta principal
salvo que el dueño lo haya movido (`BankEntryAssignment`); las
transferencias de clientes van a la cuenta marcada `receives_transfers`.
Mientras la sede no tenga ninguna cuenta creada, la principal es virtual
(`id = None`, «Cuenta principal»): nace con la primera escritura.

Toda la matemática del libro vive acá; el router sólo serializa.
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass, replace
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.auth.deps import Actor
from app.banking.models import (
    BankAccount,
    BankBalanceAnchor,
    BankDeposit,
    BankDepositStatus,
    BankEntryAssignment,
    BankMovement,
    BankMovementCause,
    BankMovementDirection,
    CardSettlement,
    PlatformSettlement,
    SettlementStatus,
)
from app.banking.schemas import (
    BankAccountIn,
    BankAccountPatchIn,
    BankAnchorIn,
    BankAssignmentIn,
    BankMovementIn,
)
from app.banking.service import TRANSFER_PAYMENT_METHODS
from app.core import clock, tz
from app.core.errors import AppError, ConflictError, NotFoundError
from app.expenses.models import Expense, ExpenseSource, Obligation, ObligationPayment, ObligationStatus
from app.expenses.service import paid_amounts
from app.payments.models import Payment
from app.purchases import hooks as purchases_hooks
from app.purchases.models import Payment as SupplierPayment
from app.purchases.models import PaymentMethod as SupplierPaymentMethod
from app.stores.models import Store

#: El gravamen a los movimientos financieros: 4 por cada 1.000 pesos que
#: salen de una cuenta no exenta.
GMF_PER_MILLE = 4
DEFAULT_ACCOUNT_NAME = "Cuenta principal"

#: Pagos a proveedores que salen del banco. `cash` sale del cajón o de la
#: mano del dueño; `other` no se sabe de dónde, y no se adivina.
BANK_SUPPLIER_METHODS = (SupplierPaymentMethod.TRANSFER, SupplierPaymentMethod.CARD)

#: Renglones derivados que el dueño puede mover de cuenta.
ASSIGNABLE_KINDS = frozenset(
    {"deposit", "card_settlement", "platform_settlement", "expense", "obligation", "supplier_payment"}
)

#: Movimientos tecleados sin 4×1000 propio: la cuota de manejo es del banco
#: y un ajuste corrige el saldo, no mueve plata.
_NO_GMF_CAUSES = frozenset({BankMovementCause.BANK_FEE, BankMovementCause.ADJUSTMENT})

_INFLOW_CAUSES = frozenset(
    {
        BankMovementCause.OWNER_CONTRIBUTION,
        BankMovementCause.INTEREST,
        BankMovementCause.ADJUSTMENT,
        BankMovementCause.OTHER,
    }
)
_OUTFLOW_CAUSES = frozenset(
    {
        BankMovementCause.PAYROLL,
        BankMovementCause.BANK_FEE,
        BankMovementCause.TAX,
        BankMovementCause.OWNER_WITHDRAWAL,
        BankMovementCause.ACCOUNT_TRANSFER,
        BankMovementCause.ADJUSTMENT,
        BankMovementCause.OTHER,
    }
)

#: Clave de ruteo de las transferencias de clientes hacia la cuenta que las
#: recibe (no es un medio de pago: el medio lo decide `methods_in_bucket`).
_TRANSFER_ROUTE = "customer_transfers"

# Orden de los renglones de un mismo día: primero lo que entra.
_KIND_ORDER = {
    "deposit": 0,
    "card_settlement": 1,
    "transfer": 2,
    "platform_settlement": 3,
    "movement": 4,
    "expense": 5,
    "obligation": 6,
    "supplier_payment": 7,
}


def gmf_of(amount: int, *, exempt: bool) -> int:
    """El 4×1000 de una salida, redondeado hacia arriba (muestra menos plata)."""
    if exempt or amount <= 0:
        return 0
    return -(-amount * GMF_PER_MILLE // 1000)


def today_for(store: Store) -> date:
    return tz.today_business_date(store.cutoff_hour)


# ---------------------------------------------------------------------------
# Cuentas.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AccountView:
    id: int | None
    name: str
    is_default: bool
    gmf_exempt: bool
    receives_transfers: bool
    active: bool


_VIRTUAL_DEFAULT = AccountView(
    id=None, name=DEFAULT_ACCOUNT_NAME, is_default=True, gmf_exempt=False, receives_transfers=False, active=True
)


def _view(row: BankAccount) -> AccountView:
    return AccountView(
        id=row.id,
        name=row.name,
        is_default=row.is_default,
        gmf_exempt=row.gmf_exempt,
        receives_transfers=row.receives_transfers,
        active=row.active,
    )


def _account_rows(db: Session, store: Store) -> list[BankAccount]:
    return list(
        db.execute(
            select(BankAccount)
            .where(BankAccount.organization_id == store.organization_id, BankAccount.store_id == store.id)
            .order_by(BankAccount.id)
        ).scalars()
    )


def list_accounts(db: Session, *, store: Store) -> list[AccountView]:
    """La principal primero; si todavía no existe, la virtual."""
    views = [_view(r) for r in _account_rows(db, store)]
    if not any(v.is_default for v in views):
        views.insert(0, _VIRTUAL_DEFAULT)
    return sorted(views, key=lambda v: (not v.is_default, not v.active, v.name.lower()))


def _default_view(accounts: list[AccountView]) -> AccountView:
    return next(a for a in accounts if a.is_default)


def _transfers_view(accounts: list[AccountView]) -> AccountView:
    return next((a for a in accounts if a.receives_transfers), _default_view(accounts))


def account_or_404(db: Session, *, store: Store, account_id: int) -> BankAccount:
    row = db.get(BankAccount, account_id)
    if row is None or row.organization_id != store.organization_id or row.store_id != store.id:
        raise NotFoundError("La cuenta no existe en esta sede")
    return row


def _identity(actor: Actor) -> tuple[int | None, str | None]:
    return actor.employee_id, actor.employee_name


def _flush_unique(db: Session) -> None:
    """Un choque con «una sola cuenta principal por sede» es concurrencia,
    no un 500: `409`."""
    try:
        db.flush()
    except IntegrityError as exc:
        raise ConflictError(
            "Otra persona cambió las cuentas del banco al mismo tiempo. Recargá y volvé a intentar."
        ) from exc


def ensure_default_account(db: Session, *, actor: Actor, store: Store) -> BankAccount:
    """La cuenta principal real; la crea si la sede todavía no tiene."""
    existing = db.execute(
        select(BankAccount).where(BankAccount.store_id == store.id, BankAccount.is_default.is_(True))
    ).scalar_one_or_none()
    if existing is not None:
        return existing
    employee_id, employee_name = _identity(actor)
    row = BankAccount(
        organization_id=store.organization_id,
        store_id=store.id,
        name=DEFAULT_ACCOUNT_NAME,
        is_default=True,
        gmf_exempt=False,
        receives_transfers=False,
        active=True,
        created_at=clock.now_utc(),
        created_by_employee_id=employee_id,
        created_by_employee_name=employee_name,
    )
    db.add(row)
    _flush_unique(db)
    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="bank_account",
        entity_id=row.id,
        action="create",
        before=None,
        after={"name": row.name, "is_default": True},
    )
    return row


def _resolve_account(db: Session, *, actor: Actor, store: Store, account_id: int | None) -> BankAccount:
    if account_id is None:
        return ensure_default_account(db, actor=actor, store=store)
    return account_or_404(db, store=store, account_id=account_id)


def _check_name_free(db: Session, *, store: Store, name: str, except_id: int | None = None) -> None:
    for row in _account_rows(db, store):
        if row.id != except_id and row.name.strip().lower() == name.strip().lower():
            raise AppError(
                code="BANK_ACCOUNT_NAME_TAKEN",
                message=f"Ya hay una cuenta que se llama «{row.name}»: usá otro nombre",
                status=400,
            )


def _clear_flag(db: Session, *, store: Store, flag: str, except_id: int | None) -> None:
    for row in _account_rows(db, store):
        if row.id != except_id and getattr(row, flag):
            setattr(row, flag, False)
    db.flush()


def create_account(db: Session, *, actor: Actor, store: Store, payload: BankAccountIn) -> BankAccount:
    name = payload.name.strip()
    _check_name_free(db, store=store, name=name)
    rows = _account_rows(db, store)
    # La primera cuenta que se crea ES la principal: reemplaza a la virtual,
    # en vez de dejar una «Cuenta principal» fantasma al lado.
    is_default = payload.is_default or not any(r.is_default for r in rows)
    if is_default:
        _clear_flag(db, store=store, flag="is_default", except_id=None)
    if payload.receives_transfers:
        _clear_flag(db, store=store, flag="receives_transfers", except_id=None)
    employee_id, employee_name = _identity(actor)
    row = BankAccount(
        organization_id=store.organization_id,
        store_id=store.id,
        name=name,
        is_default=is_default,
        gmf_exempt=payload.gmf_exempt,
        receives_transfers=payload.receives_transfers,
        active=True,
        created_at=clock.now_utc(),
        created_by_employee_id=employee_id,
        created_by_employee_name=employee_name,
    )
    db.add(row)
    _flush_unique(db)
    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="bank_account",
        entity_id=row.id,
        action="create",
        before=None,
        after={
            "name": row.name,
            "is_default": row.is_default,
            "gmf_exempt": row.gmf_exempt,
            "receives_transfers": row.receives_transfers,
        },
    )
    return row


def update_account(db: Session, *, actor: Actor, store: Store, account: BankAccount, payload: BankAccountPatchIn) -> BankAccount:
    before = {
        "name": account.name,
        "is_default": account.is_default,
        "gmf_exempt": account.gmf_exempt,
        "receives_transfers": account.receives_transfers,
        "active": account.active,
    }
    # Validar todo antes de escribir (`get_db` comitea también ante un AppError).
    if payload.name is not None:
        _check_name_free(db, store=store, name=payload.name, except_id=account.id)
    if payload.is_default is False and account.is_default:
        raise AppError(
            code="BANK_ACCOUNT_DEFAULT_REQUIRED",
            message="La sede necesita una cuenta principal: marcá otra como principal y ésta deja de serlo sola",
            status=400,
        )
    becomes_default = payload.is_default is True and not account.is_default
    inactive_after = payload.active is False or (payload.active is None and not account.active)
    if (account.is_default or becomes_default) and inactive_after:
        raise AppError(
            code="BANK_ACCOUNT_DEFAULT_INACTIVE",
            message="La cuenta principal no se puede desactivar: marcá otra como principal primero",
            status=400,
        )

    if payload.name is not None:
        account.name = payload.name.strip()
    if payload.gmf_exempt is not None:
        account.gmf_exempt = payload.gmf_exempt
    if payload.active is not None:
        account.active = payload.active
    if payload.receives_transfers is not None:
        if payload.receives_transfers:
            _clear_flag(db, store=store, flag="receives_transfers", except_id=account.id)
        account.receives_transfers = payload.receives_transfers
    if becomes_default:
        _clear_flag(db, store=store, flag="is_default", except_id=account.id)
        account.is_default = True
    _flush_unique(db)
    after = {
        "name": account.name,
        "is_default": account.is_default,
        "gmf_exempt": account.gmf_exempt,
        "receives_transfers": account.receives_transfers,
        "active": account.active,
    }
    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="bank_account",
        entity_id=account.id,
        action="update",
        before=before,
        after=after,
    )
    return account


# ---------------------------------------------------------------------------
# Saldo del extracto (ancla).
# ---------------------------------------------------------------------------


def list_anchors(db: Session, *, store: Store, account_id: int | None = None) -> list[BankBalanceAnchor]:
    stmt = select(BankBalanceAnchor).where(
        BankBalanceAnchor.organization_id == store.organization_id, BankBalanceAnchor.store_id == store.id
    )
    if account_id is not None:
        stmt = stmt.where(BankBalanceAnchor.account_id == account_id)
    return list(db.execute(stmt.order_by(BankBalanceAnchor.balance_date.desc(), BankBalanceAnchor.id.desc())).scalars())


def effective_anchors(db: Session, *, store: Store) -> dict[int, BankBalanceAnchor]:
    """El ancla que vale por cuenta: la viva con la fecha más reciente."""
    out: dict[int, BankBalanceAnchor] = {}
    for anchor in list_anchors(db, store=store):
        if anchor.voided_at is None and anchor.account_id not in out:
            out[anchor.account_id] = anchor
    return out


def anchor_or_404(db: Session, *, store: Store, anchor_id: int) -> BankBalanceAnchor:
    row = db.get(BankBalanceAnchor, anchor_id)
    if row is None or row.organization_id != store.organization_id or row.store_id != store.id:
        raise NotFoundError("Ese saldo del extracto no existe en esta sede")
    return row


def create_anchor(db: Session, *, actor: Actor, store: Store, payload: BankAnchorIn) -> BankBalanceAnchor:
    today = today_for(store)
    balance_date = payload.balance_date or today
    if balance_date > today:
        raise AppError(
            code="BANK_ANCHOR_FUTURE_DATE",
            message="El saldo del extracto es de un día que ya pasó o de hoy: corregí la fecha",
            status=400,
        )
    if payload.account_id is not None:
        account = account_or_404(db, store=store, account_id=payload.account_id)
    else:
        account = ensure_default_account(db, actor=actor, store=store)
    employee_id, employee_name = _identity(actor)
    row = BankBalanceAnchor(
        organization_id=store.organization_id,
        store_id=store.id,
        account_id=account.id,
        balance_date=balance_date,
        balance=payload.balance,
        note=payload.note,
        employee_id=employee_id,
        employee_name=employee_name,
        created_at=clock.now_utc(),
    )
    db.add(row)
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="bank_balance_anchor",
        entity_id=row.id,
        action="create",
        before=None,
        after={"account_id": account.id, "balance_date": balance_date.isoformat(), "balance": row.balance},
    )
    return row


def void_anchor(db: Session, *, actor: Actor, store: Store, anchor: BankBalanceAnchor, reason: str) -> BankBalanceAnchor:
    if anchor.voided_at is not None:
        raise AppError(code="BANK_ANCHOR_ALREADY_VOIDED", message="Ese saldo del extracto ya fue anulado", status=400)
    anchor.voided_at = clock.now_utc()
    anchor.voided_reason = reason
    anchor.voided_by_employee_id, anchor.voided_by_employee_name = _identity(actor)
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="bank_balance_anchor",
        entity_id=anchor.id,
        action="void",
        before={"voided_at": None},
        after={"voided_at": anchor.voided_at.isoformat()},
        reason=reason,
    )
    return anchor


# ---------------------------------------------------------------------------
# Movimientos tecleados.
# ---------------------------------------------------------------------------


def movement_or_404(db: Session, *, store: Store, movement_id: int) -> BankMovement:
    row = db.get(BankMovement, movement_id)
    if row is None or row.organization_id != store.organization_id or row.store_id != store.id:
        raise NotFoundError("Ese movimiento del banco no existe en esta sede")
    return row


def create_movement(db: Session, *, actor: Actor, store: Store, payload: BankMovementIn) -> BankMovement:
    today = today_for(store)
    business_date = payload.business_date or today
    direction = BankMovementDirection(payload.direction)
    cause = BankMovementCause(payload.cause)
    if business_date > today:
        raise AppError(
            code="BANK_MOVEMENT_FUTURE_DATE",
            message=(
                "El libro es de plata que ya se movió: un pago que viene va en Obligaciones, "
                "que es lo que mira la proyección"
            ),
            status=400,
        )
    allowed = _INFLOW_CAUSES if direction == BankMovementDirection.IN else _OUTFLOW_CAUSES
    if cause not in allowed:
        raise AppError(
            code="BANK_MOVEMENT_CAUSE_DIRECTION",
            message="Esa causa no corresponde a ese sentido (entrada o salida): elegí la causa que es",
            status=400,
        )
    is_transfer = cause == BankMovementCause.ACCOUNT_TRANSFER
    if is_transfer and payload.counter_account_id is None:
        raise AppError(
            code="BANK_MOVEMENT_COUNTER_ACCOUNT_REQUIRED",
            message="Un traslado entre cuentas necesita la cuenta que recibe",
            status=400,
        )
    if not is_transfer and payload.counter_account_id is not None:
        raise AppError(
            code="BANK_MOVEMENT_COUNTER_ACCOUNT_ONLY_FOR_TRANSFER",
            message="La cuenta que recibe sólo va en un traslado entre cuentas",
            status=400,
        )
    counter: BankAccount | None = None
    if payload.counter_account_id is not None:
        counter = account_or_404(db, store=store, account_id=payload.counter_account_id)
    if payload.account_id is not None:
        account_or_404(db, store=store, account_id=payload.account_id)
    account = _resolve_account(db, actor=actor, store=store, account_id=payload.account_id)
    if counter is not None and counter.id == account.id:
        raise AppError(
            code="BANK_MOVEMENT_SAME_ACCOUNT",
            message="Un traslado sale de una cuenta y entra a OTRA: elegí cuentas distintas",
            status=400,
        )
    if not account.active or (counter is not None and not counter.active):
        raise AppError(
            code="BANK_ACCOUNT_INACTIVE",
            message="Esa cuenta está desactivada: activala en Cuentas para registrarle movimientos",
            status=400,
        )
    employee_id, employee_name = _identity(actor)
    row = BankMovement(
        organization_id=store.organization_id,
        store_id=store.id,
        account_id=account.id,
        counter_account_id=counter.id if counter is not None else None,
        direction=direction,
        cause=cause,
        business_date=business_date,
        amount=payload.amount,
        description=payload.description.strip(),
        employee_id=employee_id,
        employee_name=employee_name,
        created_at=clock.now_utc(),
    )
    db.add(row)
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="bank_movement",
        entity_id=row.id,
        action="create",
        before=None,
        after={
            "account_id": row.account_id,
            "counter_account_id": row.counter_account_id,
            "direction": direction.value,
            "cause": cause.value,
            "amount": row.amount,
            "business_date": business_date.isoformat(),
        },
    )
    return row


def void_movement(db: Session, *, actor: Actor, store: Store, movement: BankMovement, reason: str) -> BankMovement:
    if movement.voided_at is not None:
        raise AppError(code="BANK_MOVEMENT_ALREADY_VOIDED", message="Ese movimiento ya fue anulado", status=400)
    movement.voided_at = clock.now_utc()
    movement.voided_reason = reason
    movement.voided_by_employee_id, movement.voided_by_employee_name = _identity(actor)
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="bank_movement",
        entity_id=movement.id,
        action="void",
        before={"voided_at": None},
        after={"voided_at": movement.voided_at.isoformat()},
        reason=reason,
    )
    return movement


# ---------------------------------------------------------------------------
# A qué cuenta va un renglón derivado.
# ---------------------------------------------------------------------------


def _source_is_bank_entry(db: Session, *, store: Store, kind: str, source_id: int) -> bool:
    """El renglón existe en esta sede y es plata del banco."""
    if kind == "deposit":
        dep = db.get(BankDeposit, source_id)
        return dep is not None and dep.store_id == store.id
    if kind == "card_settlement":
        card = db.get(CardSettlement, source_id)
        return card is not None and card.store_id == store.id
    if kind == "platform_settlement":
        plat = db.get(PlatformSettlement, source_id)
        return plat is not None and plat.store_id == store.id
    if kind == "expense":
        exp = db.get(Expense, source_id)
        return exp is not None and exp.store_id == store.id and exp.source == ExpenseSource.BANK
    if kind == "obligation":
        # Con abonos (c5) el renglón es cada pago, no la obligación.
        pay_o = db.get(ObligationPayment, source_id)
        return (
            pay_o is not None and pay_o.store_id == store.id and pay_o.source == ExpenseSource.BANK
            and pay_o.voided_at is None
        )
    if kind == "supplier_payment":
        pay = db.get(SupplierPayment, source_id)
        return pay is not None and pay.store_id == store.id and pay.method in BANK_SUPPLIER_METHODS
    return False


def assign_entry(db: Session, *, actor: Actor, store: Store, payload: BankAssignmentIn) -> tuple[BankEntryAssignment, BankAccount]:
    account = account_or_404(db, store=store, account_id=payload.account_id)
    if not _source_is_bank_entry(db, store=store, kind=payload.source_kind, source_id=payload.source_id):
        raise NotFoundError("Ese renglón no está en el libro del banco de esta sede")
    if not account.active:
        raise AppError(
            code="BANK_ACCOUNT_INACTIVE",
            message="Esa cuenta está desactivada: activala en Cuentas para moverle renglones",
            status=400,
        )
    row = db.execute(
        select(BankEntryAssignment).where(
            BankEntryAssignment.store_id == store.id,
            BankEntryAssignment.source_kind == payload.source_kind,
            BankEntryAssignment.source_id == payload.source_id,
        )
    ).scalar_one_or_none()
    employee_id, employee_name = _identity(actor)
    before = {"account_id": row.account_id} if row is not None else None
    if row is None:
        row = BankEntryAssignment(
            organization_id=store.organization_id,
            store_id=store.id,
            source_kind=payload.source_kind,
            source_id=payload.source_id,
            account_id=account.id,
            employee_id=employee_id,
            employee_name=employee_name,
            updated_at=clock.now_utc(),
        )
        db.add(row)
    else:
        row.account_id = account.id
        row.employee_id = employee_id
        row.employee_name = employee_name
        row.updated_at = clock.now_utc()
    _flush_unique(db)
    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="bank_entry_assignment",
        entity_id=f"{payload.source_kind}:{payload.source_id}",
        action="assign",
        before=before,
        after={"account_id": account.id},
    )
    return row, account


# ---------------------------------------------------------------------------
# Los renglones del libro.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LedgerEntry:
    kind: str
    id: int | None
    business_date: date
    amount: int
    direction: str = "in"
    account_id: int | None = None
    account_name: str = ""
    gmf: int = 0
    net_effect: int = 0
    balance_after: int | None = None
    assignable: bool = False
    cause: str | None = None
    description: str | None = None
    gross_amount: int | None = None
    commission_amount: int | None = None
    retention_amount: int | None = None
    settled_business_date: date | None = None
    lag_days: int | None = None
    reference: str | None = None
    note: str | None = None
    status: str | None = None


def _utc_window(date_from: date, date_to: date) -> tuple[datetime, datetime]:
    """Un margen de un día a cada lado: la fecha de negocio de un instante
    se decide después con la hora de corte (`tz.business_date_for`)."""
    start = datetime.combine(date_from - timedelta(days=1), time.min, tzinfo=timezone.utc)
    end = datetime.combine(date_to + timedelta(days=2), time.min, tzinfo=timezone.utc)
    return start, end


def _raw_entries(db: Session, *, store: Store, date_from: date, date_to: date) -> list[tuple[LedgerEntry, str | None]]:
    """Los renglones de todas las fuentes, sin cuenta resuelta todavía. El
    segundo elemento es la clave de ruteo: `_TRANSFER_ROUTE` para las
    transferencias de clientes, `None` para lo asignable o lo que ya trae
    cuenta (movimientos)."""
    out: list[tuple[LedgerEntry, str | None]] = []
    org, sid = store.organization_id, store.id

    for d in db.execute(
        select(BankDeposit).where(
            BankDeposit.organization_id == org,
            BankDeposit.store_id == sid,
            BankDeposit.status == BankDepositStatus.LIVE,
            BankDeposit.business_date >= date_from,
            BankDeposit.business_date <= date_to,
        )
    ).scalars():
        out.append(
            (
                LedgerEntry(
                    kind="deposit",
                    id=d.id,
                    business_date=d.business_date,
                    amount=d.amount,
                    reference=d.bank_reference,
                    note=d.note,
                    description=d.bank_name,
                    status=d.status.value,
                ),
                None,
            )
        )

    # El datáfono cuenta el día en que el banco ABONÓ (`settled_business_date`),
    # no el de la venta: es cuando la plata está en la cuenta.
    for s in db.execute(
        select(CardSettlement).where(
            CardSettlement.organization_id == org,
            CardSettlement.store_id == sid,
            CardSettlement.status != SettlementStatus.REVERSED,
            CardSettlement.settled_business_date >= date_from,
            CardSettlement.settled_business_date <= date_to,
        )
    ).scalars():
        net = s.gross_amount - s.commission_amount - s.retention_amount
        if net <= 0:
            continue
        out.append(
            (
                LedgerEntry(
                    kind="card_settlement",
                    id=s.id,
                    business_date=s.settled_business_date,
                    amount=net,
                    gross_amount=s.gross_amount,
                    commission_amount=s.commission_amount,
                    retention_amount=s.retention_amount,
                    settled_business_date=s.settled_business_date,
                    lag_days=(s.settled_business_date - s.sales_business_date).days,
                    reference=s.reference,
                    note=s.note,
                    status=s.status.value,
                ),
                None,
            )
        )

    # Transferencias de clientes: igual que el datáfono, nunca pasan por el
    # cajón; se acreditan el mismo día. Derivadas de `Payment`, sin fila propia.
    for business_date, total in db.execute(
        select(Payment.business_date, func.coalesce(func.sum(Payment.amount), 0))
        .where(
            Payment.store_id == sid,
            Payment.method.in_(TRANSFER_PAYMENT_METHODS),
            Payment.voided_at.is_(None),
            Payment.business_date >= date_from,
            Payment.business_date <= date_to,
        )
        .group_by(Payment.business_date)
    ).all():
        amount = int(total)
        if amount > 0:
            out.append((LedgerEntry(kind="transfer", id=None, business_date=business_date, amount=amount), _TRANSFER_ROUTE))

    start, end = _utc_window(date_from, date_to)

    # Liquidaciones de plataformas: no traen fecha de abono, así que cuentan
    # el día en que el administrador las registró.
    for p in db.execute(
        select(PlatformSettlement).where(
            PlatformSettlement.organization_id == org,
            PlatformSettlement.store_id == sid,
            PlatformSettlement.status != SettlementStatus.REVERSED,
            PlatformSettlement.created_at >= start,
            PlatformSettlement.created_at < end,
        )
    ).scalars():
        bd = tz.business_date_for(p.created_at, store.cutoff_hour)
        net = p.gross_amount - p.commission_amount
        if not (date_from <= bd <= date_to) or net <= 0:
            continue
        out.append(
            (
                LedgerEntry(
                    kind="platform_settlement",
                    id=p.id,
                    business_date=bd,
                    amount=net,
                    gross_amount=p.gross_amount,
                    commission_amount=p.commission_amount,
                    reference=p.reference,
                    note=p.note,
                    status=p.status.value,
                ),
                None,
            )
        )

    for e in db.execute(
        select(Expense).where(
            Expense.organization_id == org,
            Expense.store_id == sid,
            Expense.source == ExpenseSource.BANK,
            Expense.voided_at.is_(None),
            Expense.business_date >= date_from,
            Expense.business_date <= date_to,
        )
    ).scalars():
        out.append(
            (
                LedgerEntry(
                    kind="expense",
                    id=e.id,
                    business_date=e.business_date,
                    amount=e.amount,
                    direction="out",
                    description=e.description,
                ),
                None,
            )
        )

    # Obligaciones (c5): cada abono vivo pagado desde el banco, por su fecha
    # de pago. Una obligación pagada en dos abonos son dos renglones.
    for pay_o, desc in db.execute(
        select(ObligationPayment, Obligation.description)
        .join(Obligation, Obligation.id == ObligationPayment.obligation_id)
        .where(
            ObligationPayment.organization_id == org,
            ObligationPayment.store_id == sid,
            ObligationPayment.source == ExpenseSource.BANK,
            ObligationPayment.voided_at.is_(None),
            ObligationPayment.paid_on >= date_from,
            ObligationPayment.paid_on <= date_to,
        )
    ).all():
        out.append(
            (
                LedgerEntry(
                    kind="obligation",
                    id=pay_o.id,
                    business_date=pay_o.paid_on,
                    amount=pay_o.amount,
                    direction="out",
                    description=desc,
                ),
                None,
            )
        )

    for sp in db.execute(
        select(SupplierPayment).where(
            SupplierPayment.organization_id == org,
            SupplierPayment.store_id == sid,
            SupplierPayment.method.in_(BANK_SUPPLIER_METHODS),
            SupplierPayment.voided_at.is_(None),
            SupplierPayment.paid_at >= start,
            SupplierPayment.paid_at < end,
        )
    ).scalars():
        bd = tz.business_date_for(sp.paid_at, store.cutoff_hour)
        if date_from <= bd <= date_to:
            out.append(
                (
                    LedgerEntry(
                        kind="supplier_payment",
                        id=sp.id,
                        business_date=bd,
                        amount=sp.amount,
                        direction="out",
                        reference=sp.reference,
                    ),
                    None,
                )
            )

    for m in db.execute(
        select(BankMovement).where(
            BankMovement.organization_id == org,
            BankMovement.store_id == sid,
            BankMovement.voided_at.is_(None),
            BankMovement.business_date >= date_from,
            BankMovement.business_date <= date_to,
        )
    ).scalars():
        base = LedgerEntry(
            kind="movement",
            id=m.id,
            business_date=m.business_date,
            amount=m.amount,
            direction=m.direction.value,
            account_id=m.account_id,
            cause=m.cause.value,
            description=m.description,
        )
        out.append((base, None))
        if m.cause == BankMovementCause.ACCOUNT_TRANSFER and m.counter_account_id is not None:
            out.append((replace(base, direction="in", account_id=m.counter_account_id), None))
    return out


def _assignments(db: Session, *, store: Store) -> dict[tuple[str, int], int]:
    rows = db.execute(select(BankEntryAssignment).where(BankEntryAssignment.store_id == store.id)).scalars()
    return {(r.source_kind, r.source_id): r.account_id for r in rows}


def _resolve(
    raw: list[tuple[LedgerEntry, str | None]],
    *,
    accounts: list[AccountView],
    assignments: dict[tuple[str, int], int],
) -> list[LedgerEntry]:
    by_id = {a.id: a for a in accounts}
    default = _default_view(accounts)
    transfers = _transfers_view(accounts)
    out: list[LedgerEntry] = []
    for entry, route in raw:
        if route == _TRANSFER_ROUTE:
            account = transfers
        elif entry.kind == "movement":
            account = by_id.get(entry.account_id, default)
        else:
            assert entry.id is not None
            account = by_id.get(assignments.get((entry.kind, entry.id)), default)
        gmf = 0
        if entry.direction == "out":
            exempt = account.gmf_exempt or (entry.cause is not None and BankMovementCause(entry.cause) in _NO_GMF_CAUSES)
            gmf = gmf_of(entry.amount, exempt=exempt)
        net_effect = entry.amount if entry.direction == "in" else -(entry.amount + gmf)
        out.append(
            replace(
                entry,
                account_id=account.id,
                account_name=account.name,
                gmf=gmf,
                net_effect=net_effect,
                assignable=entry.kind in ASSIGNABLE_KINDS,
            )
        )
    out.sort(key=lambda e: (e.business_date, _KIND_ORDER.get(e.kind, 99), e.id or 0, e.direction))
    return out


def _with_balances(entries: list[LedgerEntry], anchors: dict[int, BankBalanceAnchor]) -> list[LedgerEntry]:
    """El saldo de su cuenta después de cada renglón, desde el ancla."""
    running: dict[int | None, int] = {acc: a.balance for acc, a in anchors.items()}
    out: list[LedgerEntry] = []
    for e in entries:
        anchor = anchors.get(e.account_id) if e.account_id is not None else None
        if anchor is None or e.business_date <= anchor.balance_date:
            out.append(e)
            continue
        running[e.account_id] = running[e.account_id] + e.net_effect
        out.append(replace(e, balance_after=running[e.account_id]))
    return out


def _entries_for(db: Session, *, store: Store, date_from: date, date_to: date) -> tuple[list[LedgerEntry], list[AccountView], dict[int, BankBalanceAnchor]]:
    accounts = list_accounts(db, store=store)
    anchors = effective_anchors(db, store=store)
    # Para tener el saldo de cada renglón hay que leer desde el ancla más vieja.
    start = date_from
    for anchor in anchors.values():
        start = min(start, anchor.balance_date + timedelta(days=1))
    if start > date_to:
        start = date_to
    raw = _raw_entries(db, store=store, date_from=start, date_to=date_to)
    entries = _with_balances(_resolve(raw, accounts=accounts, assignments=_assignments(db, store=store)), anchors)
    return entries, accounts, anchors


def bank_ledger(
    db: Session, *, store: Store, date_from: date, date_to: date, account_id: int | None = None
) -> tuple[list[LedgerEntry], dict[str, int]]:
    if account_id is not None:
        account_or_404(db, store=store, account_id=account_id)
    entries, _accounts, _anchors = _entries_for(db, store=store, date_from=date_from, date_to=date_to)
    shown = [
        e
        for e in entries
        if date_from <= e.business_date <= date_to and (account_id is None or e.account_id == account_id)
    ]

    def total(kinds: set[str], direction: str, *, cause_not: set[str] | None = None) -> int:
        return sum(
            e.amount
            for e in shown
            if e.kind in kinds and e.direction == direction and (cause_not is None or e.cause not in cause_not)
        )

    inflows = sum(e.amount for e in shown if e.direction == "in")
    outflows = sum(e.amount for e in shown if e.direction == "out")
    gmf = sum(e.gmf for e in shown)
    totals = {
        "deposits": total({"deposit"}, "in"),
        "card_settlements_net": total({"card_settlement"}, "in"),
        "transfers": total({"transfer"}, "in"),
        "platform_settlements_net": total({"platform_settlement"}, "in"),
        "other_inflows": total({"movement"}, "in"),
        "inflows": inflows,
        "total": inflows,
        "expenses": total({"expense"}, "out"),
        "obligations": total({"obligation"}, "out"),
        "supplier_payments": total({"supplier_payment"}, "out"),
        "other_outflows": total({"movement"}, "out"),
        "outflows": outflows,
        "gmf": gmf,
        "net": inflows - outflows - gmf,
    }
    return shown, totals


# ---------------------------------------------------------------------------
# Cuánto hay hoy.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AccountPosition:
    account: AccountView
    anchor_id: int | None
    anchor_date: date | None
    anchor_balance: int | None
    anchor_age_days: int | None
    inflows: int | None
    outflows: int | None
    gmf: int | None
    balance: int | None
    reason: str | None


def bank_position(db: Session, *, store: Store) -> dict[str, Any]:
    today = today_for(store)
    entries, accounts, anchors = _entries_for(db, store=store, date_from=today, date_to=today)
    positions: list[AccountPosition] = []
    for account in accounts:
        anchor = anchors.get(account.id) if account.id is not None else None
        if anchor is None:
            positions.append(
                AccountPosition(
                    account=account,
                    anchor_id=None,
                    anchor_date=None,
                    anchor_balance=None,
                    anchor_age_days=None,
                    inflows=None,
                    outflows=None,
                    gmf=None,
                    balance=None,
                    reason=(
                        "Todavía no hay saldo del extracto para esta cuenta: tecleá con cuánto cerró un día "
                        "y el libro corre desde ahí"
                    ),
                )
            )
            continue
        since = [
            e for e in entries if e.account_id == account.id and anchor.balance_date < e.business_date <= today
        ]
        inflows = sum(e.amount for e in since if e.direction == "in")
        outflows = sum(e.amount for e in since if e.direction == "out")
        gmf = sum(e.gmf for e in since)
        positions.append(
            AccountPosition(
                account=account,
                anchor_id=anchor.id,
                anchor_date=anchor.balance_date,
                anchor_balance=anchor.balance,
                anchor_age_days=(today - anchor.balance_date).days,
                inflows=inflows,
                outflows=outflows,
                gmf=gmf,
                balance=anchor.balance + inflows - outflows - gmf,
                reason=None,
            )
        )
    active = [p for p in positions if p.account.active]
    missing = [p.account.name for p in active if p.balance is None]
    total: int | None
    if not active:
        total, total_reason = None, "No hay cuentas activas"
    elif missing:
        total = None
        total_reason = "Falta el saldo del extracto de: " + ", ".join(missing)
    else:
        total = sum(p.balance for p in active if p.balance is not None)
        total_reason = None
    return {"as_of": today, "accounts": positions, "total": total, "total_reason": total_reason}


# ---------------------------------------------------------------------------
# Proyección de los próximos meses.
# ---------------------------------------------------------------------------

HISTORY_MONTHS = 3
#: Entradas que se repiten: lo que vende el restaurante. Un aporte del dueño
#: o un ajuste no es un «mes normal».
_RECURRING_INFLOW_KINDS = frozenset({"deposit", "card_settlement", "transfer", "platform_settlement"})
#: Salidas recurrentes del historial: gastos pagados del banco y lo tecleado
#: (nómina, cuota de manejo…). Las obligaciones y las cuentas por pagar NO:
#: ésas se proyectan desde su vencimiento, y contarlas también en el
#: promedio las restaría dos veces.
_NON_RECURRING_CAUSES = frozenset({"account_transfer", "adjustment", "owner_contribution", "interest"})


def _month_bounds(year: int, month: int) -> tuple[date, date]:
    return date(year, month, 1), date(year, month, calendar.monthrange(year, month)[1])


def _add_months(year: int, month: int, n: int) -> tuple[int, int]:
    idx = year * 12 + (month - 1) + n
    return idx // 12, idx % 12 + 1


def _is_recurring_inflow(e: LedgerEntry) -> bool:
    return e.direction == "in" and (
        e.kind in _RECURRING_INFLOW_KINDS or (e.kind == "movement" and e.cause == "interest")
    )


def _is_recurring_outflow(e: LedgerEntry) -> bool:
    return e.direction == "out" and (
        e.kind == "expense" or (e.kind == "movement" and e.cause not in _NON_RECURRING_CAUSES)
    )


def bank_projection(db: Session, *, store: Store, months: int) -> dict[str, Any]:
    """«Lo que viene»: con cuánto cerraría cada uno de los próximos meses.

    Una guía, no una promesa, y se explica en una línea: saldo de hoy + lo
    que entra en un mes normal (promedio de los últimos meses completos con
    entradas) − las obligaciones agendadas y las cuentas por pagar que
    vencen en ese mes − los gastos recurrentes (promedio) − su 4×1000.

    La primera fila es lo que queda del mes en curso (con los promedios
    prorrateados por días) y lleva además lo vencido sin pagar. Sin saldo de
    hoy, los flujos se muestran igual y el cierre va en `None` con motivo.
    """
    today = today_for(store)
    position = bank_position(db, store=store)
    starting: int | None = position["total"]
    reason: str | None = position["total_reason"]
    accounts = list_accounts(db, store=store)
    exempt = _default_view(accounts).gmf_exempt

    # Historial: los últimos meses COMPLETOS (el mes en curso está a medias).
    hist_from_y, hist_from_m = _add_months(today.year, today.month, -HISTORY_MONTHS)
    hist_from, _ = _month_bounds(hist_from_y, hist_from_m)
    prev_y, prev_m = _add_months(today.year, today.month, -1)
    _, hist_to = _month_bounds(prev_y, prev_m)
    raw = _raw_entries(db, store=store, date_from=hist_from, date_to=hist_to)
    history = _resolve(raw, accounts=accounts, assignments=_assignments(db, store=store))
    month_inflows: dict[tuple[int, int], int] = {}
    month_outflows: dict[tuple[int, int], int] = {}
    for e in history:
        key = (e.business_date.year, e.business_date.month)
        if _is_recurring_inflow(e):
            month_inflows[key] = month_inflows.get(key, 0) + e.amount
        elif _is_recurring_outflow(e):
            month_outflows[key] = month_outflows.get(key, 0) + e.amount
    history_months = len(month_inflows)
    avg_in: int | None = None
    avg_out: int | None = None
    if history_months > 0:
        # Entradas hacia abajo y salidas hacia arriba: el error que muestra menos plata.
        avg_in = sum(month_inflows.values()) // history_months
        avg_out = -(-sum(month_outflows.get(k, 0) for k in month_inflows) // history_months)
    elif reason is None:
        reason = "Hace falta al menos un mes completo con entradas al banco para estimar lo que entra"

    # Lo agendado: obligaciones pendientes y cuentas por pagar con saldo.
    obligations = db.execute(
        select(Obligation).where(
            Obligation.organization_id == store.organization_id,
            Obligation.store_id == store.id,
            Obligation.status.in_([ObligationStatus.PENDING, ObligationStatus.PARTIAL]),
            Obligation.cancelled_at.is_(None),
        )
    ).scalars().all()
    # Lo que falta de cada una (con abonos, no el monto original).
    paid = paid_amounts(db, [o.id for o in obligations])
    balance = {o.id: max(o.amount - paid.get(o.id, 0), 0) for o in obligations}
    payables = purchases_hooks.open_payables(db, store_id=store.id)
    overdue_obligations = sum(balance[o.id] for o in obligations if o.due_date <= today)
    overdue_payables = sum(int(p["balance"]) for p in payables if p["due_date"] <= today)

    windows: list[tuple[int, int, date, date, int, int]] = []  # year, month, from, to, days, month_days
    _, end_this = _month_bounds(today.year, today.month)
    if today < end_this:
        windows.append(
            (today.year, today.month, today + timedelta(days=1), end_this, (end_this - today).days, end_this.day)
        )
    for i in range(1, months + 1):
        y, m = _add_months(today.year, today.month, i)
        start, end = _month_bounds(y, m)
        windows.append((y, m, start, end, end.day, end.day))

    rows: list[dict[str, Any]] = []
    closing = starting
    for idx, (y, m, w_from, w_to, days, month_days) in enumerate(windows):
        first = idx == 0
        scheduled = sum(balance[o.id] for o in obligations if w_from <= o.due_date <= w_to)
        due = sum(int(p["balance"]) for p in payables if w_from <= p["due_date"] <= w_to)
        if first:
            scheduled += overdue_obligations
            due += overdue_payables
        expected_in = None if avg_in is None else avg_in * days // month_days
        recurring = None if avg_out is None else -(-avg_out * days // month_days)
        gmf = None if recurring is None else gmf_of(scheduled + due + recurring, exempt=exempt)
        net = (
            None
            if expected_in is None or recurring is None or gmf is None
            else expected_in - scheduled - due - recurring - gmf
        )
        closing = None if closing is None or net is None else closing + net
        rows.append(
            {
                "year": y,
                "month": m,
                "date_from": w_from,
                "date_to": w_to,
                "expected_inflows": expected_in,
                "scheduled_obligations": scheduled,
                "payables_due": due,
                "recurring_expenses": recurring,
                "gmf": gmf,
                "net": net,
                "closing_balance": closing,
            }
        )

    return {
        "as_of": today,
        "starting_balance": starting,
        "reason": reason,
        "history_months": history_months,
        "avg_monthly_inflows": avg_in,
        "avg_monthly_recurring_expenses": avg_out,
        "overdue_obligations": overdue_obligations,
        "overdue_payables": overdue_payables,
        "months": rows,
    }
