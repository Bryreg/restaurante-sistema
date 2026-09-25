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

from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.audit.service import record_audit
from app.core import clock
from app.core.errors import ConflictError, NotFoundError
from app.core.modules import find_spec_safe
from app.orders.models import (
    Order,
    OrderChannel,
    OrderCourseFire,
    OrderEvent,
    OrderItem,
    OrderItemStatus,
    OrderStatus,
)

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


# ---------------------------------------------------------------------------
# Pedido 2a: el espejo exacto de la nota «vuelve» (SPEC-NEGOCIO §5.3).
#
# **Por qué se construye desde el libro (`StockMovement`) y no desde la
# ficha actual**: la ficha de un producto versiona y puede cambiar entre el
# envío y la nota (SPEC-NEGOCIO §4.3, la regla dura del snapshot). Si esta
# función volviera a llamar `app.recipes.hooks.expand_consumption` con la
# ficha de HOY, una venta de la v1 que se revierte después de guardar la v2
# se descontaría/repondría con cantidades y costos de la v2 — exactamente lo
# que la regla "ningún reporte revalora una venta pasada con la ficha
# actual" prohíbe, aplicada acá a la reversión en vez de a un reporte. Leer
# los movimientos `cause=SALE` con `ref_type="order_item"`/`ref_id=item.id`
# (la MISMA clave con la que `_apply_send` los escribió; ver
# `app.orders.service._freeze_item_consumption`) y negarlos exactamente
# hace el espejo posible **por construcción**: la suma de lo que se escribe
# acá siempre cancela exactamente la suma de lo que ya existía, sin
# importar si la ficha cambió entremedio. `cause=NOTE_RETURN` (no `SALE`)
# para que el movimiento nuevo no se fusione con el original (la fusión de
# `record_movement` exige la MISMA causa) y quede trazable como reversión.
#
# **Dueño del test de punta a punta**: este territorio (`backend-consumo`),
# `tests/orders/test_consumption.py` (llamada directa, ficha cambiada
# entremedio) y, desde la ronda 2 (conciliador, B-1), también
# `tests/fiscal/test_notes.py` (el camino HTTP real). Esta función es el
# "espejo"; el llamador real es `app.fiscal.service.issue_note`
# (`returns_to_stock` por línea de `NoteLineIn`, default `True` — SPEC-NEGOCIO
# §3.5 escribe "se usó" como la excepción marcada; una nota `kind="debit"`
# fuerza `False` en todas sus líneas, nunca revierte). `app/fiscal/**` se
# amplió al territorio de `backend-consumo` sólo para esta ronda y sólo para
# esta conexión — ver `docs/ESTADO.md § Ronda 2 del conciliador`.
# ---------------------------------------------------------------------------


def reverse_item_consumption(
    db: Session, *, item: OrderItem, actor: "Actor", now: datetime
) -> list[Any]:
    """Espejo exacto del consumo ya registrado para `item` (SPEC-NEGOCIO
    §5.3). Protegida con `find_spec_safe`: si `app.inventory` no está
    montado (`inventory.perpetual` nunca se activó, o el módulo ni existe
    en este árbol) no hay libro que revertir y devuelve `[]` sin escribir
    nada — nunca lanza.

    No recibe `ConsumptionPlan`: **no vuelve a calcular nada**, sólo lee y
    niega lo que el libro ya tiene. Devuelve los `StockMovement` nuevos
    (uno por línea revertida), para que el llamador pueda auditar/mostrar
    cuánto se revirtió si lo necesita.
    """
    if find_spec_safe("app.inventory.hooks") is None or find_spec_safe("app.inventory.models") is None:
        return []

    import importlib

    inv_hooks = importlib.import_module("app.inventory.hooks")
    inv_models = importlib.import_module("app.inventory.models")

    original_rows = list(
        db.execute(
            select(inv_models.StockMovement).where(
                inv_models.StockMovement.store_id == item.store_id,
                inv_models.StockMovement.ref_type == "order_item",
                inv_models.StockMovement.ref_id == item.id,
                inv_models.StockMovement.cause == inv_models.MovementCause.SALE,
            )
        ).scalars()
    )

    reversed_rows: list[Any] = []
    for row in original_rows:
        if row.qty_base == 0:
            continue  # defensivo: `record_movement` nunca debería dejar esto, pero un 0 rompería el CHECK al negarlo.
        reversed_rows.append(
            inv_hooks.record_movement(
                db,
                organization_id=row.organization_id,
                store_id=row.store_id,
                ingredient_id=row.ingredient_id,
                preparation_id=row.preparation_id,
                qty_base=-row.qty_base,
                cause=inv_models.MovementCause.NOTE_RETURN,
                cost_micros=row.cost_micros,
                cost_source=row.cost_source,
                actor=actor,
                business_date=row.business_date,
                at=now,
                ref_type="order_item",
                ref_id=item.id,
                note="Reversión por nota (espejo exacto del consumo original)",
            )
        )
    return reversed_rows


