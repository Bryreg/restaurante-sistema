"""Esquemas Pydantic del cobro y del comprobante
(`CONTRATO-INTERNO-1b-1.md §2.4`). Ningún esquema de este módulo tiene
`cost`/`margin`/`unit_cost`: el operador no recibe costos (`AGENTS.md`).
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.fiscal.schemas import FiscalRangeRefOut
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


class CustomerConsentIn(BaseModel):
    """Prueba de habeas data (Ley 1581 de 2012, SPEC-NEGOCIO §8.4): finalidad
    declarada, canal y versión de texto — el POS sólo la crea al cobrar; el
    admin la administra (`app.customers`)."""

    text_version: str
    channel: str


class CustomerIn(BaseModel):
    """`customer?` de `POST /orders/{id}/payments`: el dispositivo sólo CREA
    clientes al cobrar (SPEC-NEGOCIO §8.3, §8.4). Se resuelve vía
    `app.customers.hooks.upsert_customer_with_consent` (protegido con
    `find_spec_safe`, `app.fiscal.service.resolve_customer_snapshot`).
    `consent` es obligatorio en cuanto se manda `customer` (spec.md: no
    lleva `?`) — proveer los datos para pedir factura ES el acto de
    autorizar esa finalidad, pero la prueba (texto y canal) igual se
    registra siempre."""

    doc_type: str
    doc_number: str
    dv: str | None = None
    name: str
    email: str | None = None
    address: str | None = None
    municipality_dane: str | None = None
    consent: CustomerConsentIn


class PaymentIn(BaseModel):
    expected_version: int | None = None
    sub_account_id: int | None = None
    pin: str
    tip: TipIn | None = None
    splits: list[PaymentSplitIn] = Field(default_factory=list)
    customer: CustomerIn | None = None
    requests_invoice: bool = False


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
    # A-10 (`outputs-1b-1/auditor-venta.md §3`): «Total a cobrar» (venta +
    # propina) SIEMPRE sumado acá, nunca `?? 0` en el cliente. `null` no es 0.
    amount_due: int
    requires_invoice: bool
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
    email: str | None = None
    address: str | None = None
    municipality_dane: str | None = None


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
    """A-11 (`outputs-1b-1/auditor-venta.md §3`): la leyenda legal SIEMPRE
    sale del servidor (`DocumentPrintableOut.legend`, sin respaldo posible en
    el cliente); acá va lo que en 1b-2 la hace variar — estado DIAN y
    contingencia — más el rango vigente que amparó el consecutivo."""

    dian_status: DianStatusLiteral | None = None
    cude: str | None = None
    qr_url: str | None = None
    contingency: bool = False
    range: FiscalRangeRefOut | None = None


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


# ---------------------------------------------------------------------------
# Dispositivo: `GET /device/payment-methods`
# ---------------------------------------------------------------------------


class DevicePaymentMethodOut(BaseModel):
    """Medios de pago habilitados de la sede, para que el POS deje de ofrecer
    siempre los mismos seis códigos fijos (gap declarado en
    `outputs-1b-1/*.md`). Sin costos ni márgenes: sólo lo que el operador
    necesita para cobrar."""

    code: str
    label: str
    dian_code: str
    requires_reference: bool
