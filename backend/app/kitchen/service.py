"""Lógica del KDS completo (`kitchen.kds`, pedido 2c).

CONTRATO C1 (`app/orders/hooks.py`, territorio `backend-canales-comanda`):
este módulo **nunca** escribe `OrderItem.status` ni ningún campo de
`app.orders.models` a mano. Toda escritura sobre la comanda pasa por
`bump_item`/`unbump_item`/`expedite_order`/`fired_at_by_course`, resueltas
con `app.core.modules.find_spec_safe` — nunca un `import app.orders.hooks`
directo (§ misión). `_orders_hooks()` es el único punto de entrada a esas
cuatro funciones; si la firma publicada cambia o el módulo desaparece, esta
función es la que grita (`RuntimeError`, nunca un fallback silencioso ni una
copia de la lógica acá adentro).

Lo que SÍ escribe este módulo son sus dos tablas propias
(`app/kitchen/models.py`): quién bumpeó qué y cuándo
(`KitchenBumpEvent`), y el registro de impresión por estación
(`KitchenPrintJob`) — el trabajo que un driver real consumiría mañana, no
un driver (§13, fase 3 tiene la impresora térmica real).
"""

from __future__ import annotations

import importlib
from datetime import datetime
from typing import TYPE_CHECKING, Any, Protocol, cast

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.errors import NotFoundError
from app.core.modules import find_spec_safe
from app.kitchen.models import KitchenBumpAction, KitchenBumpEvent, KitchenPrintJob
from app.kitchen.schemas import (
    EmployeeRef,
    KitchenExpediteItemOut,
    KitchenExpediteOut,
    KitchenItemStateOut,
    KitchenPrintJobItemOut,
    KitchenPrintJobOut,
)
from app.core import tz
from app.orders.models import Order, OrderItem, OrderItemStatus, OrderRound, OrderStatus, OrderTable
from app.stores.models import Store, Table

if TYPE_CHECKING:
    from app.auth.deps import Actor


# ---------------------------------------------------------------------------
# CONTRATO C1: el único punto de entrada a `app.orders.hooks`.
# ---------------------------------------------------------------------------


class _OrdersHooksContract(Protocol):
    """La forma exacta que `backend-kds` verificó contra
    `app/orders/hooks.py` (leído completo antes de escribir esta línea).
    Un `Protocol` en vez de tipar el `ModuleType` a mano: al hacer
    `cast(_OrdersHooksContract, module)` más abajo, `mypy` sigue chequeando
    cada sitio donde este módulo LLAMA a `bump_item`/`unbump_item`/
    `expedite_order`/`fired_at_by_course` contra esta firma — así el
    typecheck grita si algún llamado de acá deja de encajar, aunque el
    `import` en sí sea dinámico."""

    def bump_item(self, db: Session, *, item_id: int, store_id: int, actor: "Actor", now: datetime) -> bool: ...

    def unbump_item(self, db: Session, *, item_id: int, store_id: int, actor: "Actor", now: datetime) -> bool: ...

    def expedite_order(
        self, db: Session, *, order_id: int, store_id: int, actor: "Actor", now: datetime
    ) -> list[int]: ...

    def fired_at_by_course(self, db: Session, *, order_id: int) -> dict[str, datetime]: ...


def _orders_hooks() -> _OrdersHooksContract:
    if find_spec_safe("app.orders.hooks") is None:
        # `app.orders` no es un dominio opcional (existe desde 1b-1): que
        # falte acá es un despliegue roto, no una regla de negocio — por
        # eso es un `RuntimeError` (-> `500 INTERNAL_ERROR` genérico, nunca
        # un `AppError` de 4xx) y no un `return` silencioso con un
        # fallback inventado.
        raise RuntimeError(
            "CONTRATO C1 roto: app.orders.hooks no existe. kitchen.kds depende de "
            "bump_item/unbump_item/expedite_order/fired_at_by_course "
            "(backend-canales-comanda, ver features/fase-2c-canales-cocina/spec.md)."
        )
    module = importlib.import_module("app.orders.hooks")
    return cast(_OrdersHooksContract, module)


