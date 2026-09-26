"""Esquemas Pydantic de la comanda. `OrderOut` es vinculante
(`CONTRATO-INTERNO-1b-1.md §2.4`): `frontend-comanda`, `frontend-cobro` y
`backend-cobro` lo leen tal cual — no se le cambia una clave sin avisar a los
tres. Ningún esquema de este módulo tiene `cost`/`margin`/`unit_cost`.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

Channel = Literal["counter", "dine_in", "takeout", "delivery", "platform", "staff_meal"]
OrderStatusLiteral = Literal["open", "to_pay", "paid", "merged", "voided", "compensated"]
ItemStatusLiteral = Literal["pending", "sent", "ready", "served", "voided"]
VoidReasonLiteral = Literal[
    "customer_changed_mind",
    "server_error",
    "kitchen_error",
    "long_wait",
    "walkout",
    "duplicate",
    "other",
]
CourtesyReasonLiteral = Literal["complaint", "promo_owner", "guest_of_owner", "other"]
DiscountReasonLiteral = Literal["promo", "complaint", "owner", "employee", "other"]
DiscountScopeLiteral = Literal["order", "item"]
DiscountKindLiteral = Literal["percent", "amount"]
SubAccountStatusLiteral = Literal["open", "paid"]


class EmployeeRef(BaseModel):
    id: int
    name: str


# ---------------------------------------------------------------------------
# Salida: piezas compartidas
# ---------------------------------------------------------------------------


class TableRef(BaseModel):
    id: int
    number: str
    zone_name: str


class TakeoutOut(BaseModel):
    customer_name: str
    phone: str | None
    promised_at: datetime | None


class DeliveryOut(BaseModel):
    address: str
    phone: str
    # `courier` es `None` cuando `Order.courier_employee_id` es NULL —
    # columna nullable (`0013_channels_orders`) que `create_order` sólo
    # exige AL CREAR (H-4, ronda 3): una fila que llegue con la columna en
    # NULL (una `UPDATE` a mano, un futuro endpoint de reasignación) no
    # inventa un empleado `id: 0`. `null` no es 0 (AGENTS.md). El bloque
    # `delivery` sigue existiendo igual; sólo `courier` se vuelve opcional.
    courier: EmployeeRef | None = None


class PlatformOut(BaseModel):
    """Nunca lleva `commission_bp`: es plata que corre por fuera de la
    venta ("la venta es la venta, la comisión es un costo") y este esquema
    es el mismo que ve el dispositivo — mismo criterio que `OrderItemOut` sin
    `unit_cost`. La comisión congelada vive en `Order.platform_commission_bp`
    para que un reporte de admin (territorio ajeno) la lea directo del
    modelo si la necesita.

    `name`/`external_id` son `str | None` por el MISMO motivo que
    `DeliveryOut.courier` (ronda 3, H-4 barrido): `Order.platform_name` y
    `Order.platform_external_id` son columnas nullable que `create_order`
    sólo llena AL CREAR — nada en este dominio las vuelve a escribir después,
    pero una fila que llegue con la columna en NULL por fuera del servicio
    (una `UPDATE` a mano) no se disfraza de string vacío. `id` no lleva este
    tratamiento: nunca pasó por `or` — el bloque entero sólo se arma cuando
    `order.platform_id is not None` (ver `order_out`)."""

    id: int
    name: str | None = None
    external_id: str | None = None


class CourseFireOut(BaseModel):
    course: str
    fired_at: datetime
    fired_by: EmployeeRef


class ModifierOut(BaseModel):
    option_id: int
    group_name: str
    name: str
    price_delta: int


class ComboSelectionOut(BaseModel):
    group_id: int
    group_name: str
    option_id: int
    product_id: int
    product_name: str


class CourtesyOut(BaseModel):
    reason: CourtesyReasonLiteral
    note: str | None
    authorized_by: EmployeeRef | None
    at: datetime
    after_bill: bool


class VoidInfoOut(BaseModel):
    reason: VoidReasonLiteral
    note: str | None
    by: EmployeeRef | None
    authorized_by: EmployeeRef | None
    at: datetime
    after_bill: bool
    minutes_since_sent: int | None


class OrderItemOut(BaseModel):
    id: int
    product_id: int | None
    combo_id: int | None
    name: str
    qty: int
    seat: int | None
    course: str
    station: str | None
    list_price: int
    unit_price: int
    tax_code: str
    tax_rate: int
    modifiers: list[ModifierOut]
    modifiers_text: str | None
    combo_selections: list[ComboSelectionOut] | None
    note: str | None
    status: ItemStatusLiteral
    round_no: int | None
    sent_at: datetime | None
    ready_at: datetime | None
    served_at: datetime | None
    sent_at_payment: bool
    gross: int
    discount: int
    net: int
    tax: int
    courtesy: CourtesyOut | None
    void: VoidInfoOut | None
    # El cargo de domicilio (`Product.is_delivery_fee`) es una línea de
    # plata, no un plato: el salón no lo cuenta en «Enviar a cocina · N» ni
    # lo ofrece para «marchar» un curso. Ya viaja con `station=None`, así que
    # nunca pasa por cocina; esto sólo le dice al cliente qué línea es.
    is_delivery_fee: bool = False


class OrderRoundOut(BaseModel):
    round_no: int
    sent_at: datetime
    sent_at_payment: bool


class OrderDiscountOut(BaseModel):
    id: int
    scope: DiscountScopeLiteral
    item_id: int | None
    kind: DiscountKindLiteral
    value: int
    amount: int
    reason: DiscountReasonLiteral
    note: str | None
    by: EmployeeRef
    authorized_by: EmployeeRef | None
    after_bill: bool
    at: datetime


class TaxLineOut(BaseModel):
    rate: int
    base: int
    tax: int


class TotalsOut(BaseModel):
    subtotal: int
    discount_total: int
    tax_lines: list[TaxLineOut]
    tax_total: int
    total: int


class TipInfoOut(BaseModel):
    base: int
    suggested_pct: float
    suggested_amount: int


class SubAccountItemOut(BaseModel):
    item_id: int
    name: str
    qty: int
    portions: int
    of_portions: int
    share: int


class SubAccountOut(BaseModel):
    id: int
    seq: int
    label: str
    seat: int | None
    status: SubAccountStatusLiteral
    items: list[SubAccountItemOut]
    totals: TotalsOut
    tip: TipInfoOut | None
    document_id: int | None


class OrderOut(BaseModel):
    id: int
    version: int
    channel: Channel
    status: OrderStatusLiteral
    business_date: date
    shift_id: int | None
    tables: list[TableRef]
    covers: int | None
    note: str | None
    takeout: TakeoutOut | None
    delivery: DeliveryOut | None
    platform: PlatformOut | None
    courses_fired: list[CourseFireOut]
    consumed_by: EmployeeRef | None
    opened_by: EmployeeRef
    opened_at: datetime
    bill_presented_at: datetime | None
    bill_print_count: int
    paid_at: datetime | None
    closed_at: datetime | None
    paid_by: EmployeeRef | None
    voided_at: datetime | None
    void_reason: VoidReasonLiteral | None
    merged_into_order_id: int | None
    transferred_from_shift_id: int | None
    kitchen_view_enabled: bool
    split_parts: int | None
    rounds: list[OrderRoundOut]
    items: list[OrderItemOut]
    discounts: list[OrderDiscountOut]
    sub_accounts: list[SubAccountOut]
    totals: TotalsOut
    tip: TipInfoOut | None
    document_id: int | None


# ---------------------------------------------------------------------------
# Mesas
# ---------------------------------------------------------------------------


class TableStatusOut(BaseModel):
    id: int
    number: str
    seats: int
    status: Literal["free", "occupied", "to_pay"]
    order_id: int | None = None
    opened_at: datetime | None = None
    covers: int | None = None
    total: int | None = None
    # Platos que cocina ya marcó listos y nadie sirvió todavía: el mesero
    # lo ve en el mapa sin abrir la comanda. `0` es un conteo real (no hay
    # nada esperando), no un «sin dato».
    ready_count: int = 0
    # Unidades (`qty`) todavía sin enviar a cocina: «3 sin enviar» en el
    # mapa. Mismo criterio que `ready_count`: `0` es un conteo real.
    unsent_count: int = 0
    # Quién abrió la mesa: iniciales en la tarjeta y el filtro «Mis mesas».
    opened_by: EmployeeRef | None = None


class ZoneStatusOut(BaseModel):
    id: int
    name: str
    tables: list[TableStatusOut]


class TablesStatusOut(BaseModel):
    zones: list[ZoneStatusOut]


class FavoriteOut(BaseModel):
    product_id: int
    qty: int


# ---------------------------------------------------------------------------
# Precuenta
# ---------------------------------------------------------------------------


class PreBillLineOut(BaseModel):
    description: str
    qty: int
    unit_price: int
    gross: int
    discount: int
    net: int


class PreBillOut(BaseModel):
    order_id: int
    version: int
    lines: list[PreBillLineOut]
    subtotal: int
    discount_total: int
    tax_lines: list[TaxLineOut]
    tax_total: int
    total: int
    tip: TipInfoOut | None
    legend: str = "NO ES FACTURA — documento informativo"
    bill_presented_at: datetime
    bill_print_count: int


class BillSplitEqualOut(BaseModel):
    mode: Literal["equal"] = "equal"
    parts: int
    per_part: list[int]
    total: int
    # Lo que cada parte paga de verdad: venta + propina repartidas juntas
    # (`tip_amount` es la que se mandó al dividir; 0 si no hubo). Σ
    # `per_part_due` == `amount_due` == `total` + `tip_amount`.
    tip_amount: int = 0
    per_part_due: list[int] = Field(default_factory=list)
    amount_due: int = 0


class BillSplitItemsOut(BaseModel):
    mode: Literal["items"] = "items"
    sub_accounts: list[SubAccountOut]


# ---------------------------------------------------------------------------
# Admin
# ---------------------------------------------------------------------------


class AdminOrderListItem(BaseModel):
    """**Hallazgo (pedido 2a, no corregido: fuera de alcance)**: esta clase
    no se usa — `GET /admin/orders` devuelve `dict[str, Any]` a mano en
    `app.orders.service.admin_list_orders`/`app.orders.router.
    get_admin_orders`, así que ni esta clase ni sus campos aparecen en el
    OpenAPI. Quedó desincronizada de esa función (le faltan `table_minutes`,
    `void_details`, `payment_methods`, etc.) desde antes de este pedido.
    Declarado en el entregable de este agente."""

    id: int
    business_date: date
    shift_id: int | None
    channel: Channel
    tables: list[str]
    covers: int | None
    status: OrderStatusLiteral
    opened_by: str
    opened_at: datetime
    bill_presented_at: datetime | None
    paid_at: datetime | None
    items_count: int
    total: int
    voided_items: int
    voids_after_bill: int
    courtesies: int
    discount_total: int
    sent_at_payment_items: int
    transferred: bool


class OrderConsumptionRowOut(BaseModel):
    """`GET /admin/orders/{id}/consumption` (pedido 2b, corrección a §5.3):
    un renglón por insumo o preparación, sumando las filas por ítem del
    LIBRO (`app.inventory.models.StockMovement`) — la fusión es de LECTURA,
    acá; el libro sigue guardando una fila por `order_item` (ver
    `app.orders.service.order_consumption`). **Única excepción declarada al
    docstring del módulo** ("ningún esquema de este archivo tiene `cost`"):
    esta ruta es admin-only, nunca se monta bajo sesión de dispositivo
    (`app.orders.router.get_order_consumption` no depende de
    `current_device` en ningún camino), así que publicar costo acá no
    viola "el operador no recibe costos" — sólo lo evita en TODO lo demás
    de este módulo, que sí es compartido con el dispositivo."""

    ingredient_id: int | None
    preparation_id: int | None
    name: str
    unit: str
    # Cantidad de insumo — SIEMPRE texto decimal (`app.core.quantity.
    # format_qty_base`), nunca milésimas crudas (misma regla que unifica
    # `app.reports.schemas` en este mismo pedido). Puede ser negativa (salida
    # neta) o `"0"` si una nota "vuelve" revirtió exactamente lo que
    # descontó la venta.
    qty_base: str
    # Cantidad de PLATA total de este renglón (TOTAL, no por unidad): mismo
    # criterio que `SalesBucketOut.theoretical_cost` — enteros de pesos,
    # `app.core.quantity.micros_to_pesos` aplicado UNA sola vez al cerrar la
    # suma de todas las filas del libro que aportan a este insumo/prep.
    # `None` cuando NINGUNA fila del libro para este insumo tuvo costo
    # (nunca `0` mudo).
    cost: int | None
    # Origen del costo de la fila del libro más reciente que sí tuvo costo
    # (`official`/`weighted_average`/`last_purchase`/`estimated`); `None`
    # junto con `cost=None`. Declarado en el entregable: si dos filas del
    # mismo insumo tienen orígenes distintos (precio cambió entre rondas de
    # envío), este campo reporta el más reciente, no una mezcla — el `cost`
    # sigue siendo la suma exacta de todas, sólo el ORIGEN mostrado es del
    # último evento.
    cost_source: str | None


class OrderConsumptionOut(BaseModel):
    order_id: int
    rows: list[OrderConsumptionRowOut]


# ---------------------------------------------------------------------------
# Entradas
# ---------------------------------------------------------------------------


class TakeoutIn(BaseModel):
    customer_name: str = Field(min_length=1, max_length=200)
    phone: str | None = Field(default=None, max_length=30)
    promised_at: datetime | None = None


class DeliveryIn(BaseModel):
    """Los tres datos propios de un canal `delivery` (§3.3): dirección,
    teléfono y domiciliario, los tres obligatorios al crear — es la lectura
    literal de la spec ("validá que crear una comanda delivery exige los
    datos que la spec pide"). Asignar o cambiar el domiciliario después de
    creada la comanda (p. ej. el mesero abre el pedido antes de saber quién
    va a repartirlo) queda declarado como gap en el entregable: no hay
    endpoint separado para eso en este pedido."""

    address: str = Field(min_length=1, max_length=300)
    phone: str = Field(min_length=1, max_length=30)
    courier_employee_id: int


class PlatformOrderIn(BaseModel):
    """`platform_id` referencia la plataforma configurada en `app.channels`
    (CONTRATO C2, territorio de `backend-dinero-canales`); `external_id` es
    el número del pedido en la plataforma, tecleado a mano (la integración
    por API es fase 3)."""

    platform_id: int
    external_id: str = Field(min_length=1, max_length=100)


class OrderCreateIn(BaseModel):
    channel: Channel
    table_ids: list[int] | None = None
    covers: int | None = Field(default=None, ge=1)
    takeout: TakeoutIn | None = None
    delivery: DeliveryIn | None = None
    platform: PlatformOrderIn | None = None
    consumed_by_employee_id: int | None = None
    note: str | None = None


class ModifierSelectionIn(BaseModel):
    option_id: int


class ComboSelectionIn(BaseModel):
    group_id: int
    option_id: int


class OrderItemIn(BaseModel):
    product_id: int | None = None
    combo_id: int | None = None
    qty: int = Field(gt=0)
    seat: int | None = None
    course: str | None = None
    modifiers: list[ModifierSelectionIn] = Field(default_factory=list)
    combo_selections: list[ComboSelectionIn] = Field(default_factory=list)
    note: str | None = None


class AddItemsIn(BaseModel):
    expected_version: int
    items: list[OrderItemIn] = Field(min_length=1)
    authorizer_pin: str | None = None


class PatchItemIn(BaseModel):
    expected_version: int
    qty: int | None = Field(default=None, gt=0)
    note: str | None = None
    seat: int | None = None
    # Con la cuenta ya presentada, cambiar un ítem pide el mismo PIN que
    # agregar uno (`after_bill_change`): si no, subir la cantidad era la
    # puerta de atrás de `add_items`.
    authorizer_pin: str | None = None


class ExpectedVersionIn(BaseModel):
    expected_version: int


class FireCourseIn(BaseModel):
    expected_version: int


class VoidItemIn(BaseModel):
    expected_version: int
    reason: VoidReasonLiteral
    note: str | None = None
    authorizer_pin: str | None = None


class CourtesyItemIn(BaseModel):
    expected_version: int
    reason: CourtesyReasonLiteral
    note: str | None = None
    authorizer_pin: str


class DiscountIn(BaseModel):
    expected_version: int
    scope: DiscountScopeLiteral
    item_id: int | None = None
    kind: DiscountKindLiteral
    value: int = Field(ge=0)
    reason: DiscountReasonLiteral
    note: str | None = None
    authorizer_pin: str | None = None


class MergeIn(BaseModel):
    expected_version: int
    from_order_id: int
    authorizer_pin: str | None = None


class MoveIn(BaseModel):
    expected_version: int
    table_ids: list[int] = Field(min_length=1)
    authorizer_pin: str | None = None


class VoidOrderIn(BaseModel):
    expected_version: int
    reason: VoidReasonLiteral
    note: str | None = None
    authorizer_pin: str | None = None


class SplitGroupIn(BaseModel):
    label: str | None = None
    seat: int | None = None
    item_ids: list[int] = Field(default_factory=list)
    shared: list["SharedItemIn"] = Field(default_factory=list)


class SharedItemIn(BaseModel):
    item_id: int
    portions: int = Field(gt=0)


class BillSplitIn(BaseModel):
    expected_version: int
    mode: Literal["equal", "items"]
    parts: int | None = Field(default=None, gt=0)
    groups: list[SplitGroupIn] | None = None
    # Partes iguales: la propina que ya se respondió, para repartirla junto
    # con la venta. Ausente = sin propina.
    tip_amount: int | None = Field(default=None, ge=0)
