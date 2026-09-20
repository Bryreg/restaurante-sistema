"""Modelos de la comanda: mesas, rondas, ítems, descuentos, sub-cuentas,
eventos y el stub de merma (`features/fase-1b-venta/CONTRATO-INTERNO-1b-1.md §2.2`,
vinculante: nombres de tabla y columna los leen tal cual el auditor, `backend-cobro`
y el frontend).

Convenciones heredadas (`docs/ESTADO.md`, `AGENTS.md`):
- `app.core.db.UTCDateTime` en todo `Mapped[datetime]`.
- Dinero en `Integer` (pesos enteros); tasas de impuesto como entero por
  ciento (`8`, `19`, `0`).
- Enums `native_enum=False`, comparados por valor.
- Todo modelo lleva `organization_id` y `store_id` (indexados) donde aplica.
- Nada se borra físicamente: baja lógica (`voided_at`, `merged_into_order_id`,
  `released_at`) + auditoría.
- El operador **no recibe costos**: `unit_cost` existe en `order_items` para
  que fase 2 lo llene, pero queda `NULL` en 1b y `app.orders.service.order_out`
  nunca lo serializa hacia el dispositivo.
"""

from __future__ import annotations

import enum
from datetime import date, datetime
from typing import Any

import sqlalchemy as sa
from sqlalchemy import CheckConstraint, ForeignKey, Index, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UTCDateTime

ENUM_LENGTH = 32


def _enum(pyenum: type[enum.Enum], *, length: int = ENUM_LENGTH) -> sa.Enum:
    return sa.Enum(pyenum, native_enum=False, length=length, validate_strings=True)


# ---------------------------------------------------------------------------
# Enums (§2.2 del contrato interno; valores en snake_case: viajan tal cual en
# la API y en la base).
# ---------------------------------------------------------------------------


class OrderChannel(str, enum.Enum):
    COUNTER = "counter"
    DINE_IN = "dine_in"
    TAKEOUT = "takeout"
    DELIVERY = "delivery"  # existe en el enum, apagado en 1b (fase 2)
    PLATFORM = "platform"  # existe en el enum, apagado en 1b (fase 2)
    STAFF_MEAL = "staff_meal"


class OrderStatus(str, enum.Enum):
    OPEN = "open"
    TO_PAY = "to_pay"
    PAID = "paid"
    MERGED = "merged"
    VOIDED = "voided"
    # Pedido 2c (§3.3, C4): cancelar una venta de PLATAFORMA después de
    # preparar compensa la VENTA, nunca una merma. Es un estado propio y no
    # una reutilización de `VOIDED` a propósito: `void_order`/`void_item`
    # (`app.orders.service`) sólo trabajan sobre `OPEN`/`TO_PAY` y crean
    # `WasteStub` — una comanda de plataforma cancelada llega acá casi
    # siempre `PAID` (la plataforma ya cobró) y JAMÁS pasa por esa función
    # (`app.orders.hooks.mark_platform_order_cancelled`, que no importa
    # `void_item` ni `_resolve_waste_stub`). Verificado antes de agregarlo:
    # `OrderStatus` no se compara nunca en un `match`/if-elif exhaustivo
    # fuera de `app.orders` (`app.reports.service` y
    # `app.shifts.activity_metrics` sólo preguntan por valores puntuales:
    # `OPEN`/`TO_PAY`/`PAID`), así que un miembro nuevo no rompe ningún
    # camino ajeno en silencio.
    #
    # Nombre y valor cortos A PROPÓSITO (`COMPENSATED`/`"compensated"`, 11
    # caracteres): `sa.Enum(OrderStatus, length=16)` valida contra el largo
    # del NOMBRE del miembro (no de su `.value`) y `orders.status` es
    # `VARCHAR(16)` desde `0004_orders.py` — un nombre más descriptivo como
    # `PLATFORM_CANCELLED` (18) revienta esa validación al importar el
    # módulo, y ensanchar una columna existente con `ALTER COLUMN` es
    # exactamente el tipo de DDL que `0011_purchases.py` dejó escrito como
    # lección cara contra Postgres real. "compensated" nombra lo mismo que
    # la spec: la venta se compensa, no se anula.
    COMPENSATED = "compensated"


