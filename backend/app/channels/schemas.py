"""Esquemas Pydantic de `channels` (pedido 2c).

Ningún esquema de este módulo tiene `cost`/`margin`/`unit_cost`: el
operador no recibe costos (`AGENTS.md`). La comisión SÍ aparece, y no es
una excepción a esa regla: es un costo del NEGOCIO frente a la plataforma,
no el costo de un plato, y sólo se sirve en rutas `/admin/**` con
`current_admin` — nunca bajo sesión de dispositivo.

**Sin `float` en ningún campo de plata ni de porcentaje**: la comisión
viaja en puntos básicos enteros (`commission_bp`, 100 = 1 %), igual que
`WasteKpiOut.ratio` desde 2b.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

LedgerEntryKindLiteral = Literal["charge", "reversal"]
PlatformReceivableStatusLiteral = Literal["pending", "reversed"]
DeliverySettlementStatusLiteral = Literal["settled", "voided"]


# ---------------------------------------------------------------------------
# Plataformas y comisiones (§3.3, §9.3)
# ---------------------------------------------------------------------------


class PlatformIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    code: str = Field(min_length=1, max_length=40)
    # 100 = 1 %. `le=10000` (100 %) ataja el error de tecleo clásico: 18 %
    # escrito como `18` da 0,18 % —poco, se nota tarde— y escrito como
    # `180000` daría 1.800 %. El tope lo valida también la base.
    commission_bp: int = Field(ge=0, le=10_000)


class PlatformUpdateIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    commission_bp: int | None = Field(default=None, ge=0, le=10_000)
    active: bool | None = None


class PlatformOut(BaseModel):
    id: int
    store_id: int
    name: str
    code: str
    commission_bp: int
    active: bool
    created_at: datetime
    updated_at: datetime


class DevicePlatformOut(BaseModel):
    """Lo que el POS necesita para cargar a mano un pedido de plataforma
    (§ Alcance: la integración por API es fase 3). **Sin `commission_bp`**:
    la comisión es plata del negocio y el operador no la necesita para
    tomar un pedido."""

    id: int
    name: str
    code: str


class PlatformCommissionOut(BaseModel):
    id: int
    platform_id: int
    order_id: int
    document_id: int | None
    kind: LedgerEntryKindLiteral
    base_amount: int
    commission_bp: int
    amount: int
    business_date: date
    at: datetime
    reason: str | None = None


class PlatformReceivableOut(BaseModel):
    id: int
    platform_id: int
    order_id: int
    document_id: int | None
    payment_id: int | None
    external_id: str | None
    amount: int
    tip_amount: int
    status: PlatformReceivableStatusLiteral
    business_date: date
    at: datetime
    reversed_at: datetime | None = None
    reversed_reason: str | None = None


class PlatformSummaryOut(BaseModel):
    """Resumen por plataforma de un rango de fechas.

    **La venta es la venta y la comisión es un costo**: los dos números
    salen por separado y `sales` NUNCA viene neteado. `net_expected` es lo
    que se espera COBRARLE a la plataforma (`sales + tips − commission`) y
    está rotulado como tal: no es una cifra de venta, de impuesto ni de
    documento fiscal.
    """

    platform_id: int
    platform_name: str
    date_from: date
    date_to: date
    orders: int
    sales: int
    tips: int
    commission: int
    net_expected: int


# ---------------------------------------------------------------------------
# Domicilio propio: la liquidación del efectivo (§3.3)
# ---------------------------------------------------------------------------


class CourierPendingOut(BaseModel):
    """Efectivo de domicilios por liquidar, por domiciliario.

    **No es una deuda del empleado** (CST art. 149, regla dura): es el
    registro de cobros cuyo efectivo todavía no llegó al cajón. El sistema
    nunca calcula ni descuenta una deuda de una persona; esto se apaga
    entregando la plata, no pagándola.
    """

    courier_employee_id: int
    courier_employee_name: str
    payments_count: int
    amount: int
    tip_amount: int
    total: int


class DeliveryPendingListOut(BaseModel):
    store_id: int
    couriers: list[CourierPendingOut]
    amount: int
    tip_amount: int
    total: int


class DeliverySettlementIn(BaseModel):
    courier_employee_id: int
    # `None` = liquidar TODO lo pendiente de ese domiciliario en la sede.
    # Una lista explícita liquida sólo esos cobros (entrega parcial).
    # `null` ≠ `[]`: una lista vacía es un error de quien llama, no
    # "liquidá todo", y se rechaza con `400`.
    payment_ids: list[int] | None = None
    note: str | None = Field(default=None, max_length=400)


class DeliverySettlementVoidIn(BaseModel):
    reason: str = Field(min_length=1, max_length=400)


class DeliverySettlementOut(BaseModel):
    id: int
    store_id: int
    courier_employee_id: int
    courier_employee_name: str
    shift_id: int
    cash_movement_id: int | None
    amount: int
    tip_amount: int
    total: int
    payments_count: int
    status: DeliverySettlementStatusLiteral
    note: str | None
    business_date: date
    at: datetime
    employee_name: str
    voided_at: datetime | None = None
    voided_reason: str | None = None
    voided_by_employee_name: str | None = None
    void_shift_id: int | None = None
    void_cash_movement_id: int | None = None


# ---------------------------------------------------------------------------
# Venta compensada de plataforma (§3.3)
# ---------------------------------------------------------------------------


class PlatformCancellationIn(BaseModel):
    order_id: int
    reason: str = Field(min_length=1, max_length=400)


class PlatformCancellationOut(BaseModel):
    """Resultado de compensar una venta de plataforma.

    `restocked` es **siempre `False`** y está en el contrato para que se
    lea: cancelar después de preparar NO repone inventario ni genera merma
    — el insumo ya se descontó al enviar y se queda descontado. Meterlo en
    mermas falsearía el KPI de mermas ÷ compras que 2b construyó.
    """

    order_id: int
    note_document_id: int | None
    note_full_number: str | None
    receivable_reversed_id: int | None
    commission_reversed_id: int | None
    order_marked: bool
    restocked: bool = False
    waste_created: bool = False
    reason: str
