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

GroupBy = Literal["business_date", "shift", "method", "channel", "employee", "hour", "zone", "product", "category"]


class EmployeeRefOut(BaseModel):
    id: int
    name: str


# ---------------------------------------------------------------------------
# GET /admin/today
# ---------------------------------------------------------------------------


class HourBucketOut(BaseModel):
    """Una hora de reloj de Bogotá (0-23). Revisión de datos (sep. 2026,
    científico #12): `sales_by_hour` trae SIEMPRE las 24 horas, en el orden
    del día operativo (arranca en `cutoff_hour` de la sede, no en las 00),
    con `0` explícito donde no hubo venta — el hueco ya no desaparece.
    `pending=True` marca una hora del día en curso que todavía no empezó: su
    `0` no es un resultado, es «todavía no pasó» (el gráfico no la dibuja
    como venta cero). `orders` = comandas con al menos un comprobante
    emitido en esa hora."""

    hour: int
    gross: int
    net: int
    orders: int = 0
    pending: bool = False


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
    # Revisión de datos (sep. 2026, analista #4): la plata en juego del aviso,
    # en pesos enteros, cuando el aviso tiene una. Con signo cuando el signo
    # dice algo (`cash_diff_summary`: negativo = faltante neto); `None`
    # cuando el aviso no es de plata (nunca `0` mudo). `alerts` viene
    # ordenada por gravedad (critical > warning > info) y, dentro de la
    # misma gravedad, por `|amount|` descendente (los `None` al final).
    amount: int | None = None


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
    # Revisión de datos (sep. 2026, analista #4): lo que vale la cantidad que
    # falta (|qty_base| × costo vigente del insumo, jerarquía completa de
    # `app.inventory.hooks.resolve_ingredient_cost`), en pesos enteros
    # positivos. `None` cuando el insumo no tiene costo todavía — nunca `0`.
    amount: int | None = None


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


class TodayComparisonOut(BaseModel):
    """Hoy contra el MISMO día de la semana pasada HASTA LA MISMA HORA
    (revisión de datos sep. 2026, analista #3). `until` es el minuto de
    corte del día de referencia (ahora − 7 días, truncado al minuto): sólo
    cuentan los comprobantes de ese día emitidos hasta el final de ese
    minuto.

    `net`/`orders` son `None` (con `null_reason`) cuando la sede todavía no
    operaba ese día — «no existía» no es «vendió $0». Si la sede ya operaba
    pero ese día no abrió (`reference_operated=False`) o no vendió nada a
    esta hora, `net=0` es un hecho real y `delta_bp` es `None` (no hay
    divisor). `delta_bp` = variación del neto de hoy contra ese neto, en
    puntos básicos con signo (−1.200 = 12 % abajo)."""

    reference_business_date: date
    until: datetime
    net: int | None
    orders: int | None
    delta_bp: int | None
    orders_delta_bp: int | None
    reference_operated: bool | None
    null_reason: str | None


class DayCloseOut(BaseModel):
    """Cómo cerró un día operativo completo (`yesterday_close`: el
    anterior al de hoy), para mostrar antes de la primera venta."""

    business_date: date
    net: int
    orders: int
    avg_ticket: int | None
    operated: bool


class AreaCountDoneTodayOut(BaseModel):
    count_id: int
    counted_at: datetime
    employee_name: str


class AreaCountAreaTodayOut(BaseModel):
    """Una área de conteo y si contó hoy. `None` = todavía nadie contó ese
    momento (no es un error: el conteo corto nunca bloquea el turno)."""

    area_id: int
    area_name: str
    opening: AreaCountDoneTodayOut | None
    closing: AreaCountDoneTodayOut | None
    # Conteo compartido barra/cocina (`app.inventory.AreaTodayStatus`, en
    # integración): cuántos artículos van contados de cuántos, y si falta la
    # apertura. Opcionales y `None` mientras `inventory` no los publique: el
    # mapeo es tolerante (`getattr`) para que la integración no rompa nada.
    opening_counted: int | None = None
    opening_total: int | None = None
    closing_counted: int | None = None
    closing_total: int | None = None
    full_count: bool | None = None
    opening_missing: bool | None = None