class OrderItemStatus(str, enum.Enum):
    PENDING = "pending"
    SENT = "sent"
    READY = "ready"
    SERVED = "served"
    VOIDED = "voided"


class VoidReason(str, enum.Enum):
    CUSTOMER_CHANGED_MIND = "customer_changed_mind"
    SERVER_ERROR = "server_error"
    KITCHEN_ERROR = "kitchen_error"
    LONG_WAIT = "long_wait"
    WALKOUT = "walkout"
    DUPLICATE = "duplicate"
    OTHER = "other"


class CourtesyReason(str, enum.Enum):
    COMPLAINT = "complaint"
    PROMO_OWNER = "promo_owner"
    GUEST_OF_OWNER = "guest_of_owner"
    OTHER = "other"


class DiscountReason(str, enum.Enum):
    PROMO = "promo"
    COMPLAINT = "complaint"
    OWNER = "owner"
    EMPLOYEE = "employee"
    OTHER = "other"


DISCOUNT_SCOPE_VALUES = ("order", "item")
DISCOUNT_KIND_VALUES = ("percent", "amount")
SUB_ACCOUNT_STATUS_VALUES = ("open", "paid")

# `order_events.kind`: catálogo cerrado a nivel de documentación (la columna es
# String(32) libre porque nuevos tipos de evento no deberían pedir migración).
ORDER_EVENT_KINDS = (
    "opened",
    "tables_moved",
    "merged_out",
    "merged_in",
    "bill_presented",
    "transferred_out",
    "transferred_in",
    "voided",
    "split",
    # Pedido 2c.
    "course_fired",
    "platform_cancelled",
)


# ---------------------------------------------------------------------------
# Comanda
# ---------------------------------------------------------------------------


