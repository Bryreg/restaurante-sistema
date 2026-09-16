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

from app.core import clock
from app.core.modules import find_spec_safe
from app.orders.models import Order, OrderEvent, OrderItem, OrderStatus

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
