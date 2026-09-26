"""**La base de respaldo** (`cash_reserve`, decisión del dueño 2026-09-26).

Una sola cosa se llama «base» en este sistema: la plata que se guarda
**aparte** del cajón, con un monto fijo por sede
(`StoreCashSettings.cash_reserve_default`), por si la plata de los sobres no
alcanza para dar vueltas. No entra al conteo de apertura ni al de cierre: el
cuadre sólo cuenta lo que va a estar en el cajón. Lo que sí entra al cajón
es lo que se le presta:

- **Tomar de la base** (`take`): exige el PIN de un supervisor o
  administrador. La plata entra al cajón, así que suma al esperado como un
  préstamo (`reserve_loan` en `service.compute_breakdown`).
- **Devolver a la base** (`return`): lo hace quien tiene la caja. Sale del
  cajón y resta del préstamo.
- El préstamo se devuelve **el mismo día, antes del conteo de cierre**: con
  préstamo abierto el cierre no se puede contar (`RESERVE_LOAN_OPEN`).
- **Verificar la base** es del custodio (supervisor o administrador), a
  ciegas y aparte del cuadre del cajero: se cuenta, y recién después el
  servidor revela lo esperado (monto fijo − prestado sin devolver) y la
  diferencia.

El incidente que esto evita, del café: la base de emergencia se mezcló con la
plata consignable y el sistema pidió consignar $697.900 en vez de $197.900.
Acá la base nunca toca `to_deposit`: lo prestado vuelve a la base, no al
banco.

Nada se borra: un movimiento equivocado se reversa con motivo y quedan los
dos. La matemática vive acá y en `compute_breakdown`, nunca en el frontend.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.auth import service as auth_service
from app.auth.deps import Actor
from app.core import clock, features, money
from app.core.errors import AppError
from app.core.money import format_cop
from app.notifications.service import notify
from app.shifts.models import (
    CashReserveCheck,
    CashReserveMovement,
    CashReserveMovementKind,
    Shift,
    ShiftStatus,
)
from app.stores import service as stores_service
from app.stores.models import Store

FEATURE = "cash.reserve"

#: Acciones de `auth_service.verify_authorizer` (supervisor o administrador).
TAKE_ACTION = "reserve_take"
REVERSE_ACTION = "reserve_reverse"


# ---------------------------------------------------------------------------
# Lecturas (la matemática del préstamo, escrita una vez)
# ---------------------------------------------------------------------------


def _live_sum(db: Session, *, kind: CashReserveMovementKind, shift_id: int | None = None, store_id: int | None = None) -> int:
    stmt = select(func.coalesce(func.sum(CashReserveMovement.amount), 0)).where(
        CashReserveMovement.kind == kind, CashReserveMovement.reversed_at.is_(None)
    )
    if shift_id is not None:
        stmt = stmt.where(CashReserveMovement.shift_id == shift_id)
    if store_id is not None:
        stmt = stmt.where(CashReserveMovement.store_id == store_id)
    return int(db.execute(stmt).scalar_one())


def loan_outstanding(db: Session, shift_id: int) -> int:
    """Lo que el cajón de este turno le debe a la base: tomado − devuelto
    (sin los reversados). Es el sumando `reserve_loan` del esperado."""
    return _live_sum(db, kind=CashReserveMovementKind.TAKE, shift_id=shift_id) - _live_sum(
        db, kind=CashReserveMovementKind.RETURN, shift_id=shift_id
    )


def store_loans_outstanding(db: Session, store_id: int) -> int:
    """Todo lo prestado de la base de esta sede y sin devolver, sumando los
    turnos (un turno cerrado por rescate puede haberse quedado con plata de la
    base: sigue debiéndola)."""
    return _live_sum(db, kind=CashReserveMovementKind.TAKE, store_id=store_id) - _live_sum(
        db, kind=CashReserveMovementKind.RETURN, store_id=store_id
    )


@dataclass(frozen=True)
class OpenLoan:
    shift_id: int
    amount: int
    shift_open: bool


def open_loans(db: Session, *, store_id: int) -> list[OpenLoan]:
    """Los turnos de la sede con plata de la base sin devolver. Es lo que la
    bandeja de Hoy avisa: un préstamo tiene que volver el mismo día."""
    rows = db.execute(
        select(CashReserveMovement.shift_id).where(CashReserveMovement.store_id == store_id).distinct()
    ).scalars()
    out: list[OpenLoan] = []
    for shift_id in rows:
        amount = loan_outstanding(db, shift_id)
        if amount > 0:
            shift = db.get(Shift, shift_id)
            out.append(OpenLoan(shift_id=shift_id, amount=amount, shift_open=bool(shift and shift.status == ShiftStatus.OPEN)))
    return out


def reserve_amount(db: Session, store_id: int) -> int:
    """El monto fijo de la base de respaldo de la sede."""
    return int(stores_service.get_cash_settings(db, store_id).cash_reserve_default)


def available(db: Session, store_id: int) -> int:
    """Lo que se puede tomar ahora: el monto fijo menos lo prestado sin
    devolver. Nunca negativo."""
    return max(0, reserve_amount(db, store_id) - store_loans_outstanding(db, store_id))


def list_movements(db: Session, *, shift_id: int) -> list[CashReserveMovement]:
    return list(
        db.execute(
            select(CashReserveMovement).where(CashReserveMovement.shift_id == shift_id).order_by(CashReserveMovement.at)
        ).scalars()
    )


def last_check(db: Session, *, store_id: int) -> CashReserveCheck | None:
    return (
        db.execute(
            select(CashReserveCheck)
            .where(CashReserveCheck.store_id == store_id)
            .order_by(CashReserveCheck.at.desc(), CashReserveCheck.id.desc())
        )
        .scalars()
        .first()
    )


def list_checks(db: Session, *, store_id: int, limit: int = 30) -> list[CashReserveCheck]:
    return list(
        db.execute(
            select(CashReserveCheck)
            .where(CashReserveCheck.store_id == store_id)
            .order_by(CashReserveCheck.at.desc(), CashReserveCheck.id.desc())
            .limit(limit)
        ).scalars()
    )


def is_custodian(actor: Actor) -> bool:
    """El custodio de la base: supervisor o administrador (decisión 3 del
    dueño: el supervisor autoriza en el piso; el dueño guarda la
    configuración)."""
    return actor.kind == "admin" or actor.role in ("admin", "supervisor")


# ---------------------------------------------------------------------------
# Escrituras
# ---------------------------------------------------------------------------


def _require_enabled(db: Session, store: Store) -> None:
    features.assert_feature(db, store.organization_id, store.id, FEATURE)


def _require_open_shift(shift: Shift) -> None:
    if shift.status != ShiftStatus.OPEN:
        raise AppError("SHIFT_NOT_OPEN", "El turno no está abierto", status=400)


def _require_configured(db: Session, store: Store) -> int:
    amount = reserve_amount(db, store.id)
    if amount <= 0:
        raise AppError(
            "RESERVE_NOT_CONFIGURED",
            "Esta sede no tiene monto de base de respaldo: el administrador lo define en Ajustes › Caja",
            status=400,
        )
    return amount


def take(
    db: Session, *, actor: Actor, shift: Shift, store: Store, amount: int, authorizer_pin: str | None, note: str | None
) -> CashReserveMovement:
    """«Tomar de la base»: entra al cajón como préstamo, con PIN de
    supervisor o administrador. Todo se valida antes de escribir."""
    _require_enabled(db, store)
    _require_open_shift(shift)
    _require_configured(db, store)
    free = available(db, store.id)
    if amount > free:
        raise AppError(
            "RESERVE_INSUFFICIENT",
            f"La base de respaldo tiene {format_cop(free)} disponibles: tomá como mucho eso",
            status=400,
            extra={"available": free},
        )
    authorizer = auth_service.verify_authorizer(
        db,
        organization_id=shift.organization_id,
        store_id=shift.store_id,
        pin=authorizer_pin,
        action=TAKE_ACTION,
        requested_by=actor,
    )
    movement = CashReserveMovement(
        organization_id=shift.organization_id,
        store_id=shift.store_id,
        shift_id=shift.id,
        kind=CashReserveMovementKind.TAKE,
        amount=amount,
        note=note,
        employee_id=actor.employee_id or authorizer.id,
        employee_name=actor.employee_name or authorizer.name,
        authorized_by_employee_id=authorizer.id,
        authorized_by_employee_name=authorizer.name,
        at=clock.now_utc(),
    )
    db.add(movement)
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=shift.organization_id,
        store_id=shift.store_id,
        entity="cash_reserve_movement",
        entity_id=movement.id,
        action="take",
        before=None,
        after={"amount": amount, "shift_id": shift.id, "authorized_by": authorizer.id},
    )
    return movement


def give_back(
    db: Session, *, actor: Actor, shift: Shift, store: Store, amount: int, note: str | None
) -> CashReserveMovement:
    """«Devolver a la base»: sale del cajón. No más de lo que el cajón debe."""
    _require_enabled(db, store)
    _require_open_shift(shift)
    owed = loan_outstanding(db, shift.id)
    if owed <= 0:
        raise AppError(
            "RESERVE_NOTHING_TO_RETURN",
            "Este turno no tomó plata de la base de respaldo: no hay nada que devolver",
            status=400,
        )
    if amount > owed:
        raise AppError(
            "RESERVE_RETURN_OVER_LOAN",
            f"El cajón le debe {format_cop(owed)} a la base de respaldo: devolvé como mucho eso",
            status=400,
            extra={"owed": owed},
        )
    movement = CashReserveMovement(
        organization_id=shift.organization_id,
        store_id=shift.store_id,
        shift_id=shift.id,
        kind=CashReserveMovementKind.RETURN,
        amount=amount,
        note=note,
        employee_id=actor.employee_id,
        employee_name=actor.employee_name or "",
        at=clock.now_utc(),
    )
    db.add(movement)
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=shift.organization_id,
        store_id=shift.store_id,
        entity="cash_reserve_movement",
        entity_id=movement.id,
        action="return",
        before=None,
        after={"amount": amount, "shift_id": shift.id},
    )
    return movement


def get_movement_or_404(db: Session, *, shift: Shift, movement_id: int) -> CashReserveMovement:
    movement = db.get(CashReserveMovement, movement_id)
    if movement is None or movement.shift_id != shift.id:
        raise AppError("NOT_FOUND", "El movimiento de la base no existe en este turno", status=404)
    return movement


def reverse(
    db: Session,
    *,
    actor: Actor,
    shift: Shift,
    store: Store,
    movement: CashReserveMovement,
    reason: str,
    authorizer_pin: str | None,
) -> CashReserveMovement:
    """Reversar un movimiento equivocado (con motivo y PIN de supervisor o
    administrador). Reversar un «tomar» no puede dejar el cajón debiendo
    menos que cero: si ya se devolvió, primero se reversa la devolución."""
    _require_enabled(db, store)
    _require_open_shift(shift)
    if movement.reversed_at is not None:
        raise AppError("RESERVE_ALREADY_REVERSED", "Este movimiento de la base ya fue reversado", status=400)
    kind = movement.kind.value if isinstance(movement.kind, CashReserveMovementKind) else movement.kind
    if kind == CashReserveMovementKind.TAKE.value and loan_outstanding(db, shift.id) - movement.amount < 0:
        raise AppError(
            "RESERVE_REVERSE_WOULD_GO_NEGATIVE",
            "Esa plata ya se devolvió a la base: reversá primero la devolución",
            status=400,
        )
    authorizer = auth_service.verify_authorizer(
        db,
        organization_id=shift.organization_id,
        store_id=shift.store_id,
        pin=authorizer_pin,
        action=REVERSE_ACTION,
        requested_by=actor,
    )
    movement.reversed_at = clock.now_utc()
    movement.reversed_reason = reason
    movement.reversed_by_employee_id = authorizer.id
    movement.reversed_by_employee_name = authorizer.name
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=shift.organization_id,
        store_id=shift.store_id,
        entity="cash_reserve_movement",
        entity_id=movement.id,
        action="reverse",
        before={"reversed_at": None},
        after={"reversed_at": movement.reversed_at.isoformat(), "reason": reason},
        reason=reason,
    )
    return movement


def verify(
    db: Session,
    *,
    actor: Actor,
    store: Store,
    shift: Shift | None,
    denominations: list[money.Denomination],
    denominations_raw: list[dict[str, Any]],
    total: int,
    note: str | None,
) -> CashReserveCheck:
    """«Verificar base»: el custodio cuenta a ciegas y el servidor revela."""
    _require_enabled(db, store)
    if not is_custodian(actor):
        raise AppError(
            "RESERVE_CUSTODIAN_REQUIRED",
            "La base de respaldo la verifica su custodio: un supervisor o el administrador se identifica en la tablet",
            status=403,
        )
    fixed = _require_configured(db, store)
    counted = money.validate_denominations(denominations, total)
    lent = store_loans_outstanding(db, store.id)
    expected = fixed - lent
    difference = counted - expected
    check = CashReserveCheck(
        organization_id=store.organization_id,
        store_id=store.id,
        shift_id=shift.id if shift is not None else None,
        reserve_amount=fixed,
        loans_outstanding=lent,
        expected=expected,
        counted=counted,
        denominations=denominations_raw,
        difference=difference,
        note=note,
        employee_id=actor.employee_id,
        employee_name=actor.employee_name or "Administrador",
        at=clock.now_utc(),
    )
    db.add(check)
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=store.organization_id,
        store_id=store.id,
        entity="cash_reserve_check",
        entity_id=check.id,
        action="create",
        before=None,
        after={"expected": expected, "counted": counted, "difference": difference},
    )
    if difference != 0:
        notify(
            db,
            organization_id=store.organization_id,
            store_id=store.id,
            type="cash_reserve_difference",
            level="warning",
            title="Diferencia en la base de respaldo",
            body=(
                f"{check.employee_name} verificó la base de respaldo y encontró una diferencia de "
                f"{format_cop(difference)}."
            ),
            payload={"check_id": check.id, "difference": difference},
            dedupe_key=f"cash_reserve_difference:{check.id}",
        )
    return check