class Order(Base):
    """La comanda. `shift_id` queda `NULL` mientras está trasladada (turno
    cerrado con comandas abiertas sin cobrar) esperando que el turno
    siguiente la adopte (`app.orders.hooks.adopt_transferred_orders`)."""

    __tablename__ = "orders"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    shift_id: Mapped[int | None] = mapped_column(ForeignKey("shifts.id"), nullable=True, index=True)

    business_date: Mapped[date] = mapped_column(sa.Date)
    channel: Mapped[OrderChannel] = mapped_column(_enum(OrderChannel, length=16))
    status: Mapped[OrderStatus] = mapped_column(_enum(OrderStatus, length=16), default=OrderStatus.OPEN)
    version: Mapped[int] = mapped_column(sa.Integer, default=1)

    covers: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    note: Mapped[str | None] = mapped_column(sa.Text, nullable=True)

    # takeout
    takeout_customer_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)
    takeout_phone: Mapped[str | None] = mapped_column(sa.String(30), nullable=True)
    promised_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)

    # staff_meal
    consumed_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    consumed_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    # delivery (pedido 2c, §3.3): los tres datos propios del canal, exigidos
    # al crear (`app.orders.service.create_order`) — dirección y teléfono
    # como texto libre (el cliente los da por teléfono, no hay geocodificación
    # en este pedido), y el domiciliario con la regla propia del proyecto
    # (`docs/ESTADO.md`, "Atribución con FK real"): FK real a `employees` +
    # nombre CONGELADO, porque los empleados se desactivan pero nunca se
    # borran y una comanda vieja tiene que seguir diciendo quién entregó
    # aunque ese empleado ya no esté activo.
    delivery_address: Mapped[str | None] = mapped_column(sa.String(300), nullable=True)
    delivery_phone: Mapped[str | None] = mapped_column(sa.String(30), nullable=True)
    courier_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    courier_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    # platform (pedido 2c, §3.3): `platform_id` es una referencia SUAVE (sin
    # FK dura) a la plataforma configurada en `app.channels` (dominio de
    # `backend-dinero-canales`, CONTRATO C2) — mismo criterio que
    # `OrderSubAccount.document_id` con `app.fiscal` en 1b-1: ese dominio
    # puede no existir todavía cuando corre esta migración, y una FK cruzada
    # ataría el orden de las dos migraciones hermanas. `platform_name` y
    # `platform_commission_bp` son el SNAPSHOT al crear la comanda (igual que
    # precio/impuesto/receta en `OrderItem`): si mañana cambia el nombre o la
    # comisión de la plataforma en `app.channels`, esta comanda sigue
    # contando lo que era cierto el día que se vendió. `platform_external_id`
    # es el número de pedido en la plataforma, tecleado a mano (la
    # integración por API es fase 3 — spec.md, "no entra").
    platform_id: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    platform_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)
    platform_commission_bp: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    platform_external_id: Mapped[str | None] = mapped_column(sa.String(100), nullable=True)

    # Cancelación de plataforma DESPUÉS de preparar (§3.3, C4): campos
    # propios, nunca los de `void_*` de más abajo — ver el docstring de
    # `OrderStatus.COMPENSATED`.
    platform_cancelled_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    platform_cancel_reason: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    platform_cancelled_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    platform_cancelled_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    opened_by_employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    opened_by_employee_name: Mapped[str] = mapped_column(sa.String(200))
    opened_at: Mapped[datetime] = mapped_column(UTCDateTime())

    bill_presented_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    bill_print_count: Mapped[int] = mapped_column(sa.Integer, default=0)

    paid_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    paid_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    paid_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)

    voided_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    void_reason: Mapped[VoidReason | None] = mapped_column(_enum(VoidReason), nullable=True)
    void_note: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    voided_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    voided_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)
    void_authorized_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    void_authorized_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)
    void_after_bill: Mapped[bool] = mapped_column(sa.Boolean, default=False)

    merged_into_order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id"), nullable=True)
    merged_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)

    transferred_from_shift_id: Mapped[int | None] = mapped_column(ForeignKey("shifts.id"), nullable=True)
    transferred_to_shift_id: Mapped[int | None] = mapped_column(ForeignKey("shifts.id"), nullable=True)

    # Snapshot de `kitchen.view` al crear la comanda: el ratio de
    # `sent_at_payment` en los reportes de 1b-2 solo cuenta comandas con esto
    # en `True` (si la sede nunca tuvo cocina, no es una alerta de servicio).
    kitchen_view_enabled: Mapped[bool] = mapped_column(sa.Boolean, default=False)

    split_parts: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)

    created_at: Mapped[datetime] = mapped_column(UTCDateTime())
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime())

    __table_args__ = (
        Index("ix_orders_store_status", "store_id", "status"),
        Index("ix_orders_store_business_date", "store_id", "business_date"),
        CheckConstraint("version >= 1", name="ck_orders_version_positive"),
    )


