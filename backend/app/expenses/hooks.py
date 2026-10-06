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

from app.core import tz
from app.expenses.models import Expense, ExpenseSource, Obligation, ObligationStatus


def owner_hand_spent(db: Session, *, store: Any, date_from: date, date_to: date) -> dict[str, int]:
    """Lo que salió de la mano del dueño por gastos y obligaciones del
    período (c9): `{"expenses": …, "obligations": …}`.

    - Gastos vivos (`voided_at` nulo) con `source = owner_hand`, por su
      fecha de negocio.
    - Obligaciones saldadas (no canceladas) con `settled_source =
      owner_hand`, por la fecha de negocio en que se saldaron (hora de corte
      de la sede, nunca la fecha UTC).

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
    obligations = 0
    for amount, settled_at in db.execute(
        select(Obligation.amount, Obligation.settled_at).where(
            Obligation.organization_id == store.organization_id,
            Obligation.store_id == store.id,
            Obligation.status == ObligationStatus.PAID,
            Obligation.settled_source == ExpenseSource.OWNER_HAND,
            Obligation.cancelled_at.is_(None),
        )
    ).all():
        if settled_at is None:
            continue
        if date_from <= tz.business_date_for(settled_at, store.cutoff_hour) <= date_to:
            obligations += int(amount)
    return {"expenses": expenses, "obligations": obligations}
