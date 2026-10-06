"""Lo único que otros dominios pueden importar de `expenses`.

**Si otro dominio necesita algo de acá, se publica una función nueva en este
archivo, nunca se importa `service.py` ni `models.py` directo desde afuera**
(`docs/CONTEXTO-AGENTES.md §3`).

Consumidores:

- `app.banking.service.owner_hand` (c9): lo que el dueño pagó de su mano
  (`owner_hand_spent`).
"""

from __future__ import annotations

from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.expenses import service
from app.expenses.models import Expense, ExpenseSource, ObligationPayment
from app.stores.models import Store


def owner_hand_spent(db: Session, *, store: Any, date_from: date, date_to: date) -> dict[str, int]:
    """Lo que salió de la mano del dueño por gastos y obligaciones del
    período (c9): `{"expenses": …, "obligations": …}`.

    - Gastos vivos (`voided_at` nulo) con `source = owner_hand`, por su
      fecha de negocio.
    - Abonos vivos a obligaciones pagados con `source = owner_hand`, por
      su fecha de pago (c5: una obligación se paga en uno o más abonos).

    Ninguno de los dos crea un movimiento de caja, así que no hay otra resta
    de la misma plata en ninguna parte."""
    expenses = sum(
        int(amount)
        for amount in db.execute(
            select(Expense.amount).where(
                Expense.organization_id == store.organization_id,
                Expense.store_id == store.id,
                Expense.source == ExpenseSource.OWNER_HAND,
                Expense.voided_at.is_(None),
                Expense.business_date >= date_from,
                Expense.business_date <= date_to,
            )
        ).scalars()
    )
    # Con abonos (c5) cada pago lleva su fuente y su fecha: cuenta cada
    # abono vivo pagado de la mano del dueño, no sólo la obligación saldada.
    obligations = sum(
        int(amount)
        for amount in db.execute(
            select(ObligationPayment.amount).where(
                ObligationPayment.organization_id == store.organization_id,
                ObligationPayment.store_id == store.id,
                ObligationPayment.source == ExpenseSource.OWNER_HAND,
                ObligationPayment.voided_at.is_(None),
                ObligationPayment.paid_on >= date_from,
                ObligationPayment.paid_on <= date_to,
            )
        ).scalars()
    )
    return {"expenses": expenses, "obligations": obligations}

#: El costo de lo vendido del período, teórico y real, y cuál se usa (h3):
#: la MISMA definición que la utilidad del período.
CostOfGoods = service.CostOfGoods
#: La cobertura mínima de fichas (por ciento de la venta neta) para confiar
#: en el costo de lo vendido: la misma de Utilidad y del punto de equilibrio.
COSTED_PCT_MIN = service.COSTED_PCT_MIN


def cost_of_goods(db: Session, *, store: Store, date_from: date, date_to: date) -> service.CostOfGoods:
    return service.cost_of_goods(db, store=store, date_from=date_from, date_to=date_to)


def labor_cost(db: Session, *, store: Store, date_from: date, date_to: date) -> tuple[int | None, str | None]:
    """La nómina del período con costo del empleador (la de la utilidad),
    `None` con motivo si falta un dato o la sede no lleva nómina."""
    return service.labor_cost(db, store=store, date_from=date_from, date_to=date_to)
