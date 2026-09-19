"""Esquemas Pydantic del turno de caja: el borde de validación de la API.

Todo campo de dinero es `int` (pesos enteros). `None` nunca es `0`
(`docs/SPEC-NEGOCIO.md §6.1`): los campos "contado" opcionales se dejan
`Optional[int] = None`, nunca con default `0`.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

RosterActionLiteral = Literal["in", "out", "pause_start", "pause_end"]
CashMovementKindLiteral = Literal["income", "expense"]
CashMovementCauseLiteral = Literal[
    "petty_expense",
    "emergency_purchase",
    "refund",
    "tip_payout",
    "other_income",
    "other_expense",
    # Pedido 2b: pago en efectivo de una cuenta por pagar desde el cajón
    # (`app.shifts.hooks.register_supplier_payment_expense`).
    "supplier_payment",
]
CashDifferenceCauseLiteral = Literal[
    "change_error", "expense_without_voucher", "tips_mixed", "unrecorded_sale", "counting_error", "unknown"
]
HandoverKindLiteral = Literal["handover", "spot_check"]


class OutModel(BaseModel):
    """Base para esquemas de salida: permite leer desde objetos ORM."""

    model_config = ConfigDict(from_attributes=True)


# ---------------------------------------------------------------------------
# Dinero y denominaciones
# ---------------------------------------------------------------------------


class DenominationIn(BaseModel):
    value: int
    count: int = Field(ge=0)


class DenominationCountIn(BaseModel):
    denominations: list[DenominationIn]
    total: int


class EmployeeRef(OutModel):
    id: int
    name: str


class SalesByMethodOut(BaseModel):
    """Forma compartida por `sales` y `tips` de `ShiftSummaryOut`/
    `ShiftCurrentOut` (1b-1, `app.shifts.hooks.SalesTotals`). `other` agrupa
    `platform`/`voucher`/`other` (no entran al cajón)."""

    cash: int
    card: int
    transfer: int
    other: int


# ---------------------------------------------------------------------------
# Turno actual / apertura
# ---------------------------------------------------------------------------


class RosterEntryOut(OutModel):
    employee_id: int
    employee_name: str
    in_at: datetime
    out_at: datetime | None = None


class ShiftCurrentOut(BaseModel):
    id: int
    business_date: date
    opened_at: datetime
    cash_responsible: EmployeeRef
    roster: list[RosterEntryOut]
    expected_cash: int | None = None
    sales: SalesByMethodOut | None = None
    tips: SalesByMethodOut | None = None
    is_stale: bool
    cash_over_threshold: bool


class OpenShiftIn(BaseModel):
    opening_cash: DenominationCountIn
    cash_reserve: int = 0
    cash_responsible_id: int
    opening_cause: CashDifferenceCauseLiteral | None = None
    opening_note: str | None = None


class OpenShiftOut(BaseModel):
    id: int
    business_day_id: int
    business_date: date
    status: str
    opened_at: datetime
    cash_responsible: EmployeeRef
    opening_cash_total: int
    cash_reserve: int


# ---------------------------------------------------------------------------
# Roster
# ---------------------------------------------------------------------------


class RosterActionIn(BaseModel):
    employee_id: int
    action: RosterActionLiteral
    pin: str


class RosterActionOut(BaseModel):
    employee_id: int
    action: RosterActionLiteral
    at: datetime


# ---------------------------------------------------------------------------
# Relevos y arqueo sorpresa
# ---------------------------------------------------------------------------


class HandoverIn(BaseModel):
    kind: HandoverKindLiteral
    counted_cash: DenominationCountIn
    counted_card: int | None = None
    counted_transfer: int | None = None
    new_responsible_id: int | None = None
    authorizer_pin: str | None = None
    photo: str | None = None


class BreakdownOut(BaseModel):
    base: int
    cash_sales: int
    incomes: int
    expenses: int
    pickups: int
    expected: int


class HandoverOut(BaseModel):
    id: int
    kind: HandoverKindLiteral
    from_responsible: EmployeeRef
    new_responsible: EmployeeRef | None = None
    counted_cash: int
    counted_card: int | None = None
    counted_transfer: int | None = None
    breakdown: dict | None = None
    at: datetime


# ---------------------------------------------------------------------------
# Movimientos de caja
# ---------------------------------------------------------------------------


class CashMovementIn(BaseModel):
    kind: CashMovementKindLiteral
    cause: CashMovementCauseLiteral
    amount: int = Field(gt=0)
    note: str | None = None
    receipt_photo: str | None = None
    authorizer_pin: str | None = None


class CashMovementOut(OutModel):
    id: int
    kind: CashMovementKindLiteral
    cause: CashMovementCauseLiteral
    amount: int
    note: str | None = None
    receipt_photo: str | None = None
    employee_id: int
    employee_name: str
    authorized_by_employee_id: int | None = None
    authorized_by_employee_name: str | None = None
    at: datetime


# ---------------------------------------------------------------------------
# Cambio (sencilla)
# ---------------------------------------------------------------------------


class CashSwapIn(BaseModel):
    out: DenominationCountIn = Field(alias="out")
    in_: DenominationCountIn = Field(alias="in")

    model_config = ConfigDict(populate_by_name=True)


class CashSwapOut(BaseModel):
    id: int
    amount: int
    at: datetime


# ---------------------------------------------------------------------------
# Retiros
# ---------------------------------------------------------------------------


class CashPickupIn(BaseModel):
    amount: int = Field(gt=0)
    denominations: list[DenominationIn] | None = None
    envelope_ref: str | None = None
    authorizer_pin: str
    note: str | None = None
    photo: str | None = None


class CashPickupOut(OutModel):
    id: int
    amount: int
    envelope_ref: str | None = None
    expected_at_pickup: int | None = None
    authorized_by_employee_id: int
    authorized_by_employee_name: str
    at: datetime
    reversed_at: datetime | None = None
    reversed_reason: str | None = None


class CashPickupReverseIn(BaseModel):
    reason: str
    authorizer_pin: str


# ---------------------------------------------------------------------------
# Cierre a ciegas en tres pasos
# ---------------------------------------------------------------------------


class CloseCountIn(BaseModel):
    counted_cash: DenominationCountIn
    counted_card: int | None = None
    counted_transfer: int | None = None
    tips_cash_out: int = 0
    photo: str | None = None


class CloseCountOut(BaseModel):
    count_id: int


class CardTransferReview(BaseModel):
    registered: int
    counted: int | None
    difference: int | None


class CloseReviewOut(BaseModel):
    count_id: int
    expected: int
    difference: int
    equation: BreakdownOut
    card: CardTransferReview
    transfer: CardTransferReview
    requires_cause: bool
    requires_identified_cause: bool
    is_critical: bool
    closes_day_suggested: bool
    open_orders: int = 0


class CloseConfirmIn(BaseModel):
    difference_seen: int
    cause: CashDifferenceCauseLiteral | None = None
    note: str | None = None
    closes_day: bool = False
    transfer_open_orders: bool = False


class CloseConfirmOut(BaseModel):
    to_deposit: int
    closes_day: bool


# ---------------------------------------------------------------------------
# Cierre en un paso (cash.blind_close apagado)
# ---------------------------------------------------------------------------


class SingleStepCloseIn(BaseModel):
    counted_cash: DenominationCountIn
    counted_card: int | None = None
    counted_transfer: int | None = None
    tips_cash_out: int = 0
    photo: str | None = None
    cause: CashDifferenceCauseLiteral | None = None
    note: str | None = None
    closes_day: bool = False
    transfer_open_orders: bool = False


class SingleStepCloseOut(BaseModel):
    to_deposit: int
    closes_day: bool
    expected: int
    difference: int


# ---------------------------------------------------------------------------
# Resumen completo del turno
# ---------------------------------------------------------------------------


class ShiftSummaryOut(BaseModel):
    id: int
    business_date: date
    status: str
    opened_at: datetime
    opened_by: EmployeeRef
    cash_responsible: EmployeeRef
    opening_cash_total: int
    cash_reserve: int
    roster: list[RosterEntryOut]
    movements: list[CashMovementOut]
    swaps: list[CashSwapOut]
    pickups: list[CashPickupOut]
    handovers: list[HandoverOut]
    expected_cash: int | None = None
    sales: SalesByMethodOut | None = None
    tips: SalesByMethodOut | None = None
    counted_cash: int | None = None
    difference: int | None = None
    close_cause: CashDifferenceCauseLiteral | None = None
    to_deposit: int | None = None
    closed_at: datetime | None = None
    closed_without_count: bool = False
    reviewed_by: EmployeeRef | None = None
    reviewed_at: datetime | None = None


# ---------------------------------------------------------------------------
# Admin: listados, rescates, timeline y actividad
# ---------------------------------------------------------------------------


class AdminShiftListItem(BaseModel):
    id: int
    business_date: date
    store_id: int
    status: str
    opened_at: datetime
    closed_at: datetime | None = None
    cash_responsible: EmployeeRef
    expected_cash: int | None = None
    counted_cash: int | None = None
    difference: int | None = None
    is_stale: bool
    reviewed_at: datetime | None = None


class TimelineEventOut(BaseModel):
    at: datetime
    kind: str
    summary: str
    employee_name: str | None = None
    data: dict = Field(default_factory=dict)


class AdminReviewIn(BaseModel):
    note: str | None = None


class AdminCloseAdministrativeIn(BaseModel):
    reason: str


class AdminReopenIn(BaseModel):
    reason: str


class AdminAdjustOpeningIn(BaseModel):
    opening_cash: DenominationCountIn
    cash_reserve: int
    reason: str


class BusinessDayListItem(BaseModel):
    business_date: date
    status: str
    shifts: list[AdminShiftListItem]


class EmployeeActivityShift(BaseModel):
    shift_id: int
    business_date: date
    role: str
    in_at: datetime | None = None
    out_at: datetime | None = None
    was_cash_responsible: bool
    difference: int | None = None


class EmployeeActivitySales(BaseModel):
    """Ventas **netas** (sin propina, sin impuesto — KPI §10 de la spec de
    negocio) atribuidas a las comandas que esta persona abrió y que llegaron
    a pagarse, leídas de los snapshots (`FiscalDocument`), nunca revaloradas
    con la carta actual."""

    net: int
    orders: int
    avg_ticket: int | None = None


class EmployeeActivityVoids(BaseModel):
    """Anulaciones de ítem que esta persona ejecutó (`OrderItem
    .voided_by_employee_id`), `docs/SPEC-NEGOCIO.md §3.5`. `amount` es el
    valor de lista de lo anulado (precio unitario × cantidad, antes de
    descuento); `pct_of_sales` es ese monto sobre `sales.net` de la misma
    persona (`null` si no tuvo ventas en el período)."""

    n: int
    amount: int
    pct_of_sales: float | None = None
    after_bill: int
    on_cash: int
    walkouts: int


class EmployeeActivityDiscounts(BaseModel):
    n: int
    amount: int


class EmployeeActivityCourtesies(BaseModel):
    n: int
    amount: int
    # Pedido 2a: `amount` es a PRECIO DE VENTA (lo que el cliente no pagó) y
    # `theoretical_cost` es lo que le costó al restaurante. Una cortesía
    # valorada a precio exagera lo regalado; la cifra con la que se puede mirar
    # a alguien a la cara es el costo. `None` —nunca `0` mudo— cuando ningún
    # ítem tenía costo congelado (`catalog.recipes` apagada, o plato sin ficha).
    theoretical_cost: int | None = None


class EmployeeActivityTips(BaseModel):
    cash: int
    card: int
    transfer: int
    other: int
    total: int


class EmployeeActivityMetrics(BaseModel):
    sales: EmployeeActivitySales
    voids: EmployeeActivityVoids
    discounts: EmployeeActivityDiscounts
    courtesies: EmployeeActivityCourtesies
    reprints: int
    sent_at_payment_pct: float | None = None
    tips: EmployeeActivityTips


class EmployeeActivityOut(BaseModel):
    employee: EmployeeRef
    shifts: list[EmployeeActivityShift]
    difference_streak: int
    authorizations_given: list[dict]
    # `None` cuando `app.orders`/`app.payments`/`app.fiscal` no están
    # disponibles (protegido con `find_spec_safe`, igual que
    # `app.shifts.hooks.get_sales_totals`) — nunca `0` por defecto: la
    # ausencia del dato no es lo mismo que "sin actividad".
    activity: EmployeeActivityMetrics | None = None
    team_average: EmployeeActivityMetrics | None = None


# ---------------------------------------------------------------------------
# Propinas (1b-2, `docs/SPEC-NEGOCIO.md §6.2`)
# ---------------------------------------------------------------------------


class TipsByEmployeeOut(BaseModel):
    employee_id: int
    employee_name: str
    cash: int
    card: int
    transfer: int
    other: int
    total: int


class ShiftTipsOut(BaseModel):
    by_method: SalesByMethodOut
    by_employee: list[TipsByEmployeeOut]
    # Efectivo: sale del cajón al cierre. Electrónicas: pasivo con el
    # personal (Ley 1935 de 2018) — `by_method.card + transfer + other`.
    cash_out: int
    electronic_liability: int


class TipPayoutDistributionIn(BaseModel):
    employee_id: int
    amount: int = Field(ge=0)


class TipPayoutIn(BaseModel):
    shift_ids: list[int] = Field(min_length=1)
    distribution: list[TipPayoutDistributionIn] = Field(min_length=1)
    paid_at: datetime
    method: str


class TipPayoutDistributionOut(OutModel):
    employee_id: int
    employee_name: str
    amount: int


class TipPayoutOut(OutModel):
    id: int
    shift_ids: list[int]
    paid_at: datetime
    method: str
    total_amount: int
    created_by: EmployeeRef
    created_at: datetime
    distribution: list[TipPayoutDistributionOut]