class AreaCountFlagOut(BaseModel):
    """Un artículo con diferencia, leído de `app.inventory.hooks.
    area_counts_today` (la matemática es de `inventory`; acá no se recalcula).
    `window`: `night` (del cierre anterior a la apertura de hoy), `shift` (de
    la apertura al cierre) o `spot` (recuento sorpresa contra el sistema).
    `shortage_qty` positivo = faltó; negativo = sobró. `shortage_value` en
    pesos, `None` sin costo conocido. `flagged` = fuera del umbral de la sede
    (un recuento respondido viaja aunque esté dentro, para que el dueño vea
    la respuesta)."""

    count_id: int
    area_name: str
    window: Literal["night", "shift", "spot"]
    ingredient_id: int
    ingredient_name: str
    base_unit: str
    shortage_qty: str
    shortage_value: int | None
    flagged: bool
    counted_at: datetime
    employee_name: str


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
    # Consignar desde el POS (2026-09-24): lo que la bandeja de Hoy le pide al
    # dueño. Con «Consignaciones» apagada, `0` y `None`: no hay saldo publicado.
    deposits_to_confirm_count: int = 0
    undeposited_total: int | None = None
    undeposited_oldest_date: date | None = None
    # Base de respaldo (2026-09-26): préstamos al cajón sin devolver. Tienen
    # que volver el mismo día. `None` en el total con `cash.reserve` apagada.
    reserve_loans_open_count: int = 0
    reserve_loans_open_total: int | None = None
    # La rutina del turno en el POS (2026-09-25): lo que el salón le dejó al
    # dueño para resolver. `0` con la función apagada.
    reception_drafts_pending_count: int = 0
    requests_pending_count: int = 0
    novelties_open_count: int = 0
    novelties_urgent_count: int = 0
    transfers_incoming_count: int = 0
    # Conteo corto por área (`inventory.shift_counts`). Con la función
    # apagada: `area_counts_enabled=False`, listas vacías y `0`.
    area_counts_enabled: bool = False
    area_counts_areas: list[AreaCountAreaTodayOut] = []
    area_counts_flags: list[AreaCountFlagOut] = []
    area_recounts_pending_count: int = 0
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
    # Revisión de datos (sep. 2026). Todos opcionales con default: un
    # consumidor viejo que no los conoce no se rompe.
    # Plata en juego de dos grupos del riel (analista #4). `None` cuando la
    # función está apagada / el módulo no existe (`payables_overdue_total`) o
    # cuando NINGÚN insumo en negativo tiene costo (`ingredients_negative_
    # amount`); con la lista vacía y la función encendida, `0`.
    payables_overdue_total: int | None = None
    ingredients_negative_amount: int | None = None
    ingredients_negative_unvalued: int = 0
    # Contra qué comparar el día (analista #3, científico (d)1).
    comparison: TodayComparisonOut | None = None
    sales_by_hour_reference: list[HourBucketOut] = []
    yesterday_close: DayCloseOut | None = None
    # El turno abierto de la sede, **sea del día que sea** (`app.reports.
    # panel.current_cash`, la misma lectura que el panel y que Dinero ›
    # Operacional). Antes Hoy mostraba el esperado de un turno abandonado de
    # otro día como si fuera el de hoy, sin decir que estaba abandonado ni
    # que su responsable ya no estaba activo. `None` = no hay turno abierto.
    current_shift: PanelCashOut | None = None
    # Sin turno abierto, ¿hay actividad que lo pida? (`panel.shift_activity`:
    # alguien de caja con asistencia abierta hoy, o comandas del día sin
    # turno). `False` = la sede está cerrada: «sin turno» es neutro, no
    # crítico. Con turno abierto, `False`.
    store_closed: bool = False
    # Salidas olvidadas de la asistencia «a revisar» (`GET /admin/attendance`).
    attendance_pending_review_count: int = 0


