"""Puntos de enganche cruzados del turno de caja.

Este módulo NO importa `app.shifts.service` (evita el ciclo: `service` sí
importa `hooks` para leer los totales de venta al calcular el esperado). Solo
depende de `app.shifts.models` y `app.core.clock`.

- `on_employee_identified` lo llama `backend-core` desde `POST
  /auth/device/identify` (protegido con `importlib.util.find_spec` porque
  `app.shifts` puede no existir todavía durante la construcción en paralelo).
- `get_sales_totals` lo llama `service.compute_breakdown`; en el pedido 1a no
  hay comandas ni cobro (eso es 1b), así que siempre devuelve ceros. El
  comentario de abajo es la posta del reemplazo.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import clock
from app.shifts.models import Shift, ShiftRoster, ShiftStatus


@dataclass(frozen=True)
class SalesTotals:
    """Ventas del turno por medio de pago. En 1a siempre cero (no hay cobro)."""

    cash: int = 0
    card: int = 0
    transfer: int = 0
    tips_cash: int = 0


def get_sales_totals(db: Session, shift_id: int) -> SalesTotals:
    """Totales de venta por medio para el turno `shift_id`.

    1a no vende (comandas y cobro son el pedido 1b): siempre ceros. El pedido
    1b reemplaza esta función leyendo `app.sales.models.Payment` (o el modelo
    de pagos que defina) agrupado por medio para este turno, y
    `compute_breakdown` no cambia: sigue leyendo `get_sales_totals(...).cash`.
    """

    return SalesTotals()


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