# ---------------------------------------------------------------------------
# Atribución propia: quién bumpeó cada ítem (para que el KDS la muestre sin
# que `app.orders` tenga que cargar con un campo que sólo kitchen necesita).
# ---------------------------------------------------------------------------


def _latest_bumper(db: Session, *, item_id: int) -> EmployeeRef | None:
    row = db.execute(
        select(KitchenBumpEvent.employee_id, KitchenBumpEvent.employee_name)
        .where(
            KitchenBumpEvent.item_id == item_id,
            KitchenBumpEvent.to_status == OrderItemStatus.READY.value,
        )
        .order_by(KitchenBumpEvent.at.desc())
    ).first()
    if row is None:
        return None
    employee_id, employee_name = row
    return EmployeeRef(id=employee_id, name=employee_name)


def _bumpers_by_item(db: Session, *, item_ids: list[int]) -> dict[int, EmployeeRef]:
    """Como `_latest_bumper`, pero para varios ítems de un solo golpe (usado
    al enriquecer `GET /kitchen/rounds`): evita N consultas, una por ítem."""
    if not item_ids:
        return {}
    rows = db.execute(
        select(KitchenBumpEvent.item_id, KitchenBumpEvent.employee_id, KitchenBumpEvent.employee_name, KitchenBumpEvent.at)
        .where(
            KitchenBumpEvent.item_id.in_(item_ids),
            KitchenBumpEvent.to_status == OrderItemStatus.READY.value,
        )
        .order_by(KitchenBumpEvent.at.asc())
    ).all()
    out: dict[int, EmployeeRef] = {}
    for item_id, employee_id, employee_name, _at in rows:
        out[item_id] = EmployeeRef(id=employee_id, name=employee_name)  # el último de la lista (orden asc) gana
    return out


# ---------------------------------------------------------------------------
# Bump / unbump / expedición — las tres pasan por CONTRATO C1.
# ---------------------------------------------------------------------------


def bump_item(db: Session, *, item_id: int, store_id: int, actor: "Actor", now: datetime) -> KitchenItemStateOut:
    item = db.get(OrderItem, item_id)
    if item is None or item.store_id != store_id:
        raise NotFoundError("El ítem no existe en esta sede")
    from_status = item.status.value

    changed = _orders_hooks().bump_item(db, item_id=item_id, store_id=store_id, actor=actor, now=now)
    db.refresh(item)

    if changed:
        db.add(
            KitchenBumpEvent(
                organization_id=item.organization_id,
                store_id=item.store_id,
                order_id=item.order_id,
                item_id=item.id,
                action=KitchenBumpAction.BUMP,
                from_status=from_status,
                to_status=item.status.value,
                employee_id=actor.employee_id,  # type: ignore[arg-type]
                employee_name=actor.employee_name,  # type: ignore[arg-type]
                at=now,
            )
        )
        db.flush()

    is_ready = item.status == OrderItemStatus.READY
    return KitchenItemStateOut(
        item_id=item.id,
        order_id=item.order_id,
        status=item.status.value,
        ready_at=item.ready_at,
        changed=changed,
        bumped_by=_latest_bumper(db, item_id=item.id) if is_ready else None,
        bumped_at=item.ready_at if is_ready else None,
    )


def unbump_item(db: Session, *, item_id: int, store_id: int, actor: "Actor", now: datetime) -> KitchenItemStateOut:
    item = db.get(OrderItem, item_id)
    if item is None or item.store_id != store_id:
        raise NotFoundError("El ítem no existe en esta sede")
    from_status = item.status.value

    changed = _orders_hooks().unbump_item(db, item_id=item_id, store_id=store_id, actor=actor, now=now)
    db.refresh(item)

    if changed:
        db.add(
            KitchenBumpEvent(
                organization_id=item.organization_id,
                store_id=item.store_id,
                order_id=item.order_id,
                item_id=item.id,
                action=KitchenBumpAction.UNBUMP,
                from_status=from_status,
                to_status=item.status.value,
                employee_id=actor.employee_id,  # type: ignore[arg-type]
                employee_name=actor.employee_name,  # type: ignore[arg-type]
                at=now,
            )
        )
        db.flush()

    is_ready = item.status == OrderItemStatus.READY
    return KitchenItemStateOut(
        item_id=item.id,
        order_id=item.order_id,
        status=item.status.value,
        ready_at=item.ready_at,
        changed=changed,
        bumped_by=_latest_bumper(db, item_id=item.id) if is_ready else None,
        bumped_at=item.ready_at if is_ready else None,
    )


