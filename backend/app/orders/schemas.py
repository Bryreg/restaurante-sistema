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
OrderStatusLiteral = Literal["open", "to_pay", "paid", "merged", "voided"]
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


class OrderCreateIn(BaseModel):
    channel: Channel
    table_ids: list[int] | None = None
    covers: int | None = Field(default=None, ge=1)
    takeout: TakeoutIn | None = None
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


class ExpectedVersionIn(BaseModel):
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
