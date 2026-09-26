"""Esquemas Pydantic del turno de caja: el borde de validación de la API.

Todo campo de dinero es `int` (pesos enteros). `None` nunca es `0`
(`docs/SPEC-NEGOCIO.md §6.1`): los campos "contado" opcionales se dejan
`Optional[int] = None`, nunca con default `0`.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.photos.hooks import PhotoIn

RosterActionLiteral = Literal["in", "out", "pause_start", "pause_end"]
CashMovementKindLiteral = Literal["income", "expense"]
# Nombrados (y no en línea en el campo) para que
# `src/audit/api-literal-types.test.ts` pueda cruzarlos contra
# `TipPayoutMethod` y `TipPayoutSource` del cliente: un literal sin nombre no
# tiene con qué compararse.
TipPayoutMethodLiteral = Literal["cash", "card", "transfer", "other"]
TipPayoutSourceLiteral = Literal["drawer", "owner_hand", "unknown"]
# Lo que se puede DECLARAR al registrar un reparto: `unknown` es sólo para las
# filas anteriores a la columna, nunca una opción que alguien elija.
TipPayoutSourceDeclarableLiteral = Literal["drawer", "owner_hand"]
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
    # Pedido 2c: el efectivo de domicilios que entrega el domiciliario al
    # liquidar (`income`), y su espejo al deshacer la liquidación
    # (`expense`). **Contrato publicado hacia el cliente**: el cruce
    # backend→cliente de las causas lo cobra
    # `frontend/src/audit/purchases-counts.test.ts`, que LEE este `Literal`
    # y exige una etiqueta por cada valor — así que agregar esta causa
    # obliga a `frontend/src/api/shifts.ts` (`CashMovementCause`) y a
    # `frontend/src/features/shifts/MovementsPanel.tsx` (`CAUSE_LABEL`) a
    # sumar `delivery_settlement: "Liquidación de domicilios"`. Es el cruce
    # H-8/H-11 de 2b, nombrado de entrada en vez de descubierto después.
    # Nadie la puede teclear a mano: `app.shifts.service` la rechaza con
    # `400 CAUSE_NOT_MANUAL` en `POST /shifts/{id}/cash-movements`.
    "delivery_settlement",
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
    # Pedido 2c: el efectivo de domicilios sin liquidar, aparte del cajón.
    # `None` (no `0`) cuando quien pregunta no puede ver el esperado — con
    # `cash.blind_close` encendida el responsable de caja no ve plata
    # derivada hasta el paso 2 del cierre. `null` ≠ 0: "no te lo puedo
    # mostrar" no es "no hay".
    delivery_cash_pending: int | None = None
    is_stale: bool
    cash_over_threshold: bool


class OpenShiftIn(BaseModel):
    opening_cash: DenominationCountIn
    cash_reserve: int = 0
    cash_responsible_id: int
    opening_cause: CashDifferenceCauseLiteral | None = None
    opening_note: str | None = None
    # Los turnos con saldo por consignar cuya plata está físicamente en el
    # cajón (`ShiftCarryIn`). Quien abre los marca uno por uno; ninguno viene
    # marcado. El conteo de apertura los incluye.
    carried_shift_ids: list[int] = Field(default_factory=list)
    # Los sobres de días anteriores se confirman ENTEROS, aparte de la base:
    # con `True`, `opening_cash` es sólo la base contada y el servidor le
    # suma el saldo de cada día marcado (el que él mismo publica en
    # `carry-candidates`). La diferencia de apertura se mide entonces
    # contra la base fija sola. Sin la marca, el comportamiento de siempre:
    # lo contado incluye los días marcados.
    carried_counted_apart: bool = False


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
    # Inicio por rol: quien RECIBE el cajón confirma con su PIN personal. Sin
    # eso, cualquiera con la caja podía pasársela a otro sin que el otro se
    # enterara. Obligatorio en `kind="handover"`; el arqueo sorpresa no lo usa.
    new_responsible_pin: str | None = Field(default=None, pattern=r"^\d{4}$")
    authorizer_pin: str | None = None
    photo: PhotoIn | None = None


class BreakdownOut(BaseModel):
    base: int
    cash_sales: int
    incomes: int
    expenses: int
    pickups: int
    # Consignado desde el cajón en el POS (2026-09-24): resta del esperado.
    deposits: int = 0
    expected: int
    # Pedido 2c (SPEC-NEGOCIO §3.3): el efectivo de domicilios que el
    # domiciliario todavía no entregó. Renglón PROPIO y separado: **no está
    # sumado en `expected`** y no cambia su significado — es plata de la
    # sede que no está en el cajón. Cuando el domiciliario liquida, entra
    # por `incomes` como cualquier otro ingreso y este número baja.
    delivery_cash_pending: int = 0


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
    receipt_photo: PhotoIn | None = None
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
    photo: PhotoIn | None = None


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
    photo: PhotoIn | None = None


class CloseCountOut(BaseModel):
    count_id: int


class CardTransferReview(BaseModel):
    """`registered` es lo que tiene que marcar el lote: venta + propina de ese
    medio. `sales` y `tips` publican la composición para que la pantalla no
    tenga que derivarla — una sola matemática, en el backend."""

    registered: int
    sales: int
    tips: int
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
    # Lo contado tal como se selló en el paso 1 (efectivo y piezas): al
    # retomar el cierre en el paso 2 la pantalla ya no tiene lo tecleado.
    counted: int | None = None
    counted_pieces: int | None = None


class ClosePrecheckItemOut(BaseModel):
    code: Literal[
        "OPEN_ORDERS", "DELIVERY_UNSETTLED", "CARD_TOTAL_REQUIRED", "TRANSFER_TOTAL_REQUIRED", "PHOTO_REQUIRED"
    ]
    # `blocking`: el cierre no entra sin resolverlo (o sin trasladar);
    # `warning`: entra, pero conviene resolverlo antes de contar; `info`: qué
    # va a pedir el cierre.
    level: Literal["blocking", "warning", "info"]
    message: str


class SealedCountOut(BaseModel):
    count_id: int
    counted_at: datetime
    counted_by: str


class ClosePrecheckOut(BaseModel):
    """«Paso 0» del cierre (`GET /shifts/{id}/close/precheck`): lo que el
    cierre va a exigir, antes de contar. **Ningún monto**: ni el esperado,
    ni sus sumandos, ni la venta por medio — sólo conteos y sí/no, para que
    el cierre siga siendo a ciegas."""

    shift_id: int
    open_orders: int
    delivery_pending_payments: int
    delivery_pending_couriers: int
    card_total_required: bool
    transfer_total_required: bool
    photo_required: bool
    # Un conteo ya sellado y activo: la pantalla retoma en el paso 2.
    sealed_count: SealedCountOut | None
    items: list[ClosePrecheckItemOut]


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
    photo: PhotoIn | None = None
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
    # Pedido 2c: ver `ShiftCurrentOut.delivery_cash_pending`.
    delivery_cash_pending: int | None = None
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
    # Si la persona responsable sigue activa HOY. El nombre es el congelado
    # del turno; esto dice si todavía hay a quién preguntarle. `None` si la
    # fila de la persona no se encontró.
    cash_responsible_active: bool | None = None
    expected_cash: int | None = None
    counted_cash: int | None = None
    difference: int | None = None
    is_stale: bool
    reviewed_at: datetime | None = None
    # Alguno de sus conteos de cierre se hizo después de ver el esperado de
    # un conteo anterior (el paso 2 ya se había abierto).
    recounted_after_review: bool = False


class CashSummaryPersonOut(BaseModel):
    employee_id: int
    name: str
    # Cierres CONTADOS con esta persona como responsable de caja.
    closes: int
    # Σ diferencias, con signo (negativo = faltante), en pesos.
    diff_total: int
    shortage_count: int
    overage_count: int
    # Racha actual (misma regla del aviso «Racha de diferencias de caja»).
    current_streak: int


class CashSummaryDayOut(BaseModel):
    business_date: date
    closes: int
    diff_total: int


class ShiftCashSummaryOut(BaseModel):
    """`GET /admin/shifts/summary`: la cabecera de Dinero › Historial. Toda
    cifra de plata es con signo (negativo = faltante) y sólo de cierres
    contados; los administrativos van en `uncounted_count`, nunca como $0."""

    store_id: int
    date_from: date | None
    date_to: date | None
    closed_count: int
    counted_count: int
    uncounted_count: int
    diff_total: int
    shortage_total: int
    overage_total: int
    shortage_count: int
    overage_count: int
    exact_count: int
    # Tolerancia de la sede (`tolerance_unknown_cause`), en pesos.
    tolerance: int
    beyond_tolerance_count: int
    # Ordenado por `diff_total` ascendente: el faltante más grande primero.
    by_person: list[CashSummaryPersonOut]
    by_day: list[CashSummaryDayOut]


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
    """Propina del turno por persona, repartida con **la misma función** que
    reparte `by_method`: `app.shifts.hooks.payment_bucket` (ronda 2 de 2c,
    cierre de H-2). Por eso `sum(by_employee[*].cash)` es exactamente
    `by_method.cash`, y lo mismo para `card`/`transfer`/`other`.

    `delivery` (2c, aditivo con default `0`) es la propina en EFECTIVO de un
    domicilio: mientras el domiciliario no liquida la tiene él, no el cajón,
    así que no está en `cash`. **`delivery` no distingue liquidada de
    pendiente a propósito** — es «cuánta propina de domicilio generó esta
    persona» —; cuánto se puede sacar del cajón hoy lo dice `cash_out`, que
    desde la ronda 3 (H-8) suma la propina de domicilio ya liquidada y se
    publica una sola vez, en el cuerpo, no por persona.

    `total` es "cuánta propina generó esta persona", no "cuánta se le puede
    pagar hoy".
    """

    employee_id: int
    employee_name: str
    cash: int
    card: int
    transfer: int
    other: int
    # Pedido 2c: propina en efectivo de domicilios. Aditivo: default `0`.
    delivery: int = 0
    total: int


class ShiftTipsOut(BaseModel):
    by_method: SalesByMethodOut
    by_employee: list[TipsByEmployeeOut]
    # `cash_out` es **lo que sale del cajón al cierre**: propina en efectivo
    # de mostrador MÁS propina de domicilio YA LIQUIDADA. Una vez que el
    # domiciliario liquidó, esa propina está FÍSICAMENTE en el cajón (la
    # liquidación entrega venta + propina, `DeliverySettlement.tip_amount`),
    # y la lectura que autoriza sacarla tiene que decirlo: es pasivo con la
    # persona (Ley 1935 de 2018), no venta a consignar. `to_deposit`
    # (`app/shifts/service.py:1035`) resta exactamente esto, así que el
    # sobrante del conteo a ciegas queda siendo justo la propina en efectivo
    # que hay en el cajón. Identidad publicada, cerrada por el servidor:
    #
    #     cash_out == by_method.cash + delivery_tips_settled
    #
    # Electrónicas: pasivo con el personal — `by_method.card + transfer + other`.
    cash_out: int
    electronic_liability: int
    # Pedido 2c (aditivo, default `0`): la propina en EFECTIVO de domicilios
    # del turno. **Todo lo de este esquema es PROPINA, nunca venta** — por
    # eso el prefijo `delivery_tips_` y no `delivery_cash_` (ronda 3, cierre
    # de H-7): `BreakdownOut.delivery_cash_pending` (:178) y
    # `ShiftSummaryOut.delivery_cash_pending` (:367) son venta + propina
    # pendientes, otra cantidad; la misma clave con dos significados es lo
    # que hacía que alguien mostrara un número por otro.
    #
    # - `delivery_tips`: toda la propina de domicilio del turno.
    # - `delivery_tips_pending`: la que el domiciliario todavía no entregó,
    #   que por eso NO está en el cajón ni en `cash_out`.
    # - `delivery_tips_settled`: la ya liquidada, **publicada por el
    #   servidor** para que ningún cliente la derive restando (una sola
    #   matemática, y en el backend).
    #
    # Enteros, como toda la plata del sistema.
    delivery_tips: int = 0
    delivery_tips_pending: int = 0
    delivery_tips_settled: int = 0


class TipPayoutDistributionIn(BaseModel):
    employee_id: int
    amount: int = Field(ge=0)


class TipPayoutIn(BaseModel):
    shift_ids: list[int] = Field(min_length=1)
    distribution: list[TipPayoutDistributionIn] = Field(min_length=1)
    paid_at: datetime
    # El método era `str` libre, y `app.banking.service.owner_hand` filtra los
    # repartos por `method == "cash"`: un «efectivo» o un «Cash» tecleados a
    # mano desaparecían del cálculo de la mano del dueño **en silencio**. Es
    # la misma familia que A-3 —una cadena libre donde había un conjunto
    # cerrado— y se cierra igual: tipándola.
    method: TipPayoutMethodLiteral
    # A-3: de dónde sale la plata cuando el reparto es en efectivo. Sólo
    # `drawer` y `owner_hand` se pueden elegir; `unknown` existe únicamente
    # para las filas anteriores a la columna y no se acepta por la API — pedir
    # "no sé" sobre algo que se está registrando AHORA es regalar el dato.
    paid_from: TipPayoutSourceDeclarableLiteral = "owner_hand"


class TipPayoutDistributionOut(OutModel):
    employee_id: int
    employee_name: str
    amount: int


class TipPayoutOut(OutModel):
    id: int
    shift_ids: list[int]
    paid_at: datetime
    method: str
    paid_from: TipPayoutSourceLiteral
    total_amount: int
    created_by: EmployeeRef
    created_at: datetime
    distribution: list[TipPayoutDistributionOut]