class OrderTable(Base):
    """Mesa(s) asociadas a una comanda. `released_at IS NULL` = la mesa sigue
    apuntando a esta comanda; el índice único parcial defiende «una comanda
    abierta por mesa» (SPEC-NEGOCIO §3.3)."""

    __tablename__ = "order_tables"

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    table_id: Mapped[int] = mapped_column(ForeignKey("tables.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    seated_at: Mapped[datetime] = mapped_column(UTCDateTime())
    released_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)

    __table_args__ = (
        Index(
            "uq_order_tables_one_open_per_table",
            "table_id",
            unique=True,
            postgresql_where=sa.text("released_at IS NULL"),
            sqlite_where=sa.text("released_at IS NULL"),
        ),
    )


class OrderRound(Base):
    """Ronda numerada de envío a cocina dentro de una comanda."""

    __tablename__ = "order_rounds"

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    round_no: Mapped[int] = mapped_column(sa.Integer)
    sent_at: Mapped[datetime] = mapped_column(UTCDateTime())
    sent_by_employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    sent_by_employee_name: Mapped[str] = mapped_column(sa.String(200))
    # `True` cuando la ronda la generó `auto_send_pending_for_payment` (cobro
    # con ítems pendientes), no un `POST /orders/{id}/send` explícito.
    sent_at_payment: Mapped[bool] = mapped_column(sa.Boolean, default=False)

    __table_args__ = (UniqueConstraint("order_id", "round_no", name="uq_order_rounds_order_round"),)


class OrderItem(Base):
    """Un ítem de la comanda con su snapshot completo congelado al agregarlo
    (precio, impuesto, texto de modificadores, curso, estación...). Cambiar la
    carta mañana no cambia lo que ya se vendió hoy (SPEC-NEGOCIO §3.3)."""

    __tablename__ = "order_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id"), nullable=True, index=True)
    combo_id: Mapped[int | None] = mapped_column(ForeignKey("combos.id"), nullable=True)

    name: Mapped[str] = mapped_column(sa.String(200))
    qty: Mapped[int] = mapped_column(sa.Integer)
    seat: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    course: Mapped[str] = mapped_column(sa.String(50))
    station: Mapped[str | None] = mapped_column(sa.String(50), nullable=True)

    list_price: Mapped[int] = mapped_column(sa.Integer)
    unit_price: Mapped[int] = mapped_column(sa.Integer)
    tax_code: Mapped[str] = mapped_column(sa.String(16))
    tax_rate: Mapped[int] = mapped_column(sa.Integer)
    price_includes_tax: Mapped[bool] = mapped_column(sa.Boolean)

    modifiers: Mapped[list[dict[str, Any]]] = mapped_column(sa.JSON, default=list)
    modifiers_text: Mapped[str | None] = mapped_column(sa.String(500), nullable=True)
    combo_selections: Mapped[list[dict[str, Any]] | None] = mapped_column(sa.JSON, nullable=True)

    note: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    status: Mapped[OrderItemStatus] = mapped_column(_enum(OrderItemStatus, length=16), default=OrderItemStatus.PENDING)
    round_id: Mapped[int | None] = mapped_column(ForeignKey("order_rounds.id"), nullable=True)
    round_no: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)

    sent_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    ready_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    served_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    sent_at_payment: Mapped[bool] = mapped_column(sa.Boolean, default=False)

    discount_amount: Mapped[int] = mapped_column(sa.Integer, default=0)

    courtesy_reason: Mapped[CourtesyReason | None] = mapped_column(_enum(CourtesyReason), nullable=True)
    courtesy_note: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    courtesy_authorized_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    courtesy_authorized_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)
    courtesy_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    courtesy_after_bill: Mapped[bool] = mapped_column(sa.Boolean, default=False)

    void_reason: Mapped[VoidReason | None] = mapped_column(_enum(VoidReason), nullable=True)
    void_note: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    voided_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    voided_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    voided_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)
    void_authorized_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    void_authorized_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)
    void_after_bill: Mapped[bool] = mapped_column(sa.Boolean, default=False)
    void_minutes_since_sent: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)

    # Pedido 2a: se congelan al enviar (`app.orders.service._apply_send` →
    # `_freeze_item_consumption`), en pesos enteros (`unit_cost`, vía
    # `app.core.quantity.micros_to_pesos`) y nunca se recalculan después —
    # es el snapshot que hace que un reporte no revalore una venta pasada con
    # la ficha actual. `cost_source` viaja SIEMPRE junto a `unit_cost`: sin
    # costo es `unit_cost=None, cost_source="none"`, nunca un cero mudo.
    # Guardado como `String` (el valor del enum `app.inventory.models.
    # CostSource`, p. ej. `"official"`) y no como el tipo del enum en sí: este
    # módulo no importa modelos de `app.inventory` en su DDL para no acoplar
    # la migración de `orders` al orden en que corre la de `inventory`
    # (mismo criterio que otros `Integer`/`String` "sin FK dura" del repo
    # hacia una tabla de un dominio hermano). Ninguno de los dos se
    # serializa hacia ninguna respuesta de comanda, cocina, precuenta ni
    # comprobante (`OrderItemOut` no los declara) — sólo los leen los
    # reportes de admin (`app.reports.service`).
    unit_cost: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    recipe_version: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    cost_source: Mapped[str | None] = mapped_column(sa.String(20), nullable=True)
    # Ronda 2 (B-2, "el cero mudo congelado"): `unit_cost` en pesos redondea
    # `micros_to_pesos` half-up — un plato de $0,30 congela `unit_cost=0` con
    # `cost_source="official"` (NO un cero mudo: tiene origen), pero sumar
    # 100 de esos ítems en pesos da $0 en vez de $30. `unit_cost_micros`
    # guarda el mismo costo SIN redondear (millonésimas de peso,
    # `app.core.quantity.COST_SCALE`) para que un reporte que acumula muchas
    # líneas (`app.reports.service._document_cost_stats`) sume en micros y
    # convierta a pesos UNA sola vez, al cerrar el total. Viaja siempre junto
    # a `unit_cost`/`cost_source` (los tres `None` juntos, o los tres con
    # dato): no es una columna independiente con su propio `cost_source`.
    # `unit_cost` NO cambia de semántica ni de tipo — sigue siendo la que
    # leen los invariantes verdes del auditor (`tests/audit/
    # test_cost_invariants.py:120,273,284`, `test_consumption_invariants.py
    # :266,861`); esta columna es aditiva.
    # `BigInteger`, no `Integer`: un costo de $10.000 ya son 10^10 micros
    # (`COST_SCALE = 1_000_000`), fuera de rango de un `Integer` de 32 bits
    # (mismo criterio que `app.inventory.models.StockMovement.cost_micros`/
    # `Ingredient.official_cost_micros`).
    unit_cost_micros: Mapped[int | None] = mapped_column(sa.BigInteger, nullable=True)

    added_by_employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    added_by_employee_name: Mapped[str] = mapped_column(sa.String(200))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime())

    __table_args__ = (
        Index("ix_order_items_order_status", "order_id", "status"),
        CheckConstraint("qty > 0", name="ck_order_items_qty_positive"),
    )


