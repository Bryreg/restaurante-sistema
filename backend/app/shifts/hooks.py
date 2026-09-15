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
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import clock
from app.core.modules import find_spec_safe
from app.shifts.models import Shift, ShiftRoster, ShiftStatus

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
