"""Esquemas Pydantic de `payroll`.

Dinero en `int` (pesos enteros). Horas en `str` (texto decimal de dos
decimales, vía `app.core.hours.format_hours`) para publicarlas — nunca un
`float` de JSON — más los minutos enteros crudos, por si un cliente
necesita sumarlos sin volver a parsear texto (ver `HoursRowOut`). Porcentajes
en puntos básicos (`_bp`). Todo indicador sin datos suficientes es `None`
**con** `reason` — nunca `0` mudo, nunca una lista vacía sin explicar.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

TipMethodLiteral = Literal["equal_shares", "by_hours", "by_area"]


class OutModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---------------------------------------------------------------------------
# Jornada del período — GET /admin/payroll/hours
# ---------------------------------------------------------------------------


class HoursRowOut(BaseModel):
    employee_id: int
    employee_name: str
    ordinary_minutes: int
    night_minutes: int
    sunday_minutes: int
    holiday_minutes: int
    overtime_minutes: int
    ordinary_hours: str
    night_hours: str
    sunday_hours: str
    holiday_hours: str
    overtime_hours: str


class HoursOut(BaseModel):
    store_id: int
    date_from: date
    date_to: date
    rows: list[HoursRowOut]
    available: bool
    reason: str | None


# ---------------------------------------------------------------------------
# Tablas de recargos con vigencia — GET/POST /admin/payroll/surcharge-tables
# ---------------------------------------------------------------------------


class SurchargeTableIn(BaseModel):
    valid_from: date
    night_start_hour: int = Field(ge=0, le=23)
    night_end_hour: int = Field(ge=0, le=23)
    night_surcharge_bp: int = Field(ge=0, le=10_000)
    sunday_holiday_surcharge_bp: int = Field(ge=0, le=10_000)
    overtime_surcharge_bp: int = Field(ge=0, le=10_000)
    weekly_ordinary_hours: int = Field(gt=0, le=100)


class SurchargeTableOut(OutModel):
    id: int
    store_id: int
    valid_from: date
    night_start_hour: int
    night_end_hour: int
    night_surcharge_bp: int
    sunday_holiday_surcharge_bp: int
    overtime_surcharge_bp: int
    weekly_ordinary_hours: int
    created_at: datetime


# ---------------------------------------------------------------------------
# Festivos — GET/POST /admin/payroll/holidays (agregada, fuera del contrato
# mínimo — ver el entregable § 3).
# ---------------------------------------------------------------------------


class HolidayIn(BaseModel):
    holiday_date: date
    name: str = Field(min_length=1, max_length=200)


class HolidayOut(OutModel):
    id: int
    store_id: int
    holiday_date: date
    name: str


# ---------------------------------------------------------------------------
# Tarifa por hora — GET/POST /admin/payroll/wages (agregada, fuera del
# contrato mínimo — ver el entregable § 3).
# ---------------------------------------------------------------------------


class WageRateIn(BaseModel):
    employee_id: int
    hourly_wage_pesos: int = Field(gt=0)
    valid_from: date


class WageRateOut(OutModel):
    id: int
    store_id: int
    employee_id: int
    employee_name: str
    hourly_wage_pesos: int
    valid_from: date
    created_at: datetime


# ---------------------------------------------------------------------------
# Área — GET/PATCH /admin/payroll/areas (agregada, fuera del contrato
# mínimo — ver el entregable § 3).
# ---------------------------------------------------------------------------


class AreaAssignmentIn(BaseModel):
    employee_id: int
    area: str = Field(min_length=1, max_length=100)


class AreaAssignmentOut(OutModel):
    employee_id: int
    employee_name: str
    area: str
    updated_at: datetime


# ---------------------------------------------------------------------------
# Liquidación del período — GET/POST /admin/payroll/runs
# ---------------------------------------------------------------------------


class SurchargeTableUsedOut(BaseModel):
    valid_from: date
    night_start_hour: int
    night_end_hour: int
    night_surcharge_bp: int
    sunday_holiday_surcharge_bp: int
    overtime_surcharge_bp: int
    weekly_ordinary_hours: int


class PayrollRunLineOut(BaseModel):
    employee_id: int
    employee_name: str
    ordinary_minutes: int
    night_minutes: int
    sunday_minutes: int
    holiday_minutes: int
    overtime_minutes: int
    base_pay: int | None
    night_surcharge: int | None
    sunday_holiday_surcharge: int | None
    overtime_pay: int | None
    total: int | None
    pay_reason: str | None


class PayrollRunIn(BaseModel):
    date_from: date
    date_to: date


class PayrollRunOut(BaseModel):
    id: int
    store_id: int
    date_from: date
    date_to: date
    tables_used: list[SurchargeTableUsedOut]
    lines: list[PayrollRunLineOut]
    total_amount: int | None
    available: bool
    reason: str | None
    computed_at: datetime
    computed_by_employee_name: str | None


class PayrollRunSummaryOut(BaseModel):
    """Fila de `GET /admin/payroll/runs` (listado, sin líneas — para el
    detalle completo con líneas, `GET /admin/payroll/runs?id=` en el mismo
    endpoint, ver `router.py`)."""

    id: int
    store_id: int
    date_from: date
    date_to: date
    total_amount: int | None
    available: bool
    reason: str | None
    computed_at: datetime


# ---------------------------------------------------------------------------
# Reparto de propinas — GET /admin/tips/distribution/proposal,
# GET/PATCH /admin/tips/settings
# ---------------------------------------------------------------------------


class TipProposalRowOut(BaseModel):
    employee_id: int
    employee_name: str
    basis: str
    amount: int


class TipProposalOut(BaseModel):
    store_id: int
    shift_ids: list[int]
    method: TipMethodLiteral
    rows: list[TipProposalRowOut]
    total: int
    available: bool
    reason: str | None


class TipSettingsOut(OutModel):
    store_id: int
    method: TipMethodLiteral
    updated_at: datetime | None


class TipSettingsIn(BaseModel):
    method: TipMethodLiteral