# ---------------------------------------------------------------------------
# GET /admin/sales
# ---------------------------------------------------------------------------


class PreviousPeriodOut(BaseModel):
    """El período del MISMO largo inmediatamente anterior a `[from, to]`
    (revisión de datos sep. 2026, analista #7 / científico (d)1). Sólo viaja
    en `SalesReportOut.total`.

    `net`/`orders` son `None` (con `null_reason`) cuando la sede no tenía
    ninguna actividad (turno o venta) hasta `date_to` — «no existía» no es
    «vendió $0». `partial=True` cuando la sede empezó a operar DENTRO del
    período anterior: la comparación es contra menos días reales. Los
    `*_delta_bp` son la variación del período actual contra éste, en puntos
    básicos con signo; `None` cuando el valor anterior es `None` o `0`."""

    date_from: date
    date_to: date
    net: int | None
    orders: int | None
    avg_ticket: int | None
    delta_bp: int | None
    orders_delta_bp: int | None
    avg_ticket_delta_bp: int | None
    partial: bool
    null_reason: str | None


class SalesBucketOut(BaseModel):
    key: str
    label: str
    gross: int
    net: int
    tax: int
    # `None` en `group_by=product|category`: la propina se deja sobre la
    # cuenta, no sobre un plato — repartirla sería inventar.
    tips: int | None
    # En `group_by=method` cuenta PAGOS (partes de un cobro), no comandas:
    # una comanda pagada mitad efectivo y mitad tarjeta suma 1 en cada fila
    # porque son dos pagos de verdad (científico #10). En ese mismo
    # `group_by`, `total.orders` sigue siendo comandas distintas y
    # `total.payments` es la suma de las filas.
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
    # `None` también en `group_by=method`: un medio de pago no tiene ficha
    # técnica; el `0 %` que salía antes contradecía la leyenda de la tabla.
    costed_pct: int | None
    # Revisión de datos (sep. 2026). Todos con default: un consumidor viejo
    # no se rompe.
    # Participación de la fila en el neto del reporte, en puntos básicos.
    # Repartido con `app.orders.money.prorate`, así que las filas suman
    # EXACTO 10.000 (una barra 100 % no queda con un hueco de redondeo).
    # `None` en `total` y cuando el neto total es `0` o alguna fila es
    # negativa.
    share_bp: int | None = None
    # Sólo `group_by=method` (filas y total): cantidad de pagos.
    payments: int | None = None
    # Sólo `group_by=product|category`: unidades vendidas (cortesías
    # incluidas: salieron de la cocina).
    units: int | None = None
    # Sólo `group_by=business_date`: la sede abrió día operativo (turno)
    # ese día. Un día sin ventas SIEMPRE viene como fila con `net=0` (vender
    # $0 es un hecho); `operated=False` dice además que no abrió.
    operated: bool | None = None
    # Sólo en `total`.
    previous_period: PreviousPeriodOut | None = None


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


# ---------------------------------------------------------------------------
# GET /admin/reports/overview — «Informes»: todas las secciones de una vez.
#
# No hay una matemática nueva acá: toda cifra de plata sale de
# `service.aggregate_sales` (la misma de «Ventas» y de «Hoy»), llamada una
# vez por agrupación; con «Todas las sedes» la MISMA función corre sobre los
# documentos de todas las sedes de la organización. Lo único que este
# esquema agrega es la forma: qué sección trae qué filas.
# ---------------------------------------------------------------------------


class MissingDataOut(BaseModel):
    """Un dato que Informes pediría y el servidor no tiene. `null` con
    motivo, nunca un `0` inventado."""

    key: str
    label: str
    reason: str


class PeakHourOut(BaseModel):
    """La hora de más venta neta del período (la marca el servidor). Empate:
    la primera en el orden del día operativo."""

    hour: int
    label: str
    net: int
    orders: int
    share_bp: int | None