# ---------------------------------------------------------------------------
# Pedido 2c — CONTRATO C1: lo que publica este agente para el KDS
# (`kitchen.kds`, territorio de `backend-kds`, que LLAMA estas cuatro
# funciones). Regla del contrato, escrita acá y en la misión de
# `backend-kds`: `backend-kds` NUNCA escribe `OrderItem.status` ni ningún
# campo de `app.orders.models` a mano — todas sus escrituras pasan por acá.
# Si alguna firma cambia, es este agente quien lo declara en su entregable
# con el nombre del agente afectado (`backend-kds`).
# ---------------------------------------------------------------------------


def bump_item(db: Session, *, item_id: int, store_id: int, actor: "Actor", now: datetime) -> bool:
    """El «bump» de un ítem desde el KDS: `sent -> ready` — reutiliza
    EXACTAMENTE la transición de `app.orders.service.mark_ready` (no se
    duplica; este módulo no importa `service` para evitar el ciclo del
    docstring de arriba, así que la transición se repite acá a mano, pero es
    la misma lógica: sólo avanza desde `sent`).

    Idempotente: si el ítem ya está `ready`/`served`/`voided` (o `pending`,
    nunca enviado) devuelve `False` sin tocar nada y sin error — un bump
    repetido en hora pico no puede romper nada. `item_id`/`store_id` que no
    resuelven a un ítem real de esta sede son un error real (`404`), no un
    "ya estaba hecho": el KDS mandó una clave que no existe."""
    item = db.get(OrderItem, item_id)
    if item is None or item.store_id != store_id:
        raise NotFoundError("El ítem no existe en esta sede")
    if item.status != OrderItemStatus.SENT:
        return False
    item.status = OrderItemStatus.READY
    item.ready_at = now
    db.flush()
    return True


def unbump_item(db: Session, *, item_id: int, store_id: int, actor: "Actor", now: datetime) -> bool:
    """Deshacer un `bump_item`: `ready -> sent`, misma semántica idempotente
    ("qué pasa cuando se deshace" — existe porque un bump equivocado en hora
    pico es inevitable). `False` sin error si el ítem no está `ready` (ya
    fue más allá, o nunca se bumpeó)."""
    item = db.get(OrderItem, item_id)
    if item is None or item.store_id != store_id:
        raise NotFoundError("El ítem no existe en esta sede")
    if item.status != OrderItemStatus.READY:
        return False
    item.status = OrderItemStatus.SENT
    item.ready_at = None
    db.flush()
    return True


def expedite_order(db: Session, *, order_id: int, store_id: int, actor: "Actor", now: datetime) -> list[int]:
    """Expedición de la comanda completa: bumpea TODOS los ítems `sent` de la
    comanda a `ready` en un solo golpe (equivalente a `bump_item` ítem por
    ítem, pero atómico). Devuelve los ids que DE VERDAD cambiaron — una
    comanda sin ítems `sent` (ya expedida, o ninguno enviado todavía)
    devuelve `[]` sin error: no hay nada que expedir no es un fallo."""
    return _expedite_sent_items(db, order_id=order_id, store_id=store_id, station=None, now=now)


def expedite_station(
    db: Session, *, order_id: int, store_id: int, station: str, actor: "Actor", now: datetime
) -> list[int]:
    """Expedición de UNA estación de la comanda: como `expedite_order`, pero
    sólo los ítems `sent` cuya `station` es la pedida. Es lo que usa el KDS
    cuando la pantalla está filtrada por estación: «Expedir» desde «Cocina
    caliente» marcaba listas también las cervezas del bar y las empanadas de
    cocina fría de la misma comanda (caso real, comanda 464)."""
    return _expedite_sent_items(db, order_id=order_id, store_id=store_id, station=station, now=now)


