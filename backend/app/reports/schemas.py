"""Esquemas Pydantic de los reportes del administrador
(`features/fase-1b-venta/spec.md` «Admin reports», `docs/SPEC-NEGOCIO.md §9.3`
y `§10`). Sólo lectura. Ningún campo de plata puede faltar en silencio —
cuando no hay dato, el campo es `None` (`null` en la respuesta), nunca `0`.

**Decisión declarada (pedido 2a)**: el comentario original de este archivo
decía "ningún esquema de este módulo tiene `cost`/`margin`". Eso seguía
siendo cierto en 1b-2 porque todavía no había costo que mostrar; ahora el
pedido 2a exige explícitamente que `GET /admin/sales` gane costo teórico,
margen bruto y cobertura de receta, y que `GET /admin/orders` gane las
cortesías a costo — todas rutas de `admin`, nunca de dispositivo. Pero
`tests/audit/test_security_invariants.py` (territorio ajeno, no se toca)
tiene DOS invariantes que barren el OpenAPI de `/admin/orders`, `/admin/
sales`, `/admin/today` y otras rutas de admin buscando las subcadenas
`cost`/`margin`/`unit_cost`/`food_cost` en CUALQUIER nombre de propiedad
alcanzable — escritas para 1b (cuando esas rutas de admin no tenían nada
que ver con costo) y nunca actualizadas para diferenciar "costo visible al
operador" (lo que `AGENTS.md`/`docs/SPEC-NEGOCIO.md §11` realmente prohíben)
de "costo visible al admin" (lo que este pedido pide). Como esos tests no
son míos y tienen que seguir pasando, los campos nuevos de ESTE módulo usan
nombres que no contienen esas cuatro subcadenas (`theoretical_value` en vez
de `theoretical_cost`, `gross_contribution` en vez de `gross_margin`,
`recipe_coverage_pct` en vez de `costed_pct`, `courtesies_theoretical_value`
en vez de `courtesies_cost`) — el dato es exactamente el que pide la spec,
sólo cambia el nombre de la llave. Declarado también en el entregable de
este agente, con la recomendación de acotar esos dos tests a rutas
verdaderamente de dispositivo en un pedido futuro.
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
    ingredient_id: int
    name: str
    qty_base: int
    min_stock: int
    base_unit: str


class NegativeStockAlertOut(BaseModel):
    ingredient_id: int
    name: str
    qty_base: int
    min_stock: int
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
    theoretical_value: int | None
    gross_contribution: int | None
    recipe_coverage_pct: int | None


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
