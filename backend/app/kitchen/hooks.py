"""Lo que otros dominios leen de `kitchen`.

- `kitchen_load(db, store)` — cuántos platos siguen en cocina y cuántos
  pasaron su tiempo objetivo, con **la misma** lectura del KDS
  (`service.live_rounds` + `service.visible_items`), el mismo objetivo
  (`service.target_minutes_for`) y el mismo color (`service.semaphore`).
  Lo consume el panel del administrador (`app.reports.panel`): si el KDS
  pinta un plato en rojo, el panel lo cuenta como atrasado, y al revés.
- `prep_times_by_station(db, store, business_date)` — el tiempo promedio de
  «Enviar» a «Listo» por estación en el día (auditoría p4), con el mismo
  objetivo por estación del semáforo. Lo publica Hoy.

Este dominio no importa `app.reports`: la dependencia va en un solo sentido.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

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
    station_targets = settings.station_target_minutes or {}
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
                elapsed, service.target_minutes_for(course_targets, course=item.course, station=item.station, station_targets=station_targets)
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


@dataclass(frozen=True)
class KitchenTicket:
    """Un tiquete (ronda) que sigue en cocina: los minutos de su plato más
    viejo todavía sin «Listo», con la misma lectura del KDS."""

    round_id: int
    order_id: int
    channel: str
    tables: list[str]
    minutes: int


def kitchen_tickets(db: Session, *, store: Store) -> list[KitchenTicket] | None:
    """Los tiquetes abiertos de la cocina, más viejos primero. `None` con la
    función «Cocina» apagada (no hay cola que mostrar, que no es «cero
    tiquetes»). Mismas rondas y mismos platos que `kitchen_load`."""
    if not features.is_enabled(db, store.organization_id, store.id, "kitchen.view"):
        return None
    now = clock.now_utc()
    out: list[KitchenTicket] = []
    for round_row, order in service.live_rounds(db, store_id=store.id):
        items = list(
            db.execute(
                select(OrderItem).where(
                    OrderItem.round_id == round_row.id,
                    OrderItem.status.in_([OrderItemStatus.SENT, OrderItemStatus.READY]),
                )
            ).scalars()
        )
        sent = [
            i.sent_at
            for i in service.visible_items(order, items, now=now)
            if i.status == OrderItemStatus.SENT and i.sent_at is not None
        ]
        if not sent:
            continue
        elapsed = int((now - min(sent)).total_seconds())
        out.append(
            KitchenTicket(
                round_id=round_row.id,
                order_id=order.id,
                channel=getattr(order.channel, "value", str(order.channel)),
                tables=service.tables_for_order(db, order_id=order.id),
                minutes=elapsed // 60,
            )
        )
    out.sort(key=lambda t: (-t.minutes, t.round_id))
    return out


@dataclass(frozen=True)
class StationPrepTime:
    """Lo que tardó una estación hoy, de «Enviar» a «Listo» (auditoría p4).

    `avg_seconds` es el promedio entero (piso) de `ready_at − sent_at` de
    los platos que cocina marcó listos en el día operativo; `items` cuántos
    son. `outside` lo decide el servidor: el promedio pasó el objetivo de la
    estación (el mismo `service.target_minutes_for` del semáforo del KDS)."""

    station: str
    items: int
    avg_seconds: int
    target_minutes: int
    outside: bool


def prep_times_by_station(db: Session, *, store: Store, business_date: date) -> list[StationPrepTime] | None:
    """Tiempo promedio de preparación por estación en el día operativo.

    `None` con la función «Cocina» apagada (no hay cola que medir, que no
    es «cero minutos»). Una estación sin ningún plato listo hoy no aparece:
    no hay promedio que publicar, y un `0` sería un cero mudo. Los platos
    anulados no cuentan; los que pasaron directo a servidos (sin estación)
    tampoco, porque nunca estuvieron en cocina."""
    from app.orders.models import Order

    if not features.is_enabled(db, store.organization_id, store.id, "kitchen.view"):
        return None
    settings = stores_service.get_sales_settings(db, store.id)
    station_targets = settings.station_target_minutes or {}
    rows = db.execute(
        select(OrderItem.station, OrderItem.sent_at, OrderItem.ready_at)
        .join(Order, Order.id == OrderItem.order_id)
        .where(
            Order.store_id == store.id,
            Order.business_date == business_date,
            OrderItem.station.is_not(None),
            OrderItem.sent_at.is_not(None),
            OrderItem.ready_at.is_not(None),
            OrderItem.voided_at.is_(None),
        )
    ).all()
    totals: dict[str, list[int]] = {}
    for station, sent_at, ready_at in rows:
        seconds = max(int((ready_at - sent_at).total_seconds()), 0)
        bucket = totals.setdefault(station, [0, 0])
        bucket[0] += seconds
        bucket[1] += 1
    out: list[StationPrepTime] = []
    for station, (total_seconds, count) in sorted(totals.items()):
        avg = total_seconds // count
        target = service.target_minutes_for({}, course=None, station=station, station_targets=station_targets)
        out.append(
            StationPrepTime(
                station=station, items=count, avg_seconds=avg, target_minutes=target, outside=avg > target * 60
            )
        )
    return out
