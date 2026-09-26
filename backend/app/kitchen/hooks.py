"""Lo que otros dominios leen de `kitchen`.

- `kitchen_load(db, store)` — cuántos platos siguen en cocina y cuántos
  pasaron su tiempo objetivo, con **la misma** lectura del KDS
  (`service.live_rounds` + `service.visible_items`), el mismo objetivo
  (`service.target_minutes_for`) y el mismo color (`service.semaphore`).
  Lo consume el panel del administrador (`app.reports.panel`): si el KDS
  pinta un plato en rojo, el panel lo cuenta como atrasado, y al revés.

Este dominio no importa `app.reports`: la dependencia va en un solo sentido.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import clock, features
from app.kitchen import service
from app.orders.models import OrderItem, OrderItemStatus
from app.stores import service as stores_service
from app.stores.models import Store


@dataclass(frozen=True)
class KitchenLoad:
    """`enabled=False` con la función «Cocina» apagada: no hay cola que
    contar, y los números viajan en `0` sólo porque no se dibujan."""

    enabled: bool
    in_kitchen: int
    late: int
    very_late: int
    oldest_late_minutes: int | None


def kitchen_load(db: Session, *, store: Store) -> KitchenLoad:
    if not features.is_enabled(db, store.organization_id, store.id, "kitchen.view"):
        return KitchenLoad(enabled=False, in_kitchen=0, late=0, very_late=0, oldest_late_minutes=None)
    settings = stores_service.get_sales_settings(db, store.id)
    course_targets = settings.course_target_minutes or {}
    now = clock.now_utc()
    in_kitchen = late = very_late = 0
    oldest: int | None = None
    for round_row, order in service.live_rounds(db, store_id=store.id):
        items = list(
            db.execute(
                select(OrderItem)
                .where(
                    OrderItem.round_id == round_row.id,
                    OrderItem.status.in_([OrderItemStatus.SENT, OrderItemStatus.READY]),
                )
                .order_by(OrderItem.id)
            ).scalars()
        )
        for item in service.visible_items(order, items, now=now):
            # Lo marcado «Listo» ya salió de cocina: no está atrasado.
            if item.status != OrderItemStatus.SENT or item.sent_at is None:
                continue
            in_kitchen += 1
            elapsed = int((now - item.sent_at).total_seconds())
            color = service.semaphore(
                elapsed, service.target_minutes_for(course_targets, course=item.course, station=item.station)
            )
            if color == "green":
                continue
            late += 1
            if color == "red":
                very_late += 1
            minutes = elapsed // 60
            oldest = minutes if oldest is None else max(oldest, minutes)
    return KitchenLoad(
        enabled=True, in_kitchen=in_kitchen, late=late, very_late=very_late, oldest_late_minutes=oldest
    )