class TopProductOut(BaseModel):
    """Un plato vendido: la fila de `aggregate_sales(group_by="product")`
    con la categoría a la que pertenece (la de la carta actual — ver
    `service._product_categories`), para que la pantalla filtre sin pedir
    otra vez."""

    key: str
    label: str
    net: int
    units: int | None
    share_bp: int | None
    category_key: str
    category_label: str


class CategoryRefOut(BaseModel):
    key: str
    label: str


class DeliveryCustomersOut(BaseModel):
    """Domicilios y clientes: sólo lo que el servidor ya sabe.

    `delivery`/`platform` son las filas de esos canales en la agrupación por
    canal (`None` si no hubo venta por ese canal en el período). Clientes
    identificados = comprobantes con cliente registrado (quien pidió factura
    con sus datos); cuenta personas y comandas, no plata. Lo que no existe
    viaja en `missing` con su motivo."""

    delivery: SalesBucketOut | None
    platform: SalesBucketOut | None
    identified_customers: int
    identified_orders: int
    missing: list[MissingDataOut]


class MenuSummaryOut(BaseModel):
    """Cuántos platos en cada cuadrante (`app.analytics.hooks.
    menu_class_counts`). Todos los recuentos son `None` cuando
    `available=False`, con el motivo en `reason`."""

    available: bool
    reason: str | None
    star: int | None
    plowhorse: int | None
    puzzle: int | None
    dog: int | None
    unclassified: int | None
    insufficient_sample: int | None


class CostSectionOut(BaseModel):
    """Costo teórico y margen del período (sólo admin): el total y el
    desglose por categoría de `aggregate_sales`. `None` en cada campo cuando
    ninguna venta tuvo costo congelado — nunca `0` mudo."""

    theoretical_cost: int | None
    gross_margin: int | None
    costed_pct: int | None
    by_category: list[SalesBucketOut]


class StoreRowOut(BaseModel):
    """Una sede en «Todas las sedes»: el total de `aggregate_sales` de ESA
    sede sola. La suma de `net`/`orders` de las filas es exactamente el total
    consolidado (mismos documentos, misma función)."""

    store_id: int
    store_name: str
    net: int
    orders: int
    avg_ticket: int | None
    share_bp: int | None


class ReportsOverviewOut(BaseModel):
    scope: Literal["store", "all"]
    # `store_id` es la sede pedida; `None` con `scope="all"`.
    store_id: int | None
    store_ids: list[int]
    date_from: date
    date_to: date
    total: SalesBucketOut
    by_method: list[SalesBucketOut]
    by_hour: list[SalesBucketOut]
    peak_hour: PeakHourOut | None
    products: list[TopProductOut]
    categories: list[CategoryRefOut]
    by_employee: list[SalesBucketOut]
    by_channel: list[SalesBucketOut]
    by_zone: list[SalesBucketOut]
    delivery_customers: DeliveryCustomersOut
    menu_engineering: MenuSummaryOut
    cost: CostSectionOut
    # Sólo con `scope="all"`; `None` por sede.
    by_store: list[StoreRowOut] | None


# Los literales del panel viven acá (y no en `panel_schemas`) para que
# `frontend/src/audit/api-literal-types.test.ts`, que lee los `schemas.py`,
# los cruce contra `PanelLevel`/`PanelLight` de `src/api/panel.ts`.
PanelLevelLiteral = Literal["critical", "warning", "info"]
PanelLightLiteral = Literal["red", "amber", "green", "gray"]

# El panel (`panel_schemas`) reusa `SalesBucketOut` de este módulo y `TodayOut`
# reusa `PanelCashOut` de aquél: se importa al final, cuando todo lo de acá ya
# existe, y se reconstruye el modelo que lo nombra.
from app.reports.panel_schemas import PanelCashOut  # noqa: E402

TodayOut.model_rebuild()
