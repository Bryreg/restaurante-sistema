"""Esquemas Pydantic de `purchases`.

Cantidades y costos por unidad base viajan como texto decimal
(`app.core.quantity.parse_qty_base`/`parse_cost_micros` en la entrada,
`format_qty_base`/`format_cost_micros` en la salida) — nunca `float`, nunca
milésimas/millonésimas crudas en una respuesta. Dinero (pesos: `tax_base`,
`tax_amount`, `amount`, montos de pago) va en `int`, igual que el resto del
proyecto."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

SupplierPaymentMethodLiteral = Literal["cash", "card", "transfer", "other"]
ReceptionStatusLiteral = Literal["confirmed", "reversed"]
PayableStatusLiteral = Literal["pending_review", "approved", "cancelled"]


class OutModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---------------------------------------------------------------------------
# Proveedores.
# ---------------------------------------------------------------------------


class SupplierIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    nit: str | None = Field(default=None, max_length=20)
    payment_term_days: int = Field(ge=0, default=0)
    contact_name: str | None = Field(default=None, max_length=200)
    contact_phone: str | None = Field(default=None, max_length=40)
    invoices_required: bool = True
    active: bool = True


class SupplierUpdateIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    nit: str | None = Field(default=None, max_length=20)
    payment_term_days: int | None = Field(default=None, ge=0)
    contact_name: str | None = Field(default=None, max_length=200)
    contact_phone: str | None = Field(default=None, max_length=40)
    invoices_required: bool | None = None
    active: bool | None = None


class SupplierOut(OutModel):
    id: int
    store_id: int
    name: str
    nit: str | None
    payment_term_days: int
    contact_name: str | None
    contact_phone: str | None
    invoices_required: bool
    active: bool


class IngredientReliabilityOut(BaseModel):
    """Confiabilidad de UN insumo con UN proveedor en el período. Todo se
    calcula por insumo porque sólo dentro de un insumo las cantidades están
    en la misma unidad base (nunca se suman gramos con unidades)."""

    ingredient_id: int
    name: str
    base_unit: str
    n_receptions: int
    # Recibido ÷ facturado de este insumo, en puntos básicos (10.000 = 100 %).
    received_over_invoiced_bp: int | None
    # Deriva de precio CON SIGNO (+ subió, − bajó), en puntos básicos: la
    # mediana ponderada por plata de cada línea contra la línea anterior del
    # mismo insumo y el mismo proveedor (aunque esa anterior sea de antes del
    # período). `None` si ninguna línea tiene una anterior contra qué medir.
    price_drift_bp: int | None
    n_price_comparisons: int
    # Plata del insumo en el período (Σ cantidad recibida × costo unitario
    # sin impuesto), en pesos: el peso de este insumo en la mediana del
    # proveedor.
    spend: int


class SupplierReliabilityOut(BaseModel):
    supplier_id: int
    date_from: date
    date_to: date
    receptions: int
    # Compatibilidad con el diálogo existente: en por ciento entero,
    # redondeados de los `_bp` de abajo (misma matemática, otra unidad).
    received_over_invoiced_pct: int | None
    invoice_share_pct: int | None
    avg_price_drift_pct: int | None
    # Resumen del proveedor: mediana PONDERADA POR PLATA de los valores por
    # insumo (nunca una suma de cantidades de insumos distintos).
    received_over_invoiced_bp: int | None
    invoice_share_bp: int | None
    price_drift_bp: int | None
    n_receptions: int
    n_ingredients: int
    spend: int
    ingredients: list[IngredientReliabilityOut]


class SupplierReliabilityRowOut(SupplierReliabilityOut):
    name: str
    active: bool


class SuppliersReliabilityOut(BaseModel):
    store_id: int
    date_from: date
    date_to: date
    rows: list[SupplierReliabilityRowOut]


# ---------------------------------------------------------------------------
# Resumen de cuentas por pagar (`GET /admin/payables/summary`).
# ---------------------------------------------------------------------------

AgingBucketLiteral = Literal["current", "1_30", "31_60", "over_60"]


class PayablesAgingOut(BaseModel):
    """`current` = todavía no vence (incluye las que vencen hoy); los demás,
    días de vencida contados desde `due_date`."""

    bucket: AgingBucketLiteral
    amount: int
    count: int


class PayablesSupplierOut(BaseModel):
    supplier_id: int
    name: str
    open: int
    overdue: int


class PayablesSummaryOut(BaseModel):
    store_id: int
    as_of: date
    # Saldo vivo (monto − pagos no anulados) de las cuentas no canceladas con
    # saldo > 0, en pesos. Incluye las `pending_review`: es plata que se debe
    # aunque todavía no se haya aprobado.
    total_open: int
    total_overdue: int
    # Saldo de las que vencen entre hoy y hoy + 7 días (las dos puntas).
    due_next_7_days: int
    open_count: int
    overdue_count: int
    aging: list[PayablesAgingOut]
    by_supplier: list[PayablesSupplierOut]


# ---------------------------------------------------------------------------
# Recepciones.
# ---------------------------------------------------------------------------


class ReceptionLineIn(BaseModel):
    ingredient_id: int
    qty_received: str = Field(description='Cantidad recibida, texto decimal en la unidad base ("18.5")')
    qty_invoiced: str = Field(description='Cantidad facturada, texto decimal en la unidad base')
    purchase_unit_price: str = Field(description="Precio por UNA unidad de compra, texto decimal en pesos")
    tax_base: int = Field(ge=0, description="Base gravable de la línea, en pesos, tal como la factura")
    tax_rate: int = Field(ge=0, le=100, description="Tarifa de IVA/INC en porcentaje entero (8, 19, ...)")
    tax_amount: int = Field(ge=0, description="Valor del impuesto de la línea, en pesos, tal como la factura")
    lot_code: str | None = Field(default=None, max_length=80)
    expires_at: date | None = None


class ReceptionIn(BaseModel):
    supplier_id: int
    invoice_number: str | None = Field(default=None, max_length=80)
    invoice_date: date
    no_invoice: bool = False
    photo: str | None = Field(default=None, max_length=500)
    # D-2: lo que dice el PAPEL de la factura, en pesos — opcional (una
    # recepción `no_invoice=True` no tiene papel que copiar). Nunca
    # reemplaza el cálculo de `Payable.amount`.
    invoice_total: int | None = Field(default=None, ge=0)
    received_by_pin: str = Field(min_length=1, max_length=20)
    confirm_price: bool = Field(
        default=False,
        description="Limpia las guardas de tecleo (PRICE_LOOKS_LIKE_PACKAGE/PRICE_JUMP) de forma explícita",
    )
    lines: list[ReceptionLineIn] = Field(min_length=1)


class ReceptionLineOut(OutModel):
    id: int
    ingredient_id: int
    qty_received: str
    qty_invoiced: str
    purchase_unit_price: str
    unit_cost: str
    final_unit_cost: str
    tax_base: int
    tax_rate: int
    tax_amount: int
    lot_code: str | None
    expires_at: date | None
    stock_batch_id: int | None
    stock_movement_id: int | None


class ReceptionOut(OutModel):
    id: int
    store_id: int
    supplier_id: int
    invoice_number: str | None
    invoice_date: date
    no_invoice: bool
    invoice_total: int | None
    photo: str | None
    received_by_employee_id: int
    received_by_employee_name: str
    status: ReceptionStatusLiteral
    price_confirmed: bool
    price_confirmed_by_employee_name: str | None
    at: datetime
    business_date: date
    reversed_at: datetime | None
    reversed_by_employee_name: str | None
    payable_id: int | None = None
    lines: list[ReceptionLineOut] = Field(default_factory=list)


class ReceptionReverseIn(BaseModel):
    authorizer_pin: str = Field(min_length=1, max_length=20)


# ---------------------------------------------------------------------------
# Cuentas por pagar y pagos.
# ---------------------------------------------------------------------------


class PayableOut(OutModel):
    id: int
    store_id: int
    supplier_id: int
    reception_id: int
    amount: int
    balance: int
    status: PayableStatusLiteral
    due_date: date
    overdue: bool
    approved_at: datetime | None
    approved_by_employee_name: str | None
    business_date: date
    # D-2: lo que dice el papel (copiado de `Reception.invoice_total`, `None`
    # si la recepción no lo capturó) y la diferencia DERIVADA contra `amount`
    # (`invoice_total - amount`; `None` si no hay `invoice_total` que
    # comparar). `amount` sigue siendo el cálculo — nunca cambia de
    # significado.
    invoice_total: int | None
    invoice_discrepancy: int | None
    discrepancy_confirmed: bool
    discrepancy_confirmed_by_employee_name: str | None


class PayableApproveIn(BaseModel):
    authorizer_pin: str = Field(min_length=1, max_length=20)
    # D-2: reconoce explícitamente la diferencia entre `invoice_total` y
    # `amount` cuando la hay — mismo patrón que `confirm_price` en
    # `ReceptionIn`. Sin ella y con diferencia, `approve_payable` corta con
    # `409 INVOICE_DISCREPANCY`.
    confirm_discrepancy: bool = False


class PaymentIn(BaseModel):
    amount: int = Field(gt=0)
    method: SupplierPaymentMethodLiteral
    paid_at: datetime
    reference: str | None = Field(default=None, max_length=120)
    from_cash_drawer: bool = False
    authorizer_pin: str = Field(min_length=1, max_length=20)


class PaymentOut(OutModel):
    id: int
    payable_id: int
    amount: int
    method: SupplierPaymentMethodLiteral
    paid_at: datetime
    reference: str | None
    from_cash_drawer: bool
    cash_movement_id: int | None
    employee_name: str
    authorized_by_employee_name: str
    created_at: datetime
    voided_at: datetime | None
    voided_reason: str | None
    # Quién anuló. Sin esto el historial dice que un pago se anuló y no dice
    # quién, que es justo el dato por el que existe el historial: anular un
    # pago a proveedor devuelve plata al cajón (`register_supplier_payment_
    # reversal`) y eso tiene responsable.
    voided_by_employee_name: str | None


class PaymentVoidIn(BaseModel):
    reason: str = Field(min_length=1)
    authorizer_pin: str = Field(min_length=1, max_length=20)