def expedite_order(db: Session, *, order_id: int, store_id: int, actor: "Actor", now: datetime) -> KitchenExpediteOut:
    order = db.get(Order, order_id)
    if order is None or order.store_id != store_id:
        raise NotFoundError("La comanda no existe en esta sede")

    changed_ids = _orders_hooks().expedite_order(db, order_id=order_id, store_id=store_id, actor=actor, now=now)

    items_out: list[KitchenExpediteItemOut] = []
    if changed_ids:
        rows = list(db.execute(select(OrderItem).where(OrderItem.id.in_(changed_ids)).order_by(OrderItem.id)).scalars())
        for item in rows:
            db.add(
                KitchenBumpEvent(
                    organization_id=item.organization_id,
                    store_id=item.store_id,
                    order_id=item.order_id,
                    item_id=item.id,
                    action=KitchenBumpAction.EXPEDITE,
                    from_status=OrderItemStatus.SENT.value,
                    to_status=item.status.value,
                    employee_id=actor.employee_id,  # type: ignore[arg-type]
                    employee_name=actor.employee_name,  # type: ignore[arg-type]
                    at=now,
                )
            )
            items_out.append(
                KitchenExpediteItemOut(item_id=item.id, name=item.name, status=item.status.value, station=item.station)
            )
        db.flush()

    return KitchenExpediteOut(
        order_id=order_id,
        changed=bool(changed_ids),
        changed_item_ids=changed_ids,
        items=items_out,
        expedited_by=EmployeeRef(id=actor.employee_id, name=actor.employee_name),  # type: ignore[arg-type]
        expedited_at=now,
    )


# ---------------------------------------------------------------------------
# El orden respeta «marchar» (`fired_at_by_course`, lectura de CONTRATO C1) y
# la atribución del bump — enriquecimiento de `GET /kitchen/rounds` cuando
# `kitchen.kds` está encendida. `_semaphore`/la lectura de rondas siguen
# siendo de `app.kitchen.router` (no se duplican acá); esta función sólo
# REORDENA la lista de ítems ya armada y le agrega las claves nuevas.
# ---------------------------------------------------------------------------


def _course_sort_key(item: OrderItem, fired: dict[str, datetime]) -> tuple[int, datetime]:
    """`0, fired_at` para un curso YA marchado (se ordena por cuándo se
    marchó: el primero en marchar es el primero en cocinarse); `1, sent_at`
    para uno que no — nunca se adelanta a uno marchado (bucket `1` siempre
    va después del `0`), y entre ítems sin marchar se conserva el orden de
    envío. Un restaurante que nunca usa "marchar" (`fired` vacío para toda
    comanda) deja TODO en el bucket `1`: el orden queda igual al de
    `sent_at`, que es el de hoy — «marchar» no le cambia nada a quien no lo
    usa."""
    fired_at = fired.get(item.course)
    if fired_at is not None:
        return (0, fired_at)
    fallback = item.sent_at if item.sent_at is not None else item.created_at
    return (1, fallback)