def _expedite_sent_items(
    db: Session, *, order_id: int, store_id: int, station: str | None, now: datetime
) -> list[int]:
    stmt = select(OrderItem).where(
        OrderItem.order_id == order_id,
        OrderItem.store_id == store_id,
        OrderItem.status == OrderItemStatus.SENT,
    )
    if station is not None:
        stmt = stmt.where(OrderItem.station == station)
    items = list(db.execute(stmt.order_by(OrderItem.id)).scalars())
    changed_ids: list[int] = []
    for item in items:
        item.status = OrderItemStatus.READY
        item.ready_at = now
        changed_ids.append(item.id)
    if changed_ids:
        db.flush()
    return changed_ids


def fired_at_by_course(db: Session, *, order_id: int) -> dict[str, datetime]:
    """Lectura pura de `app.orders.models.OrderCourseFire` (`{course:
    fired_at}`) para que el KDS ordene por marchado sin duplicar este
    modelo. `app.orders.service.fire_course` es la única escritura."""
    rows = db.execute(
        select(OrderCourseFire.course, OrderCourseFire.fired_at).where(OrderCourseFire.order_id == order_id)
    ).all()
    return {course: fired_at for course, fired_at in rows}


# ---------------------------------------------------------------------------
# Pedido 2c — CONTRATO C4: lo que llama `backend-dinero-canales` cuando una
# venta de plataforma se cancela DESPUÉS de preparar. Es la regla más fácil
# de romper de todo el pedido (SPEC-NEGOCIO §3.3, checklist de la spec):
# compensa la VENTA, nunca genera una merma. El insumo ya se descontó al
# enviar (`app.orders.service._freeze_item_consumption`, dentro de
# `_apply_send`) y se QUEDA descontado — por diseño esta función no importa
# `void_item` ni `_resolve_waste_stub` (`app.orders.service`, ninguno de los
# dos existe en este módulo) ni `app.inventory` de ningún modo: no escribe
# NINGÚN `StockMovement`, ni revierte, ni repone. Confundirlo metería en el
# reporte de mermas algo que no lo es y falsearía el KPI de mermas ÷ compras
# que 2b acaba de construir — es exactamente el test que este agente deja en
# `tests/orders/test_platform_cancel.py`.
# ---------------------------------------------------------------------------


def mark_platform_order_cancelled(
    db: Session, *, order: Order, actor: "Actor", now: datetime, reason: str
) -> Order:
    """Deja la comanda en `OrderStatus.COMPENSATED` con motivo y
    auditoría — nunca en `VOIDED` (ver el docstring de ese estado en
    `app.orders.models`: `void_order`/`void_item` sólo trabajan sobre
    `OPEN`/`TO_PAY` y crean `WasteStub`; una venta de plataforma cancelada
    después de preparar suele llegar acá `PAID`, porque la plataforma ya
    cobró). NO toca `OrderItem` en absoluto: lo que se preparó, se preparó,
    y su `status`/`sent_at`/consumo teórico quedan intactos — es el registro
    de lo que de verdad pasó en cocina, y "compensar la venta" es un asunto
    del pedido y del documento fiscal (territorio de quien llama), no de los
    ítems.

    Idempotente: si la comanda YA está `COMPENSATED`, devuelve la
    comanda tal cual, sin duplicar el evento ni la auditoría. `409` si la
    comanda ya está cerrada por otro camino (`VOIDED`/`MERGED`): esos son
    caminos incompatibles con "compensar", no algo que este hook pueda
    resolver silenciosamente."""
    if order.channel != OrderChannel.PLATFORM:
        raise ConflictError("Esta comanda no es de una plataforma", code="NOT_A_PLATFORM_ORDER")
    if order.status == OrderStatus.COMPENSATED:
        return order
    if order.status in (OrderStatus.VOIDED, OrderStatus.MERGED):
        raise ConflictError("Esta comanda ya está cerrada por otro camino", code="ORDER_NOT_CANCELLABLE")

    order.status = OrderStatus.COMPENSATED
    order.platform_cancelled_at = now
    order.platform_cancel_reason = reason
    order.platform_cancelled_by_employee_id = actor.employee_id if actor else None
    order.platform_cancelled_by_employee_name = actor.employee_name if actor else None
    order.updated_at = now
    order.version += 1
    db.add(
        OrderEvent(
            organization_id=order.organization_id,
            store_id=order.store_id,
            order_id=order.id,
            kind="platform_cancelled",
            payload={"reason": reason},
            employee_id=actor.employee_id if actor else None,
            employee_name=actor.employee_name if actor else None,
            authorized_by_employee_id=None,
            authorized_by_employee_name=None,
            after_bill=order.bill_presented_at is not None,
            at=now,
        )
    )
    db.flush()
    record_audit(
        db,
        actor=actor,
        organization_id=order.organization_id,
        store_id=order.store_id,
        entity="order",
        entity_id=order.id,
        action="platform_cancel",
        before=None,
        after={"reason": reason},
        reason=reason,
    )
    return order


