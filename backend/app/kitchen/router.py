"""Vista de cocina mínima (`CONTRATO-INTERNO-1b-1.md §2.4` «Cocina»).

`app/kitchen` no tiene modelos propios (§0 del contrato): lee directamente
`app.orders.models` (rondas e ítems `sent`/`ready`) y `StoreSalesSettings`
(tiempos objetivo por curso) para armar el semáforo. El `ready` de un ítem
vive en `app.orders.router` (`POST /orders/{id}/items/{item_id}/ready`), no acá.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.deps import Actor, current_device
from app.core import clock, features
from app.core.db import get_db
from app.orders.models import Order, OrderItem, OrderItemStatus, OrderRound, OrderTable
from app.stores import service as stores_service
from app.stores.models import Table

router = APIRouter()


def _semaphore(elapsed_seconds: int, target_minutes: int | None) -> str:
    if target_minutes is None:
        return "green"
    target_seconds = target_minutes * 60
    if elapsed_seconds < target_seconds:
        return "green"
    # `elapsed < 1.5 * target` sin float: `elapsed * 2 < target * 3`.
    if elapsed_seconds * 2 < target_seconds * 3:
        return "amber"
    return "red"


@router.get("/kitchen/rounds")
def get_kitchen_rounds(
    station: str | None = Query(None), actor: Actor = Depends(current_device), db: Session = Depends(get_db)
) -> list[dict[str, Any]]:
    # `features.require_feature(...)` como *dependency* exige un operador
    # identificado (resuelve `current_actor` -> `current_operator` por
    # dentro), pero esta ruta es de lectura de dispositivo con persona
    # OPCIONAL (una pantalla de cocina no tiene por qué tener a alguien
    # identificado): se valida la función a mano, sobre el actor real.
    features.assert_feature(db, actor.organization_id, actor.store_id, "kitchen.view")
    store_id = actor.store_id
    settings = stores_service.get_sales_settings(db, store_id)  # type: ignore[arg-type]
    course_targets = settings.course_target_minutes or {}
    now = clock.now_utc()

    rounds = list(
        db.execute(
            select(OrderRound)
            .join(Order, OrderRound.order_id == Order.id)
            .where(Order.store_id == store_id)
            .order_by(OrderRound.sent_at)
        ).scalars()
    )

    out: list[dict[str, Any]] = []
    for round_row in rounds:
        order = db.get(Order, round_row.order_id)
        if order is None:
            continue
        items_stmt = select(OrderItem).where(
            OrderItem.round_id == round_row.id, OrderItem.status.in_([OrderItemStatus.SENT, OrderItemStatus.READY])
        )
        if station:
            items_stmt = items_stmt.where(OrderItem.station == station)
        items = list(db.execute(items_stmt.order_by(OrderItem.id)).scalars())
        if not items:
            continue

        items_out: list[dict[str, Any]] = []
        for item in items:
            elapsed_seconds = int((now - item.sent_at).total_seconds()) if item.sent_at is not None else 0
            target_minutes = course_targets.get(item.course)
            items_out.append(
                {
                    "item_id": item.id,
                    "name": item.name,
                    "qty": item.qty,
                    "modifiers_text": item.modifiers_text,
                    "note": item.note,
                    "course": item.course,
                    "station": item.station,
                    "status": item.status.value,
                    "elapsed_seconds": elapsed_seconds,
                    "target_minutes": target_minutes,
                    "semaphore": _semaphore(elapsed_seconds, target_minutes),
                }
            )

        tables = [
            t.number
            for t in db.execute(
                select(Table)
                .join(OrderTable, OrderTable.table_id == Table.id)
                .where(OrderTable.order_id == order.id, OrderTable.released_at.is_(None))
            ).scalars()
        ]

        out.append(
            {
                "order_id": order.id,
                "round_no": round_row.round_no,
                "sent_at": round_row.sent_at,
                "elapsed_seconds": int((now - round_row.sent_at).total_seconds()),
                "channel": order.channel.value,
                "tables": tables,
                "takeout_name": order.takeout_customer_name,
                "covers": order.covers,
                "items": items_out,
            }
        )

    return out
