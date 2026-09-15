"""Puntos de enganche cruzados de la comanda con el turno de caja
(`CONTRATO-INTERNO-1b-1.md §2.3` y `§2.5`).

Este módulo **no importa `app.orders.service`** (evitar el ciclo: el cierre
de turno, territorio de `backend-base`, llama estas funciones antes de que
exista ninguna razón para que la comanda conozca el turno más que por su FK).
Sólo depende de `app.orders.models`, `app.core.clock` y, para el tipo del
parámetro `shift`, de `app.shifts.models.Shift` (lectura de un modelo ajeno,
igual que `app.catalog.service` lee `app.stores.models`).

Dueño del test de punta a punta (§2.5 del contrato): `backend-base`, en
`tests/shifts/test_open_orders_gate.py` (cierre con comandas abiertas →
`OPEN_ORDERS_EXIST`; con traslado, la comanda reaparece en el turno
siguiente con `shift_id` nuevo y `transferred_from_shift_id`).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core import clock
from app.orders.models import Order, OrderEvent, OrderStatus

if TYPE_CHECKING:
    from app.auth.deps import Actor
    from app.shifts.models import Shift

_OPEN_STATUSES = (OrderStatus.OPEN, OrderStatus.TO_PAY)


def count_open_orders(db: Session, *, shift_id: int) -> int:
    """Comandas `open`/`to_pay` que siguen atadas a este turno (bloquea el
    cierre salvo que se pida trasladarlas explícitamente)."""
    return int(
        db.execute(
            select(func.count())
            .select_from(Order)
            .where(Order.shift_id == shift_id, Order.status.in_(_OPEN_STATUSES))
        ).scalar_one()
    )


def detach_open_orders(db: Session, *, shift_id: int, actor: "Actor") -> list[int]:
    """Desata del turno que cierra las comandas todavía abiertas: quedan
    `shift_id=NULL` (huérfanas, esperando el turno siguiente) con
    `transferred_from_shift_id` marcado y un `OrderEvent transferred_out`."""
    now = clock.now_utc()
    orders = list(
        db.execute(
            select(Order).where(Order.shift_id == shift_id, Order.status.in_(_OPEN_STATUSES))
        ).scalars()
    )
    ids: list[int] = []
    for order in orders:
        order.transferred_from_shift_id = shift_id
        order.shift_id = None
        order.updated_at = now
        db.add(
            OrderEvent(
                organization_id=order.organization_id,
                store_id=order.store_id,
                order_id=order.id,
                kind="transferred_out",
                payload={"from_shift_id": shift_id},
                employee_id=actor.employee_id if actor else None,
                employee_name=actor.employee_name if actor else None,
                authorized_by_employee_id=None,
                authorized_by_employee_name=None,
                after_bill=order.bill_presented_at is not None,
                at=now,
            )
        )
        ids.append(order.id)
    db.flush()
    return ids


def adopt_transferred_orders(db: Session, *, store_id: int, shift: "Shift", actor: "Actor") -> list[int]:
    """Al abrir un turno, adopta las comandas huérfanas (`shift_id IS NULL`)
    de la sede que siguen `open`/`to_pay`: quedan atadas al turno nuevo con
    `transferred_to_shift_id` y un `OrderEvent transferred_in`."""
    now = clock.now_utc()
    orders = list(
        db.execute(
            select(Order).where(
                Order.store_id == store_id,
                Order.shift_id.is_(None),
                Order.status.in_(_OPEN_STATUSES),
            )
        ).scalars()
    )
    ids: list[int] = []
    for order in orders:
        order.shift_id = shift.id
        order.transferred_to_shift_id = shift.id
        order.updated_at = now
        db.add(
            OrderEvent(
                organization_id=order.organization_id,
                store_id=order.store_id,
                order_id=order.id,
                kind="transferred_in",
                payload={"to_shift_id": shift.id},
                employee_id=actor.employee_id if actor else None,
                employee_name=actor.employee_name if actor else None,
                authorized_by_employee_id=None,
                authorized_by_employee_name=None,
                after_bill=order.bill_presented_at is not None,
                at=now,
            )
        )
        ids.append(order.id)
    db.flush()
    return ids