class OrderDiscount(Base):
    """Descuento por ítem o por comanda, con motivo tipado. `amount` es lo
    efectivamente descontado en pesos (ya resuelto desde `value`, que puede
    ser porcentaje o pesos según `kind`)."""

    __tablename__ = "order_discounts"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    item_id: Mapped[int | None] = mapped_column(ForeignKey("order_items.id"), nullable=True, index=True)

    scope: Mapped[str] = mapped_column(
        sa.Enum(*DISCOUNT_SCOPE_VALUES, name="order_discount_scope", native_enum=False, length=16)
    )
    kind: Mapped[str] = mapped_column(
        sa.Enum(*DISCOUNT_KIND_VALUES, name="order_discount_kind", native_enum=False, length=16)
    )
    value: Mapped[int] = mapped_column(sa.Integer)
    amount: Mapped[int] = mapped_column(sa.Integer)
    reason: Mapped[DiscountReason] = mapped_column(_enum(DiscountReason))
    note: Mapped[str | None] = mapped_column(sa.Text, nullable=True)

    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    employee_name: Mapped[str] = mapped_column(sa.String(200))
    authorized_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    authorized_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)
    after_bill: Mapped[bool] = mapped_column(sa.Boolean, default=False)
    at: Mapped[datetime] = mapped_column(UTCDateTime())
    voided_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)

    __table_args__ = (CheckConstraint("value >= 0", name="ck_order_discounts_value_nonneg"),)


class OrderSubAccount(Base):
    """Una sub-cuenta de la división «por ítems» o «por asiento». `document_id`
    no lleva FK real a propósito: lo llena `backend-cobro` (`app.payments`),
    territorio ajeno, y una FK cruzada obligaría a este módulo a conocer una
    tabla que todavía no existe cuando se corre `0004_orders.py`."""

    __tablename__ = "order_sub_accounts"

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    seq: Mapped[int] = mapped_column(sa.Integer)
    label: Mapped[str] = mapped_column(sa.String(100))
    seat: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    status: Mapped[str] = mapped_column(
        sa.Enum(*SUB_ACCOUNT_STATUS_VALUES, name="sub_account_status", native_enum=False, length=16),
        default="open",
    )
    paid_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    document_id: Mapped[int | None] = mapped_column(sa.Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime())

    __table_args__ = (UniqueConstraint("order_id", "seq", name="uq_order_sub_accounts_order_seq"),)


