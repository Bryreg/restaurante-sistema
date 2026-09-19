"""Puntos de enganche cruzados del turno de caja.

Este módulo NO importa `app.shifts.service` (evita el ciclo: `service` sí
importa `hooks` para leer los totales de venta al calcular el esperado). Solo
depende de `app.shifts.models`, `app.core.clock` y, con `find_spec` (puede no
existir todavía durante la construcción en paralelo, o directamente no
existir en un proyecto que no vendió nada), de `app.payments.models`.

- `on_employee_identified` lo llama `backend-core` desde `POST
  /auth/device/identify`.
- `get_sales_totals` lo llama `service.compute_breakdown`/`_evaluate_close`.
  Sin `app.payments` (o sin turno con pagos) devuelve ceros; con el módulo
  presente, lee `Payment` del turno con `voided_at IS NULL`
  (CONTRATO-INTERNO-1b-1.md §2.3): `method` `cash` → `cash`/`tips_cash`,
  `card` → `card`/`tips_card`, `transfer` → `transfer`/`tips_transfer`,
  `platform`/`voucher`/`other` → `other`/`tips_other` (no entran al cajón).
- `register_supplier_payment_expense` (pedido 2b, `features/fase-2-costo-
  inventario/spec.md § Alcance de 2b`) lo llama
  `app.purchases.service.create_payment` cuando un pago a proveedor sale del
  cajón: busca el turno `OPEN` de la sede y crea el egreso con la causa
  tipada `SUPPLIER_PAYMENT` — nunca `OTHER_EXPENSE` reciclada. Sin turno
  abierto levanta `AppError("NO_OPEN_SHIFT", status=409)` ANTES de escribir
  nada; quien llama valida-antes-de-escribir con esto (crea el egreso antes
  de la fila del pago), así que sin turno abierto no queda ni el egreso ni
  el pago.
- `register_supplier_payment_reversal` (ronda 2 del pedido 2b, H-1
  BLOQUEANTE) es el hermano exacto de `register_supplier_payment_expense`
  en la otra dirección: lo llama `app.purchases.service.void_payment`
  cuando se anula un pago que salió del cajón (`payment.from_cash_drawer`),
  ANTES de tocar una sola línea del pago. Busca el turno `OPEN` de la sede y
  crea un `CashMovement(kind=INCOME, cause=SUPPLIER_PAYMENT)` — nunca
  `OTHER_INCOME` reciclada, nunca un ajuste manual — que devuelve a la caja
  exactamente lo que el egreso original sacó. **Nada se borra ni se
  reescribe**: el `CashMovement` del pago original queda vivo tal cual;
  éste es un movimiento nuevo y compensatorio, en el turno abierto AL
  MOMENTO DE ANULAR (que puede no ser el mismo turno en el que se pagó — la
  plata vuelve al cajón HOY, que es lo que pasa físicamente; un turno ya
  `CLOSED` es inviolable porque su conteo a ciegas ya ocurrió).
  Sin turno abierto levanta `AppError("NO_OPEN_SHIFT", status=409)` ANTES de
  escribir nada, con un mensaje que nombra la acción correctiva; quien llama
  valida-antes-de-escribir con esto, así que sin turno abierto la anulación
  se rechaza completa: ni el reintegro ni el `voided_at` del pago quedan.
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import clock
from app.core.errors import AppError
from app.core.modules import find_spec_safe
from app.shifts.models import CashMovement, CashMovementCause, CashMovementKind, Shift, ShiftRoster, ShiftStatus

_OTHER_METHODS = {"platform", "voucher", "other"}


@dataclass(frozen=True)
class SalesTotals:
    """Ventas y propinas del turno por medio de pago. Sin `app.payments`
    (o sin pagos todavía) siempre cero."""

    cash: int = 0
    card: int = 0
    transfer: int = 0
    other: int = 0
    tips_cash: int = 0
    tips_card: int = 0
    tips_transfer: int = 0
    tips_other: int = 0


def get_sales_totals(db: Session, shift_id: int) -> SalesTotals:
    """Totales de venta y propina por medio para el turno `shift_id`, leyendo
    `app.payments.models.Payment` (protegido con `find_spec`: sin el módulo
    de pagos devuelve ceros, no falla). `compute_breakdown` sigue leyendo
    sólo `.cash`, sin cambios."""

    if find_spec_safe("app.payments.models") is None:
        return SalesTotals()

    payments_module = importlib.import_module("app.payments.models")
    payment_model = getattr(payments_module, "Payment", None)
    if payment_model is None:
        return SalesTotals()

    totals = {
        "cash": 0,
        "card": 0,
        "transfer": 0,
        "other": 0,
        "tips_cash": 0,
        "tips_card": 0,
        "tips_transfer": 0,
        "tips_other": 0,
    }
    rows = db.execute(
        select(payment_model.method, payment_model.amount, payment_model.tip_amount).where(
            payment_model.shift_id == shift_id, payment_model.voided_at.is_(None)
        )
    ).all()
    for method, amount, tip_amount in rows:
        method_key = method.value if hasattr(method, "value") else str(method)
        bucket = "other" if method_key in _OTHER_METHODS else method_key
        if bucket in ("cash", "card", "transfer", "other"):
            totals[bucket] += int(amount or 0)
            totals[f"tips_{bucket}"] += int(tip_amount or 0)

    return SalesTotals(**totals)


def on_employee_identified(db: Session, *, store_id: int, employee: object) -> None:
    """Agrega al empleado identificado al roster del turno abierto de su sede.

    Lo llama `backend-core` en `POST /auth/device/identify`
    (`docs/SPEC-NEGOCIO.md §2.1`: "Identificarse la agrega automáticamente al
    roster del turno con hora de entrada"). Si no hay turno abierto, no hace
    nada (identificarse no exige turno abierto). Es idempotente: si la persona
    ya tiene una entrada abierta en el roster, no duplica.
    """

    shift = db.execute(
        select(Shift).where(Shift.store_id == store_id, Shift.status == ShiftStatus.OPEN)
    ).scalar_one_or_none()
    if shift is None:
        return

    employee_id = getattr(employee, "id")
    employee_name = getattr(employee, "name")

    existing = db.execute(
        select(ShiftRoster).where(
            ShiftRoster.shift_id == shift.id,
            ShiftRoster.employee_id == employee_id,
            ShiftRoster.out_at.is_(None),
        )
    ).scalar_one_or_none()
    if existing is not None:
        return

    db.add(
        ShiftRoster(
            organization_id=shift.organization_id,
            store_id=shift.store_id,
            shift_id=shift.id,
            employee_id=employee_id,
            employee_name=employee_name,
            in_at=clock.now_utc(),
            pauses=[],
        )
    )
    db.flush()


# ---------------------------------------------------------------------------
# Pedido 2b: el egreso del cajón por un pago a proveedor.
# ---------------------------------------------------------------------------


def register_supplier_payment_expense(
    db: Session,
    *,
    organization_id: int,
    store_id: int,
    amount: int,
    actor: Any,
    note: str | None = None,
    reference: str | None = None,
) -> CashMovement:
    """Egreso de caja de un pago en efectivo de una cuenta por pagar
    (`app.purchases.service.create_payment`). Busca el turno `OPEN` de la
    sede; sin uno, `AppError("NO_OPEN_SHIFT", status=409)` — el mensaje
    nombra la acción correctiva (`AGENTS.md §11.18`). `amount` siempre
    positivo (mismo contrato que el resto de `CashMovement`); el signo lo da
    `kind=EXPENSE` al sumar en `service.compute_breakdown`, sin cambios ahí.
    """
    shift = db.execute(
        select(Shift).where(Shift.store_id == store_id, Shift.status == ShiftStatus.OPEN)
    ).scalar_one_or_none()
    if shift is None:
        raise AppError(
            code="NO_OPEN_SHIFT",
            message="No hay un turno abierto en esta sede; abrí un turno para pagar en efectivo desde el cajón, o registrá el pago por otro medio",
            status=409,
        )

    full_note = note or "Pago a proveedor"
    if reference:
        full_note = f"{full_note} (ref: {reference})"

    movement = CashMovement(
        organization_id=organization_id,
        store_id=store_id,
        shift_id=shift.id,
        kind=CashMovementKind.EXPENSE,
        cause=CashMovementCause.SUPPLIER_PAYMENT,
        amount=amount,
        note=full_note,
        employee_id=actor.employee_id,
        employee_name=actor.employee_name,
        authorized_by_employee_id=actor.employee_id,
        authorized_by_employee_name=actor.employee_name,
        at=clock.now_utc(),
    )
    db.add(movement)
    db.flush()
    return movement


def register_supplier_payment_reversal(
    db: Session,
    *,
    organization_id: int,
    store_id: int,
    amount: int,
    actor: Any,
    note: str | None = None,
    reference: str | None = None,
) -> CashMovement:
    """Reintegro de caja cuando se anula un pago a proveedor que había
    salido del cajón (`app.purchases.service.void_payment`, ronda 2 del
    pedido 2b — H-1 BLOQUEANTE). Hermano exacto de
    `register_supplier_payment_expense` en la otra dirección: busca el
    turno `OPEN` de la sede; sin uno, `AppError("NO_OPEN_SHIFT", status=409)`
    — el mensaje nombra la acción correctiva — y **no se escribe nada**
    (ni este movimiento ni, aguas arriba, el `voided_at` del pago que lo
    disparó). Con turno abierto, crea un `CashMovement(kind=INCOME,
    cause=SUPPLIER_PAYMENT)` — causa tipada existente, nunca `OTHER_INCOME`
    reciclada — con `amount` siempre positivo (mismo contrato que el resto
    de `CashMovement`; el signo lo da `kind=INCOME` al sumar en
    `service.compute_breakdown`, sin cambios ahí). El `CashMovement` del
    egreso original NO se toca ni se borra: éste es un movimiento nuevo,
    en el turno abierto AL MOMENTO DE ANULAR (nunca el turno original si ya
    cerró: un turno `CLOSED` es inviolable porque su conteo a ciegas ya
    ocurrió; la plata vuelve al cajón HOY, que es lo que pasa físicamente).
    """
    shift = db.execute(
        select(Shift).where(Shift.store_id == store_id, Shift.status == ShiftStatus.OPEN)
    ).scalar_one_or_none()
    if shift is None:
        raise AppError(
            code="NO_OPEN_SHIFT",
            message=(
                "No hay un turno abierto en esta sede; abrí un turno para registrar el reintegro del pago "
                "anulado, y recién ahí anulá el pago"
            ),
            status=409,
        )

    full_note = note or "Reintegro por anulación de pago a proveedor"
    if reference:
        full_note = f"{full_note} (ref: {reference})"

    movement = CashMovement(
        organization_id=organization_id,
        store_id=store_id,
        shift_id=shift.id,
        kind=CashMovementKind.INCOME,
        cause=CashMovementCause.SUPPLIER_PAYMENT,
        amount=amount,
        note=full_note,
        employee_id=actor.employee_id,
        employee_name=actor.employee_name,
        authorized_by_employee_id=actor.employee_id,
        authorized_by_employee_name=actor.employee_name,
        at=clock.now_utc(),
    )
    db.add(movement)
    db.flush()
    return movement
