"""Modelos propios del KDS (`kitchen.kds`, pedido 2c,
`features/fase-2c-canales-cocina/spec.md`).

Hasta 2b `app.kitchen` no tenía modelos: `router.py` sólo LEÍA
`app.orders.models` y `app.stores.models` para armar la vista mínima
(`kitchen.view`, 1b). Este archivo agrega las dos tablas que el KDS
completo necesita **para lo que es dueño de verdad**: quién bumpeó qué y
cuándo, y qué se imprimió y para qué estación. Todo lo demás (el estado del
ítem, el curso marchado, el semáforo) sigue viviendo donde ya vivía —
`app.orders.models` y `StoreSalesSettings` — y se LEE, nunca se duplica acá
(`AGENTS.md`: "el insumo/el dato se guarda una sola vez").

CONTRATO C1 (`app/orders/hooks.py`): este dominio **nunca** escribe
`OrderItem.status` ni ningún campo de `app.orders.models`. Las dos tablas de
acá abajo son la auditoría PROPIA de kitchen sobre acciones que, por
adentro, mueven el estado del ítem a través de `bump_item`/`unbump_item`/
`expedite_order` — la fila que registra "quién" y "cuándo" es de kitchen
porque es kitchen quien la necesita (cocina es pantalla compartida).

Convenciones heredadas (`docs/ESTADO.md`, `AGENTS.md`):
- `app.core.db.UTCDateTime` en todo `Mapped[datetime]`.
- Enums `native_enum=False`, comparados por valor.
- Atribución con FK real (`employee_id`) + nombre congelado; nunca se borra
  un empleado.
- Nada financiero ni de auditoría se borra: estas dos tablas son
  **append-only** por diseño (nunca hay un `UPDATE` ni un `DELETE` sobre una
  fila ya escrita).
- `order_id`/`item_id`/`round_id` llevan FK real: a diferencia de
  `OrderSubAccount.document_id` (1b-1) o `Order.platform_id` (2c,
  `app.channels`), acá NO hay riesgo de orden de migraciones cruzadas —
  `orders` es `0004`, `order_rounds`/`order_items` viven ahí, y esta
  migración (`0015`) corre después de TODA la cadena por construcción
  (`down_revision = "0014"`), así que las tablas que referencia ya existen
  siempre que esta corre.
"""

from __future__ import annotations

import enum
from datetime import datetime

import sqlalchemy as sa
from sqlalchemy import ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UTCDateTime

ENUM_LENGTH = 16


def _enum(pyenum: type[enum.Enum], *, length: int = ENUM_LENGTH) -> sa.Enum:
    return sa.Enum(pyenum, native_enum=False, length=length, validate_strings=True)


class KitchenBumpAction(str, enum.Enum):
    """`bump`: `sent -> ready` de un solo ítem (`app.orders.hooks.bump_item`).
    `unbump`: el deshacer (`unbump_item`), `ready -> sent`. `expedite`: la
    comanda completa de un golpe (`expedite_order`) — una fila por cada
    ítem que DE VERDAD cambió, mismo `action` para que "quién bumpeó este
    ítem" encuentre la respuesta sin importar si fue un bump suelto o una
    expedición."""

    BUMP = "bump"
    UNBUMP = "unbump"
    EXPEDITE = "expedite"


class KitchenBumpEvent(Base):
    """Auditoría propia del KDS sobre `bump_item`/`unbump_item`/
    `expedite_order` (CONTRATO C1). Una fila por transición que de verdad
    ocurrió — un bump idempotente que no cambió nada (el ítem ya estaba
    `ready`) **no** escribe fila acá: no hay nada que auditar, es el mismo
    criterio con el que `expedite_order` devuelve sólo los ids que
    cambiaron.

    `from_status`/`to_status` son el string del `OrderItemStatus` que ya
    existía/quedó (`"sent"`/`"ready"`) — se guardan como texto, no como el
    tipo del enum de `app.orders.models`, mismo criterio que
    `OrderItem.cost_source` en `app/orders/models.py`: este módulo no
    importa el `Enum` ajeno en su DDL para no acoplar la migración de
    `kitchen` al tipo declarado en `orders`."""

    __tablename__ = "kitchen_bump_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    item_id: Mapped[int] = mapped_column(ForeignKey("order_items.id"), index=True)

    action: Mapped[KitchenBumpAction] = mapped_column(_enum(KitchenBumpAction))
    from_status: Mapped[str] = mapped_column(sa.String(16))
    to_status: Mapped[str] = mapped_column(sa.String(16))

    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    employee_name: Mapped[str] = mapped_column(sa.String(200))
    at: Mapped[datetime] = mapped_column(UTCDateTime())

    __table_args__ = (
        Index("ix_kitchen_bump_events_item_at", "item_id", "at"),
        Index("ix_kitchen_bump_events_store_at", "store_id", "at"),
    )


class KitchenPrintJob(Base):
    """El registro de "esto se hubiera impreso": una fila por cada vez que
    alguien confirma el trabajo de impresión de UNA estación para UNA ronda
    (`POST /kitchen/print-jobs`). No hay impresora real (§13, fase 3) — esto
    es el trabajo (qué, para qué estación, cuándo, quién) que un driver real
    consumiría mañana; ver `app/kitchen/service.py::build_print_job` para
    dónde termina esto y dónde empezaría ese driver.

    Reimprimir es legítimo (mismo criterio que `Order.bill_print_count`:
    una estación puede pedir la comanda de nuevo si el papel se atascó), así
    que esta tabla es **append-only**: cada confirmación agrega una fila
    nueva, nunca actualiza la anterior. `item_count` congela cuántos ítems
    tenía la ronda para esa estación EN ESE INSTANTE — si se agregan ítems
    después, un reimpreso nuevo lo refleja con su propia fila."""

    __tablename__ = "kitchen_print_jobs"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    round_id: Mapped[int] = mapped_column(ForeignKey("order_rounds.id"), index=True)
    station: Mapped[str] = mapped_column(sa.String(50))
    item_count: Mapped[int] = mapped_column(sa.Integer)

    printed_at: Mapped[datetime] = mapped_column(UTCDateTime())
    printed_by_employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    printed_by_employee_name: Mapped[str] = mapped_column(sa.String(200))

    __table_args__ = (
        Index("ix_kitchen_print_jobs_round_station", "round_id", "station"),
        Index("ix_kitchen_print_jobs_store_printed", "store_id", "printed_at"),
    )