class OrderSubAccountItem(Base):
    """Porción de un ítem que cae en una sub-cuenta. `1/1` = el ítem entero;
    `1/3` = un tercio (ítem compartido entre tres sub-cuentas)."""

    __tablename__ = "order_sub_account_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    sub_account_id: Mapped[int] = mapped_column(ForeignKey("order_sub_accounts.id"), index=True)
    order_item_id: Mapped[int] = mapped_column(ForeignKey("order_items.id"), index=True)
    portions: Mapped[int] = mapped_column(sa.Integer)
    of_portions: Mapped[int] = mapped_column(sa.Integer)

    __table_args__ = (
        CheckConstraint("portions > 0", name="ck_sub_account_items_portions_positive"),
        CheckConstraint("of_portions > 0", name="ck_sub_account_items_of_portions_positive"),
    )


class OrderEvent(Base):
    """Traza de eventos de la comanda (apertura, unión, movimiento de mesa,
    cuenta presentada, traslado de turno, anulación, división)."""

    __tablename__ = "order_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    kind: Mapped[str] = mapped_column(sa.String(32))
    payload: Mapped[dict[str, Any]] = mapped_column(sa.JSON, default=dict)
    employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)
    authorized_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    authorized_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)
    after_bill: Mapped[bool] = mapped_column(sa.Boolean, default=False)
    at: Mapped[datetime] = mapped_column(UTCDateTime())

    __table_args__ = (Index("ix_order_events_order_at", "order_id", "at"),)


class WasteStub(Base):
    """El stub de merma que deja anular un ítem ya enviado: no repone nada,
    sólo constata cantidad y motivo. Pedido 2a: `ingredient_id` pasa a **FK
    real** a `ingredients.id` (mismo caso que `fiscal_range_id` en 1b-2, que
    entró como `Integer` pelado y hubo que convertirlo después: acá entra
    bien de una, en la migración `0010`) y se resuelve contra la ficha al
    anular (`app.orders.service._resolve_waste_stub`). Un ítem cuya ficha
    descuenta varios insumos genera **varios `WasteStub`** — uno por insumo,
    reutilizando esta fila para el primero —, nunca una sola fila con una
    lista adentro: así sigue siendo trazable insumo por insumo con el mismo
    modelo tabular que ya usa todo lo demás del repo."""

    __tablename__ = "waste_stubs"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    order_item_id: Mapped[int] = mapped_column(ForeignKey("order_items.id"), index=True)
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id"), nullable=True)
    product_name: Mapped[str] = mapped_column(sa.String(200))
    qty: Mapped[int] = mapped_column(sa.Integer)
    reason: Mapped[VoidReason] = mapped_column(_enum(VoidReason))
    note: Mapped[str | None] = mapped_column(sa.Text, nullable=True)

    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    employee_name: Mapped[str] = mapped_column(sa.String(200))
    authorized_by_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    authorized_by_employee_name: Mapped[str | None] = mapped_column(sa.String(200), nullable=True)
    at: Mapped[datetime] = mapped_column(UTCDateTime())

    ingredient_id: Mapped[int | None] = mapped_column(ForeignKey("ingredients.id"), nullable=True, index=True)
    resolved: Mapped[bool] = mapped_column(sa.Boolean, default=False)

    __table_args__ = (CheckConstraint("qty > 0", name="ck_waste_stubs_qty_positive"),)


class OrderCourseFire(Base):
    """El sello de «marchar» (pedido 2c, `pos.courses`): una fila por curso
    marchado de una comanda, nunca una columna en `Order` — «nada se borra» y
    marchar dos veces el mismo curso tiene que ser idempotente sin mover el
    primer `fired_at` (§ checklist de la spec). `UNIQUE(order_id, course)` es
    la defensa de base para eso: la aplicación ya no vuelve a escribir sobre
    una fila existente (`app.orders.service.fire_course` lee primero y
    devuelve tal cual si ya existe), así que esta constraint es la red de
    seguridad, no el camino principal. `app.orders.hooks.fired_at_by_course`
    la publica de sólo lectura para que el KDS (`kitchen.kds`, dominio
    ajeno) ordene por marchado sin duplicar este modelo."""

    __tablename__ = "order_course_fires"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("stores.id"), index=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    course: Mapped[str] = mapped_column(sa.String(50))
    fired_at: Mapped[datetime] = mapped_column(UTCDateTime())
    fired_by_employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    fired_by_employee_name: Mapped[str] = mapped_column(sa.String(200))

    __table_args__ = (UniqueConstraint("order_id", "course", name="uq_order_course_fires_order_course"),)
