"""Esquemas Pydantic de los reportes del administrador
(`features/fase-1b-venta/spec.md` «Admin reports», `docs/SPEC-NEGOCIO.md §9.3`
y `§10`). Sólo lectura: ningún esquema de este módulo tiene `cost`/`margin`
(el operador no los ve, y estas rutas son de admin de todos modos), y ningún
campo de plata puede faltar en silencio — cuando no hay dato, el campo es
`None` (`null` en la respuesta), nunca `0`.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel

GroupBy = Literal["business_date", "shift", "method", "channel", "employee", "hour", "zone"]


class EmployeeRefOut(BaseModel):
    id: int
    name: str


# ---------------------------------------------------------------------------
# GET /admin/today
# ---------------------------------------------------------------------------


class HourBucketOut(BaseModel):
    hour: int
    gross: int
    net: int


class MethodAmountOut(BaseModel):
    method: str
    amount: int


class OpenOrderAgeOut(BaseModel):
    id: int
    channel: str
    tables: list[str]
    opened_at: datetime
    minutes_since_opened: int
    bill_presented_at: datetime | None
    minutes_since_bill_presented: int | None
    unsent_flag: bool
    unpaid_flag: bool
    total: int


class UnavailableProductOut(BaseModel):
    product_id: int
    name: str
    unavailable_at: datetime
    by: EmployeeRefOut | None


class AlertOut(BaseModel):
    type: str
    level: str
    title: str
    body: str
    created_at: datetime
    payload: dict[str, Any] | None = None


class TodayOut(BaseModel):
    store_id: int
    business_date: date
    sales_by_hour: list[HourBucketOut]
    gross: int
    net: int
    tax: int
    tips_total: int
    tips_by_method: list[MethodAmountOut]
    orders: int
    covers: int | None
    avg_ticket: int | None
    avg_per_cover: int | None
    tables_occupied: int
    tables_total: int
    open_orders: list[OpenOrderAgeOut]
    unsent_count: int
    unpaid_count: int
    expected_cash: int | None
    unavailable_products: list[UnavailableProductOut]
    pending_refunds_count: int
    unreviewed_closes_count: int
    alerts: list[AlertOut]


# ---------------------------------------------------------------------------
# GET /admin/sales
# ---------------------------------------------------------------------------


class SalesBucketOut(BaseModel):
    key: str
    label: str
    gross: int
    net: int
    tax: int
    tips: int
    orders: int
    covers: int | None
    avg_ticket: int | None
    avg_per_cover: int | None


class SalesReportOut(BaseModel):
    store_id: int
    date_from: date
    date_to: date
    group_by: GroupBy
    rows: list[SalesBucketOut]
    total: SalesBucketOut


# ---------------------------------------------------------------------------
# GET /admin/accountant-report
# ---------------------------------------------------------------------------


class AccountantRateBreakdownOut(BaseModel):
    rate: int
    documents_base: int
    documents_tax: int
    notes_base: int
    notes_tax: int


class AccountantRowOut(BaseModel):
    business_date: date
    documents_count: int
    notes_count: int
    tips_amount: int
    by_rate: list[AccountantRateBreakdownOut]


class AccountantReportOut(BaseModel):
    store_id: int
    year: int
    period_kind: Literal["bimester", "month"]
    period: int
    date_from: date
    date_to: date
    rows: list[AccountantRowOut]
    totals_by_method: list[MethodAmountOut]
    documents_total_base: int
    documents_total_tax: int
    notes_total_base: int
    notes_total_tax: int
    tips_total: int


# ---------------------------------------------------------------------------
# GET /admin/unavailable-log
# ---------------------------------------------------------------------------


class UnavailableLogRowOut(BaseModel):
    product_id: int
    name: str
    unavailable_at: datetime
    by: EmployeeRefOut | None
    estimated_lost_units: int | None
    estimated_lost_sales: int | None