def enrich_round_for_kds(
    db: Session,
    *,
    order: Order,
    items: list[OrderItem],
    items_out: list[dict[str, Any]],
    round_out: dict[str, Any],
) -> None:
    """Muta `round_out`/`items_out` (las mismas listas que ya arma
    `get_kitchen_rounds`) IN PLACE: agrega canal (plataforma) y, por ítem,
    `course_fired_at`/`bumped_by`/`bumped_at`, y reordena `items_out` (y su
    clave `"items"` en `round_out`) respetando `fired_at_by_course`. Se
    llama sólo cuando `kitchen.kds` está encendida — con la flag apagada
    `get_kitchen_rounds` nunca invoca esto y la respuesta de 1b queda
    idéntica."""
    fired = _orders_hooks().fired_at_by_course(db, order_id=order.id)
    bumpers = _bumpers_by_item(db, item_ids=[i.id for i in items if i.status == OrderItemStatus.READY])

    for item, item_out in zip(items, items_out, strict=True):
        item_out["course_fired_at"] = fired.get(item.course)
        is_ready = item.status == OrderItemStatus.READY
        bumper = bumpers.get(item.id) if is_ready else None
        item_out["bumped_by"] = {"id": bumper.id, "name": bumper.name} if bumper is not None else None
        item_out["bumped_at"] = item.ready_at if is_ready else None

    paired = sorted(zip(items, items_out, strict=True), key=lambda pair: _course_sort_key(pair[0], fired))
    round_out["items"] = [item_out for _, item_out in paired]

    if order.channel.value == "platform":
        round_out["platform"] = {"source": order.platform_name, "external_id": order.platform_external_id}
    else:
        round_out["platform"] = None


# ---------------------------------------------------------------------------
# Impresión por estación — el TRABAJO (qué se imprimiría, para qué
# estación, cuándo, y su registro), no un driver. Acá termina lo que
# construye este pedido: un driver real reemplazaría `register_print_job`
# por la llamada a la impresora térmica y seguiría escribiendo la MISMA
# fila (§13, fase 3 es la impresora y el cajón monedero).
# ---------------------------------------------------------------------------


def tables_for_order(db: Session, *, order_id: int) -> list[str]:
    return [
        t.number
        for t in db.execute(
            select(Table)
            .join(OrderTable, OrderTable.table_id == Table.id)
            .where(OrderTable.order_id == order_id, OrderTable.released_at.is_(None))
        ).scalars()
    ]


# ---------------------------------------------------------------------------
# Qué sigue siendo trabajo de cocina.
# ---------------------------------------------------------------------------

_DEAD_ORDER_STATUSES = (OrderStatus.VOIDED, OrderStatus.MERGED, OrderStatus.COMPENSATED)


def live_rounds(db: Session, *, store_id: int) -> list[tuple[OrderRound, Order]]:
    """Las rondas que la cocina todavía tiene que ver, más viejas primero.

    Antes se leían TODAS las rondas de la sede desde el primer día: un plato
    que cocina despachó (`ready`) y que nadie marcó `served` se quedaba en el
    KDS para siempre. A las dos semanas de operación eran 460 rondas en rojo
    con 14 días de «espera» (lo encontró `python -m app.demo`). Reglas:

    - una comanda anulada, fusionada o compensada ya no es trabajo;
    - de días operativos anteriores sólo sigue lo que está abierto (una
      comanda trasladada de turno); lo cobrado de ayer ya salió;
    - lo cobrado de HOY sí sigue, porque en mostrador se cobra antes de
      cocinar — pero sólo lo pendiente (`sent`), ver `visible_items`.
    """
    store = db.get(Store, store_id)
    today = tz.today_business_date(store.cutoff_hour) if store is not None else None
    stmt = (
        select(OrderRound, Order)
        .join(Order, OrderRound.order_id == Order.id)
        .where(Order.store_id == store_id, Order.status.not_in(_DEAD_ORDER_STATUSES))
        .order_by(OrderRound.sent_at)
    )
    if today is not None:
        stmt = stmt.where(
            or_(Order.status.in_((OrderStatus.OPEN, OrderStatus.TO_PAY)), Order.business_date == today)
        )
    return [(round_row, order) for round_row, order in db.execute(stmt).all()]


def visible_items(order: Order, items: list[OrderItem]) -> list[OrderItem]:
    """De una comanda ya cobrada, cocina sólo ve lo que le falta preparar:
    lo `ready` ya se entregó con la cuenta."""
    if order.status == OrderStatus.PAID:
        return [item for item in items if item.status == OrderItemStatus.SENT]
    return items


