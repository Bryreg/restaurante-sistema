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

BankDepositStatusLiteral = Literal["live", "reversed"]
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
    receipt_photo: str = Field(min_length=1, max_length=500, description="Comprobante: obligatorio")
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


class DepositReverseIn(BaseModel):
    reason: str = Field(min_length=1, max_length=500)


# ---------------------------------------------------------------------------
# Saldo por consignar (`GET /admin/deposits/pending`).
# ---------------------------------------------------------------------------


class PendingDepositRowOut(BaseModel):
    shift_id: int
    business_date: date
    # `None` con `reason` cuando el turno cerró sin conteo
    # (`Shift.to_deposit IS NULL`) — leído tal cual de `Shift.to_deposit`,
    # nunca recalculado.
    to_deposit: int | None
    reason: str | None = None
    deposited: int
    outstanding: int | None


# ---------------------------------------------------------------------------
# Libro del banco (`GET /admin/bank/ledger`).
# ---------------------------------------------------------------------------


class LedgerEntryOut(BaseModel):
    kind: Literal["deposit", "card_settlement", "transfer"]
    # `None` para "transfer": es un renglón derivado de `Payment`, sin fila
    # propia en este dominio.
    id: int | None = None
    business_date: date
    # El efecto neto de este renglón sobre la plata que llegó al banco.
    amount: int
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
    total: int


class BankLedgerOut(BaseModel):
    date_from: date
    date_to: date
    entries: list[LedgerEntryOut]
    totals: BankLedgerTotalsOut


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
    withdrawn_from_shift_close: int
    spent_on_tips: int
    spent_on_refunds: int
    # A-2: cuántos turnos cerrados SIN CONTEO quedaron fuera de `withdrawn`.
    # No es una cifra de plata y no puede serlo: el monto de esos turnos sale
    # del libro y no de un arqueo, y publicarlo sería volver a afirmar lo que
    # nadie contó. Publicar el CONTEO deja la exclusión a la vista en vez de
    # silenciosa — "todo sesgo se declara" (SPEC-NEGOCIO §6.1).
    uncounted_shifts: int


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
