"""Esquemas Pydantic de los reportes del administrador
(`features/fase-1b-venta/spec.md` «Admin reports», `docs/SPEC-NEGOCIO.md §9.3`
y `§10`). Sólo lectura. Ningún campo de plata puede faltar en silencio —
cuando no hay dato, el campo es `None` (`null` en la respuesta), nunca `0`.

Desde el pedido 2a estos esquemas **sí** llevan costo (`theoretical_cost`,
`gross_margin`, `costed_pct`, `courtesies_cost`): son rutas de `admin`, y lo
que `AGENTS.md` prohíbe es que **el operador** reciba costos, no que el
producto los tenga. Durante la construcción de 2a estos campos nacieron con
nombres de rodeo (`theoretical_value`, `gross_contribution`…) para pasar un
invariante heredado que barría el OpenAPI **entero** buscando la subcadena
`cost`. Ese barrido estaba mal acotado —se llamaba «device responses» y
miraba todo— y se corrigió en el cierre del pedido
(`tests/payments/test_documents.py`): ahora recorre sólo las rutas que no son
`/admin/`, que es lo que la regla dice. Los nombres de la spec volvieron.
Si un barrido vuelve a empujar a renombrar un campo publicado, el que está
mal es el barrido.
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


# ---------------------------------------------------------------------------
# Pedido 2a: las cuatro alertas que gana `GET /admin/today` (spec.md «Reports
# that gain cost»). Cada una envuelve tal cual el `dict` que devuelve el hook
# del dominio DUEÑO del hecho que alertan (`app.inventory.hooks.
# low_stock_alerts`/`negative_stock_alerts`, `app.recipes.hooks.
# prep_stock_alerts`/`uncosted_products`) — este módulo no reimplementa esa
# lógica, sólo la expone. Ninguno de los cuatro hooks devuelve un campo de
# costo (`negative_stock_alerts` trae cantidad y causa probable, no plata),
# así que no chocan con el invariante de OpenAPI de `tests/audit` aunque
# viva bajo `/admin/today`.
# ---------------------------------------------------------------------------


class IngredientAlertOut(BaseModel):
    # Pedido 2b (deuda declarada en `outputs-2a/ENTREGA.md § 5`, A-5): ESTA
    # magnitud se publicaba en dos escalas distintas para el mismo dato —
    # `app.inventory.schemas` ya la publica como texto decimal
    # (`app.core.quantity.format_qty_base`), acá salía como `int` en
    # milésimas crudas. Unificado a texto decimal: es el mismo modo de
    # falla que B-2 (el cero mudo de costo) pero con cantidad — la primera
    # pantalla que pintara `qty_base` iba a mostrar `117648 g`, o el
    # cliente iba a dividir por 1.000 a mano (matemática en el lugar
    # equivocado). Formateado en `app.reports.service._low_stock_alerts`;
    # nunca aritmética en este esquema.
    ingredient_id: int
    name: str
    qty_base: str
    min_stock: str
    base_unit: str


class NegativeStockAlertOut(BaseModel):
    ingredient_id: int
    name: str
    qty_base: str
    min_stock: str
    base_unit: str
    negative_since: str | None
    probable_cause: str | None


class PrepAlertOut(BaseModel):
    type: str
    preparation_id: int
    preparation_name: str
    current_stock: int
    unit: str


class UncostedProductOut(BaseModel):
    product_id: int
    product_name: str | None
    items_sold: int
    qty_sold: int


# ---------------------------------------------------------------------------
# Pedido 2b: los tres grupos nuevos de alertas de `GET /admin/today`
# (spec.md «Reads that 2a asked for», párrafo de `GET /admin/today`). Mismo
# patrón que las cuatro de arriba: cada uno envuelve el `dict` que devuelve
# el hook del dominio DUEÑO (`app.inventory.hooks.expiring_or_expired_lots`/
# `last_applied_full_count_at`, `app.purchases.hooks.overdue_payables`/
# `pending_review_payables_count`), acotado por `find_spec_safe` **y**
# `features.is_enabled` (`app.reports.service._hooks_if_enabled`) — con el
# módulo ausente o la función apagada para la sede, `[]`/`0`/`None`, nunca
# un error ni una alarma que la sede no puede resolver.
# ---------------------------------------------------------------------------


class LotAlertOut(BaseModel):
    batch_id: int
    ingredient_id: int
    # Texto decimal (`format_qty_base`), misma regla que unifica el resto de
    # este esquema en este mismo pedido — nunca milésimas crudas.
    qty_base: str
    expires_at: str
    status: Literal["expiring", "expired"]


class PayableAlertOut(BaseModel):
    payable_id: int
    supplier_id: int
    supplier_name: str
    due_date: str
    balance: int
    days_overdue: int


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
    # Pedido 2a: `[]` cuando `catalog.recipes`/`inventory.perpetual` están
    # apagadas o el dominio todavía no está montado — nunca falta la llave.
    ingredients_below_min: list[IngredientAlertOut]
    ingredients_negative: list[NegativeStockAlertOut]
    preps_without_production: list[PrepAlertOut]
    products_discounting_nothing: list[UncostedProductOut]
    # Pedido 2b: `[]`/`0`/`None` cuando `inventory.lots`/`purchases`/
    # `inventory.variance` están apagadas o el dominio todavía no está
    # montado — nunca falta la llave (mismo criterio que las cuatro de
    # arriba).
    lots_expiring_or_expired: list[LotAlertOut]
    payables_overdue: list[PayableAlertOut]
    payables_pending_review_count: int
    # `null` (no `false` mudo) cuando `inventory.variance` está apagada o el
    # dominio no está montado: "confiable/no confiable" es una afirmación
    # que sólo tiene sentido si la sede lleva el control. Con la función
    # encendida: `True` sin conteo completo nunca aplicado o a más de 14
    # días del último; `days_since_last_full_count` viaja aparte y es
    # `None` cuando nunca hubo uno (nunca un número inventado).
    inventory_unreliable: bool | None
    days_since_last_full_count: int | None


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
    # Pedido 2a (`app.reports.service._document_cost_stats`): leídos de
    # `OrderItem.unit_cost_micros` CONGELADO al enviar, nunca de la ficha
    # actual. Acumulados en MICROS a través de todo el bucket y convertidos a
    # pesos UNA sola vez (ronda 2, B-2: sumar `unit_cost` en pesos, ya
    # redondeado por ítem, perdía plata real cuando muchos ítems costaban
    # menos de $1). `None` cuando NINGÚN documento del grupo tuvo costo
    # (nunca `0` mudo). El tipo publicado sigue siendo `int` de pesos: no
    # cambió por el refactor a micros.
    theoretical_cost: int | None
    gross_margin: int | None
    costed_pct: int | None


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