# ---------------------------------------------------------------------------
# Lectura para el food cost real / teórico por VENTANA DE CONTEO
# (`app.inventory.service.food_cost_report`, `app.analytics.service`). Sólo
# lectura: no escribe nada, no mueve ningún estado.
# ---------------------------------------------------------------------------


class SalesWindow:
    """Lo vendido en una ventana de INSTANTES `(paid_after, paid_until]`,
    atribuido por `Order.paid_at`: una comanda cae en exactamente una
    ventana (intervalo semiabierto), nunca en dos. Todo en pesos enteros
    salvo `theoretical_cost_micros`, que se deja en micros para que quien
    lo use redondee una sola vez al final (regla B-2 de `app.reports`).

    - `orders`: comandas cobradas en la ventana.
    - `net_sales`: Σ base (sin impuesto, sin propina, con descuentos) de
      los ítems vivos — `compute_order_totals`, la única matemática de la
      venta; es lo mismo que `total − tax_total` del documento.
    - `costed_net`: la parte de `net_sales` que viene de ítems con costo
      congelado (`unit_cost_micros` no nulo).
    - `theoretical_cost_micros`: Σ `unit_cost_micros × qty` de esos ítems;
      `None` si ninguno tenía costo (nunca `0` mudo)."""

    __slots__ = ("orders", "net_sales", "costed_net", "theoretical_cost_micros")

    def __init__(self, *, orders: int, net_sales: int, costed_net: int, theoretical_cost_micros: int | None) -> None:
        self.orders = orders
        self.net_sales = net_sales
        self.costed_net = costed_net
        self.theoretical_cost_micros = theoretical_cost_micros


def sales_in_window(db: Session, *, store_id: int, paid_after: datetime, paid_until: datetime) -> SalesWindow:
    # Import diferido a propósito: este módulo no importa `app.orders.service`
    # a nivel de módulo (ver el docstring de arriba: evitar el ciclo con el
    # turno). Acá sólo se LEE su matemática de totales, no se escribe nada.
    from app.orders.service import compute_order_totals

    orders = list(
        db.execute(
            select(Order).where(
                Order.store_id == store_id,
                Order.status == OrderStatus.PAID,
                Order.paid_at.is_not(None),
                Order.paid_at > paid_after,
                Order.paid_at <= paid_until,
            )
        ).scalars()
    )
    net_sales = 0
    costed_net = 0
    cost_micros = 0
    any_costed = False
    for order in orders:
        base_by_item = {lt.item_id: lt.base for lt in compute_order_totals(db, order).lines}
        items = db.execute(
            select(OrderItem).where(OrderItem.order_id == order.id, OrderItem.status != OrderItemStatus.VOIDED)
        ).scalars()
        for item in items:
            base = base_by_item.get(item.id, 0)
            net_sales += base
            if item.unit_cost_micros is not None:
                any_costed = True
                costed_net += base
                cost_micros += int(item.unit_cost_micros) * int(item.qty)
    return SalesWindow(
        orders=len(orders),
        net_sales=net_sales,
        costed_net=costed_net,
        theoretical_cost_micros=cost_micros if any_costed else None,
    )
