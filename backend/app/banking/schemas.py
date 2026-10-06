"""Esquemas Pydantic de `banking`.

Dinero siempre en `int` (pesos enteros). Todo indicador sin datos
suficientes viaja como `None` **acompañado de** `reason` — nunca `0`, nunca
una lista vacía muda (`docs/CONTEXTO-AGENTES.md §9`). Valores derivados
(`net_amount`, `lag_days`, `outstanding`, `allocated_amount`…) se calculan en
`app.banking.service`/`app.banking.router`, nunca se guardan.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.photos.hooks import PhotoIn

BankDepositStatusLiteral = Literal["live", "reversed"]
DepositSourceLiteral = Literal["admin", "pos"]
SettlementStatusLiteral = Literal["recorded", "matched", "reversed"]


class OutModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---------------------------------------------------------------------------
# Consignaciones (`GET`/`POST /admin/deposits`).
# ---------------------------------------------------------------------------


class DepositAllocationIn(BaseModel):
    shift_id: int
    amount: int = Field(gt=0)


class DepositAllocationOut(BaseModel):
    shift_id: int
    amount: int


class DepositIn(BaseModel):
    amount: int = Field(gt=0)
    # `None` -> la fecha de negocio de HOY para la sede (`today_business_date`,
    # nunca `datetime.utcnow().date()`). Quien registra una consignación de un
    # día anterior la manda explícita.
    business_date: date | None = None
    # `None` -> `clock.now_utc()`. Si viene de un `<input type="datetime-local">`
    # (naive), el router la pasa por `app.core.tz.from_bogota_wall_clock`.
    deposited_at: datetime | None = None
    bank_name: str | None = Field(default=None, max_length=120)
    bank_reference: str | None = Field(default=None, max_length=120)
    receipt_photo: PhotoIn = Field(min_length=1, description="Comprobante: obligatorio (foto o su dirección)")
    note: str | None = Field(default=None, max_length=500)
    allocations: list[DepositAllocationIn] = Field(default_factory=list)


class DepositOut(OutModel):
    id: int
    store_id: int
    business_date: date
    deposited_at: datetime
    amount: int
    allocated_amount: int
    unallocated_amount: int
    bank_name: str | None
    bank_reference: str | None
    receipt_photo: str
    note: str | None
    status: BankDepositStatusLiteral
    employee_name: str
    allocations: list[DepositAllocationOut]
    reversed_at: datetime | None = None
    reversed_reason: str | None = None
    reversed_by_employee_name: str | None = None
    # Consignar desde el POS (2026-09-24): de dónde salió y si ya la confirmó
    # el administrador. `needs_confirmation`: viva y sin confirmar.
    source: DepositSourceLiteral = "admin"
    from_shift_id: int | None = None
    confirmed_at: datetime | None = None
    confirmed_by_employee_name: str | None = None
    needs_confirmation: bool = False


class PosDepositIn(BaseModel):
    """Una consignación que registra quien tiene la caja, con la plata de un
    día anterior que está en el cajón del turno abierto. El servidor la imputa
    entera a ese día: `source_shift_id` es el turno de origen."""

    source_shift_id: int
    amount: int = Field(gt=0)
    bank_name: str | None = Field(default=None, max_length=120)
    bank_reference: str | None = Field(default=None, max_length=120)
    receipt_photo: PhotoIn = Field(min_length=1, description="Comprobante: obligatorio")
    note: str | None = None


class DrawerDayOut(BaseModel):
    """Un día anterior cuya plata está en el cajón del turno abierto."""

    source_shift_id: int
    business_date: date
    #: El saldo que tenía al abrir, cuando se marcó.
    carried: int
    #: Lo que ya se consignó de ese día desde este cajón (vivo).
    deposited_from_drawer: int
    #: Lo que queda de ese día en el cajón y todavía se puede consignar.
    remaining: int


class DrawerOut(BaseModel):
    """`GET /deposits/drawer`: lo que el POS puede consignar ahora."""

    shift_id: int | None
    days: list[DrawerDayOut]
    deposits: list[DepositOut]
    # Los bancos a los que la sede consignó últimamente, el último usado
    # primero: la tablet los ofrece como botones en vez de hacer teclear el
    # banco cada vez.
    recent_banks: list[str] = Field(default_factory=list)


class DepositReverseIn(BaseModel):
    reason: str = Field(min_length=1, max_length=500)


# ---------------------------------------------------------------------------
# Saldo por consignar (`GET /admin/deposits/pending`).
# ---------------------------------------------------------------------------


class CascadeLinkOut(BaseModel):
    """Una línea de procedencia de la cascada (decisión del dueño, 2026-09-29)."""

    shift_id: int
    business_date: date
    amount: int


class PendingDepositRowOut(BaseModel):
    shift_id: int
    business_date: date
    # `None` con `reason` cuando el turno cerró sin conteo
    # (`Shift.to_deposit IS NULL`) — leído tal cual de `Shift.to_deposit`,
    # nunca recalculado.
    to_deposit: int | None
    reason: str | None = None
    deposited: int
    # Después de la cascada (`app.banking.hooks.store_balances`): nunca
    # negativo. Un turno que pagó del cajón más de lo que entró queda en 0 y
    # dice quién le tapó el hueco (`covered_by`); el que lo tapó dice a quién
    # (`covered`). Lo que no encontró de dónde cobrarse: `uncovered_shortfall`.
    outstanding: int | None
    covered: list[CascadeLinkOut] = []
    covered_by: list[CascadeLinkOut] = []
    uncovered_shortfall: int = 0


# ---------------------------------------------------------------------------
# Libro del banco (`GET /admin/bank/ledger`).
# ---------------------------------------------------------------------------


LedgerEntryKindLiteral = Literal[
    "deposit",
    "card_settlement",
    "transfer",
    "platform_settlement",
    "expense",
    "obligation",
    "supplier_payment",
    "movement",
]
# Los renglones derivados que el dueño puede mover de cuenta
# (`POST /admin/bank/assignments`). "transfer" se rutea por cuenta
# (`receives_transfers`) y "movement" ya lleva su cuenta.
AssignableKindLiteral = Literal[
    "deposit", "card_settlement", "platform_settlement", "expense", "obligation", "supplier_payment"
]
DirectionLiteral = Literal["in", "out"]
BankMovementCauseLiteral = Literal[
    "payroll",
    "bank_fee",
    "tax",
    "owner_withdrawal",
    "owner_contribution",
    "account_transfer",
    "interest",
    "adjustment",
    "other",
]


class LedgerEntryOut(BaseModel):
    kind: LedgerEntryKindLiteral
    # `None` para "transfer": es un renglón derivado de `Payment`, sin fila
    # propia en este dominio.
    id: int | None = None
    business_date: date
    # Siempre positivo: cuánto se movió. El sentido lo dice `direction`.
    amount: int
    direction: DirectionLiteral = "in"
    account_id: int | None = None
    account_name: str = ""
    # 4×1000 derivado de esta salida (0 en entradas y en cuentas exentas).
    gmf: int = 0
    # Lo que este renglón le hace al saldo: `+amount` o `-(amount + gmf)`.
    net_effect: int = 0
    # Saldo de SU cuenta después de este renglón; `None` si la cuenta no
    # tiene saldo del extracto anterior a este día (nadie sabe cuánto había).
    balance_after: int | None = None
    assignable: bool = False
    cause: BankMovementCauseLiteral | None = None
    description: str | None = None
    gross_amount: int | None = None
    commission_amount: int | None = None
    retention_amount: int | None = None
    settled_business_date: date | None = None
    lag_days: int | None = None
    reference: str | None = None
    note: str | None = None
    status: str | None = None


class BankLedgerTotalsOut(BaseModel):
    deposits: int
    card_settlements_net: int
    transfers: int
    # Lo que entró en el período (todas las entradas). Antes de 0046 era la
    # suma de las tres de arriba; ahora suma también las liquidaciones de
    # plataformas y las entradas tecleadas.
    total: int
    platform_settlements_net: int = 0
    other_inflows: int = 0
    inflows: int = 0
    expenses: int = 0
    obligations: int = 0
    supplier_payments: int = 0
    other_outflows: int = 0
    outflows: int = 0
    gmf: int = 0
    net: int = 0


class BankLedgerOut(BaseModel):
    date_from: date
    date_to: date
    account_id: int | None = None
    entries: list[LedgerEntryOut]
    totals: BankLedgerTotalsOut


# ---------------------------------------------------------------------------
# Cuentas, saldo del extracto, movimientos tecleados, asignaciones,
# posición de hoy y proyección (0046).
# ---------------------------------------------------------------------------


class BankAccountOut(BaseModel):
    # `None`: la cuenta principal todavía no se creó (nace con la primera
    # escritura del libro); hasta entonces los renglones van a ella igual.
    id: int | None
    name: str
    is_default: bool
    gmf_exempt: bool
    receives_transfers: bool
    active: bool


class BankAccountIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    gmf_exempt: bool = False
    receives_transfers: bool = False
    is_default: bool = False


class BankAccountPatchIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    gmf_exempt: bool | None = None
    receives_transfers: bool | None = None
    is_default: bool | None = None
    active: bool | None = None


class BankAnchorIn(BaseModel):
    # `None` -> la cuenta principal.
    account_id: int | None = None
    # `None` -> hoy (fecha de negocio de la sede).
    balance_date: date | None = None
    # Puede ser negativo (sobregiro): es lo que dice el extracto.
    balance: int = Field(ge=-9_999_999_999, le=9_999_999_999)
    note: str | None = Field(default=None, max_length=500)


class BankAnchorOut(BaseModel):
    id: int
    account_id: int
    account_name: str
    balance_date: date
    balance: int
    note: str | None
    employee_name: str | None
    created_at: datetime
    voided_at: datetime | None
    voided_reason: str | None
    voided_by_employee_name: str | None


class BankVoidIn(BaseModel):
    reason: str = Field(min_length=1, max_length=500)


class BankMovementIn(BaseModel):
    # `None` -> la cuenta principal.
    account_id: int | None = None
    direction: DirectionLiteral
    cause: BankMovementCauseLiteral
    # `None` -> hoy (fecha de negocio de la sede).
    business_date: date | None = None
    amount: int = Field(gt=0, le=9_999_999_999)
    description: str = Field(min_length=1, max_length=200)
    # Sólo con `cause = account_transfer`: la cuenta que recibe.
    counter_account_id: int | None = None


class BankMovementOut(BaseModel):
    id: int
    account_id: int
    account_name: str
    counter_account_id: int | None
    counter_account_name: str | None
    direction: DirectionLiteral
    cause: BankMovementCauseLiteral
    business_date: date
    amount: int
    description: str
    employee_name: str | None
    created_at: datetime
    voided_at: datetime | None
    voided_reason: str | None
    voided_by_employee_name: str | None


class BankAssignmentIn(BaseModel):
    source_kind: AssignableKindLiteral
    source_id: int
    account_id: int


class BankAssignmentOut(BaseModel):
    source_kind: AssignableKindLiteral
    source_id: int
    account_id: int
    account_name: str


class BankAccountPositionOut(BaseModel):
    account: BankAccountOut
    anchor_id: int | None
    anchor_date: date | None
    anchor_balance: int | None
    # Días desde el saldo del extracto: dice «saldo del viernes» en vez de
    # hacerlo pasar por el de hoy.
    anchor_age_days: int | None
    # Lo que se movió después del ancla, hasta hoy. `None` sin ancla.
    inflows: int | None
    outflows: int | None
    gmf: int | None
    balance: int | None
    reason: str | None


class BankPositionOut(BaseModel):
    as_of: date
    accounts: list[BankAccountPositionOut]
    # Suma de las cuentas activas; `None` si alguna no tiene saldo del
    # extracto (`total_reason` dice cuál). Nunca un total parcial callado.
    total: int | None
    total_reason: str | None
    gmf_per_mille: int


class BankProjectionMonthOut(BaseModel):
    year: int
    month: int
    date_from: date
    date_to: date
    expected_inflows: int | None
    scheduled_obligations: int
    payables_due: int
    recurring_expenses: int | None
    gmf: int | None
    net: int | None
    closing_balance: int | None


class BankProjectionOut(BaseModel):
    as_of: date
    starting_balance: int | None
    reason: str | None
    history_months: int
    avg_monthly_inflows: int | None
    avg_monthly_recurring_expenses: int | None
    overdue_obligations: int
    overdue_payables: int
    months: list[BankProjectionMonthOut]


# ---------------------------------------------------------------------------
# Mano del dueño (`GET /admin/bank/owner-hand`).
# ---------------------------------------------------------------------------


class OwnerHandOut(BaseModel):
    date_from: date
    date_to: date
    withdrawn: int
    deposited: int
    spent: int
    balance: int
    # Desglose informativo de las mismas sumas de arriba (nunca una cifra
    # nueva): de dónde sale `withdrawn` y `spent`.
    withdrawn_from_pickups: int
    # c9: sobres entregados — sólo la plata de cierres que ya NO está en el
    # cajón (la apertura «igual al café» deja el resto adentro). Reemplaza a
    # `withdrawn_from_shift_close`, que sumaba también la plata del cajón.
    withdrawn_from_envelopes: int
    spent_on_tips: int
    spent_on_refunds: int
    # c9: gastos y obligaciones pagados «de la mano del dueño».
    spent_on_expenses: int = 0
    # c9, lo que NO entra (publicado para que la exclusión no sea
    # silenciosa): la plata por consignar de cierres que sigue en el cajón,
    # y lo consignado desde el cajón (POS), que va al banco sin pasar por la
    # mano. Ninguno de los dos suma ni resta en `balance`.
    still_in_drawer: int = 0
    deposited_from_drawer: int = 0
    # A-2: cuántos turnos cerrados SIN CONTEO quedaron fuera de `withdrawn`.
    # No es una cifra de plata y no puede serlo: el monto de esos turnos sale
    # del libro y no de un arqueo, y publicarlo sería volver a afirmar lo que
    # nadie contó. Publicar el CONTEO deja la exclusión a la vista en vez de
    # silenciosa — "todo sesgo se declara" (SPEC-NEGOCIO §6.1).
    uncounted_shifts: int
    # A-3: cuántos repartos de propinas en efectivo del período NO declararon
    # de dónde salió la plata (filas anteriores a la columna `paid_from`). Se
    # cuentan como salidos de la mano —el sesgo que muestra menos plata— y el
    # conteo se publica para que esa suposición esté a la vista.
    tip_payouts_unknown_source: int
    # Informe de visualización #15: fecha de negocio del cierre contado más
    # viejo que todavía tiene saldo por consignar, y cuántos días lleva a
    # hoy. `None` (los dos) si no queda plata de cierres sin consignar.
    oldest_undeposited_date: date | None = None
    oldest_undeposited_days: int | None = None
    # Desde cuántos días sin consignar la tarjeta pasa a ámbar: el de la sede
    # (Ajustes › Caja, `deposit_overdue_days`, 0035). Es un umbral de
    # lectura, no una cifra de plata; antes estaba quemado en la pantalla.
    overdue_days: int = 3


# ---------------------------------------------------------------------------
# Conciliación de datáfono (`.../reconciliation/card`).
# ---------------------------------------------------------------------------


class CardSettlementIn(BaseModel):
    sales_business_date: date
    settled_business_date: date
    gross_amount: int = Field(gt=0)
    commission_amount: int = Field(ge=0, default=0)
    retention_amount: int = Field(ge=0, default=0)
    reference: str | None = Field(default=None, max_length=120)
    note: str | None = Field(default=None, max_length=500)


class CardSettlementOut(OutModel):
    id: int
    store_id: int
    sales_business_date: date
    settled_business_date: date
    lag_days: int
    gross_amount: int
    commission_amount: int
    retention_amount: int
    net_amount: int
    reference: str | None
    note: str | None
    status: SettlementStatusLiteral
    employee_name: str
    created_at: datetime
    matched_at: datetime | None = None
    matched_by_employee_name: str | None = None
    reversed_at: datetime | None = None
    reversed_reason: str | None = None
    reversed_by_employee_name: str | None = None


class CardReconciliationRowOut(BaseModel):
    business_date: date
    expected: int
    settled: int
    difference: int
    matched: bool
    settlement_ids: list[int]


class CardReconciliationOut(BaseModel):
    date_from: date
    date_to: date
    rows: list[CardReconciliationRowOut]
    unmatched_count: int


# ---------------------------------------------------------------------------
# Conciliación de plataformas (`.../reconciliation/platform`).
# ---------------------------------------------------------------------------


class PlatformSettlementIn(BaseModel):
    platform_id: int
    period_from: date
    period_to: date
    gross_amount: int = Field(gt=0)
    commission_amount: int = Field(ge=0, default=0)
    reference: str | None = Field(default=None, max_length=120)
    note: str | None = Field(default=None, max_length=500)


class PlatformSettlementOut(OutModel):
    id: int
    store_id: int
    platform_id: int
    period_from: date
    period_to: date
    gross_amount: int
    commission_amount: int
    net_amount: int
    reference: str | None
    note: str | None
    status: SettlementStatusLiteral
    employee_name: str
    created_at: datetime
    matched_at: datetime | None = None
    matched_by_employee_name: str | None = None
    reversed_at: datetime | None = None
    reversed_reason: str | None = None
    reversed_by_employee_name: str | None = None


class PlatformReconciliationRowOut(BaseModel):
    platform_id: int
    platform_name: str
    expected: int
    settled: int
    difference: int
    matched: bool
    settlement_ids: list[int]


class PlatformReconciliationOut(BaseModel):
    date_from: date
    date_to: date
    rows: list[PlatformReconciliationRowOut]
    unmatched_count: int


class SettleIn(BaseModel):
    note: str | None = Field(default=None, max_length=500)


class SettlementReverseIn(BaseModel):
    reason: str = Field(min_length=1, max_length=500)
