"""Esquemas Pydantic del cobro y del comprobante
(`CONTRATO-INTERNO-1b-1.md §2.4`). Ningún esquema de este módulo tiene
`cost`/`margin`/`unit_cost`: el operador no recibe costos (`AGENTS.md`).
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.orders.schemas import OrderOut, TaxLineOut

DianStatusLiteral = Literal["pending", "sent", "validated", "rejected", "contingency"]
DocumentTypeLiteral = Literal[
    "pos_equivalent", "invoice", "adjustment_note", "credit_note", "debit_note", "internal_receipt"
]


# ---------------------------------------------------------------------------
# Entrada
# ---------------------------------------------------------------------------


class TipIn(BaseModel):
    asked: bool
    accepted: bool = False
    modified: bool = False
    amount: int = Field(ge=0)


class PaymentSplitIn(BaseModel):
    method: str
    amount: int = Field(ge=0)
    tendered: int | None = Field(default=None, ge=0)
    reference: str | None = None


class PaymentIn(BaseModel):
    expected_version: int | None = None
    sub_account_id: int | None = None
    pin: str
    tip: TipIn | None = None
    splits: list[PaymentSplitIn] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Salida: `POST /orders/{id}/payments`
# ---------------------------------------------------------------------------


class DocumentRefOut(BaseModel):
    id: int
    document_type: DocumentTypeLiteral
    prefix: str
    number: int
    full_number: str
    dian_status: DianStatusLiteral | None
    legend: str
    cude: str | None = None
    qr_url: str | None = None
    contingency: bool = False


class PaymentOut(BaseModel):
    order_id: int
    sub_account_id: int | None
    document: DocumentRefOut | None
    total: int
    tip_amount: int
    change: int
    paid_at: datetime
    order: OrderOut


# ---------------------------------------------------------------------------
# Salida: `GET /documents/{id}`
# ---------------------------------------------------------------------------


class DocumentStoreOut(BaseModel):
    legal_name: str | None
    nit: str | None
    dv: str | None
    address: str | None
    municipality_dane: str | None


class DocumentCustomerOut(BaseModel):
    doc_type: str
    doc_number: str
    name: str


class DocumentOrderRefOut(BaseModel):
    id: int
    channel: str
    tables: list[str]
    covers: int | None
    served_by: str
    charged_by: str


class DocumentLineOut(BaseModel):
    item_id: int
    qty: int
    description: str
    unit_price: int
    gross: int
    discount: int
    net: int
    tax_rate: int
    base: int
    tax: int
    courtesy: bool


class DocumentTipOut(BaseModel):
    amount: int
    suggested_pct: float | None
    accepted: bool | None
    modified: bool | None


class DocumentPaymentLineOut(BaseModel):
    method: str
    label: str
    dian_code: str
    amount: int
    tip_amount: int
    tendered: int | None
    change: int
    reference: str | None


class DocumentReprintOut(BaseModel):
    at: datetime
    by: str


class DocumentFiscalOut(BaseModel):
    range: Any | None = None
    cude: str | None = None
    qr_url: str | None = None


class DocumentPrintableOut(BaseModel):
    id: int
    document_type: DocumentTypeLiteral
    type_label: str
    prefix: str
    number: int
    full_number: str
    dian_status: DianStatusLiteral | None
    legend: str
    business_date: date
    issued_at: datetime
    store: DocumentStoreOut
    customer: DocumentCustomerOut
    order: DocumentOrderRefOut
    lines: list[DocumentLineOut]
    subtotal: int
    discount_total: int
    tax_lines: list[TaxLineOut]
    tax_total: int
    total: int
    tip: DocumentTipOut | None
    payments: list[DocumentPaymentLineOut]
    change: int
    print_count: int
    reprint_count: int
    reprints: list[DocumentReprintOut]
    fiscal: DocumentFiscalOut


# ---------------------------------------------------------------------------
# Admin: `GET /admin/documents`
# ---------------------------------------------------------------------------


class AdminDocumentListItem(BaseModel):
    id: int
    full_number: str
    document_type: DocumentTypeLiteral
    dian_status: DianStatusLiteral | None
    business_date: date
    issued_at: datetime
    order_id: int
    total: int
    tip_amount: int
    charged_by: str