def _station_dockets(db: Session, *, store_id: int, station: str | None) -> list[tuple[OrderRound, Order, str, list[OrderItem]]]:
    """Un docket = una (ronda, estación) con al menos un ítem `sent`/`ready`
    para esa estación. Un ítem sin estación nunca llega SENT/READY
    (`app.orders.service._apply_send`: pasa directo a `served`), así que
    agrupar por `item.station` acá es seguro sin filtrar `None` a mano."""
    out: list[tuple[OrderRound, Order, str, list[OrderItem]]] = []
    for round_row, order in live_rounds(db, store_id=store_id):
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
        items = visible_items(order, items)
        by_station: dict[str, list[OrderItem]] = {}
        for item in items:
            if item.station is None:
                continue
            by_station.setdefault(item.station, []).append(item)
        for st, st_items in by_station.items():
            if station is not None and st != station:
                continue
            out.append((round_row, order, st, st_items))
    return out


def _print_out(
    db: Session, *, round_row: OrderRound, order: Order, station: str, items: list[OrderItem]
) -> KitchenPrintJobOut:
    last = db.execute(
        select(KitchenPrintJob)
        .where(KitchenPrintJob.round_id == round_row.id, KitchenPrintJob.station == station)
        .order_by(KitchenPrintJob.printed_at.desc())
    ).scalars().first()
    count = db.execute(
        select(func.count())
        .select_from(KitchenPrintJob)
        .where(KitchenPrintJob.round_id == round_row.id, KitchenPrintJob.station == station)
    ).scalar_one()
    return KitchenPrintJobOut(
        order_id=order.id,
        round_id=round_row.id,
        round_no=round_row.round_no,
        station=station,
        channel=order.channel.value,
        tables=tables_for_order(db, order_id=order.id),
        items=[
            KitchenPrintJobItemOut(item_id=i.id, name=i.name, qty=i.qty, modifiers_text=i.modifiers_text, note=i.note)
            for i in items
        ],
        item_count=len(items),
        printed=last is not None,
        printed_at=last.printed_at if last is not None else None,
        printed_by=EmployeeRef(id=last.printed_by_employee_id, name=last.printed_by_employee_name) if last is not None else None,
        print_count=count,
    )


def list_print_jobs(db: Session, *, store_id: int, station: str | None) -> list[KitchenPrintJobOut]:
    return [
        _print_out(db, round_row=round_row, order=order, station=st, items=items)
        for round_row, order, st, items in _station_dockets(db, store_id=store_id, station=station)
    ]


def register_print_job(
    db: Session, *, store_id: int, round_id: int, station: str, actor: "Actor", now: datetime
) -> KitchenPrintJobOut:
    round_row = db.get(OrderRound, round_id)
    if round_row is None:
        raise NotFoundError("La ronda no existe")
    order = db.get(Order, round_row.order_id)
    if order is None or order.store_id != store_id:
        raise NotFoundError("La ronda no existe en esta sede")

    items = list(
        db.execute(
            select(OrderItem)
            .where(
                OrderItem.round_id == round_id,
                OrderItem.station == station,
                OrderItem.status.in_([OrderItemStatus.SENT, OrderItemStatus.READY]),
            )
            .order_by(OrderItem.id)
        ).scalars()
    )
    # Estación sin ítems pendientes en esta ronda: no es un error (mismo
    # criterio que `expedite_order` con `changed_item_ids=[]`), se registra
    # igual con `item_count=0` — el llamador decide si eso vale la pena
    # mostrar como "nada para imprimir".
    db.add(
        KitchenPrintJob(
            organization_id=order.organization_id,
            store_id=store_id,
            order_id=order.id,
            round_id=round_id,
            station=station,
            item_count=len(items),
            printed_at=now,
            printed_by_employee_id=actor.employee_id,  # type: ignore[arg-type]
            printed_by_employee_name=actor.employee_name,  # type: ignore[arg-type]
        )
    )
    db.flush()
    return _print_out(db, round_row=round_row, order=order, station=station, items=items)
