"""Las series «barra + raya» del panel del dueño
(`docs/diseno/handoff-pos-y-panel/README.md` § «Patrón de datos»).

Cada serie viaja con el dato **y** su raya ya calculados: el frontend sólo
los lleva a píxeles (`components/charts/BarrasConReferencia`). Cada punto
dice además si quedó del lado malo de su raya (`outside`) —la decisión de
pintar en ámbar no se toma en el cliente— y su variación contra la raya
(`delta_bp`, puntos básicos con signo) cuando la comparación tiene sentido.

`null` no es 0: un punto sin dato viaja con `value=None`; una serie que no
se puede armar viaja con `available=False` y su `reason`.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel

#: De qué lado de la raya está lo malo: `above` = pasarla (efectivo sobre el
#: umbral, mesa larga), `below` = no llegar (ventas bajo la semana anterior,
#: margen bajo la meta). Espejado en `schemas.SeriesBadSideLiteral`.
BadSide = Literal["above", "below"]
#: En qué unidad viaja el dato. Espejado en `schemas.SeriesUnitLiteral`.
SeriesUnit = Literal["cop", "count", "people", "minutes", "bp"]


class SeriesPointOut(BaseModel):
    key: str
    label: str
    #: El dato (pesos, comandas, personas, minutos o puntos básicos, según la serie).
    value: int | None
    #: La raya de ESTE punto (semana anterior, capacidad…). `None` = sin raya
    #: (la serie puede tener una común en `reference`).
    reference: int | None = None
    #: Variación del dato contra su raya, en puntos básicos con signo. `None`
    #: sin raya o con raya `<= 0` (nunca un «+100 %» contra cero).
    delta_bp: int | None = None
    #: El punto quedó del lado malo de su raya (o de la común).
    outside: bool = False
    #: Todavía no pasó (proyección o programado): se dibuja al 35 %.
    future: bool = False
    #: Es «ahora» / «hoy».
    now: bool = False
    #: La comparación descansa en muy pocos casos (p. ej. un día de la semana
    #: anterior con 2 comandas): `delta_bp` es verdad aritmética pero no dice
    #: nada, y la pantalla no lo grita como porcentaje.
    low_base: bool = False


class SeriesOut(BaseModel):
    available: bool = True
    reason: str | None = None
    unit: SeriesUnit
    bad_side: BadSide
    #: Raya común a todos los puntos (meta, umbral, límite), si la hay.
    reference: int | None = None
    points: list[SeriesPointOut] = []


# ---------------------------------------------------------------------------
# Informes (`GET /admin/reports/overview` → `series`)
# ---------------------------------------------------------------------------


class DailySalesSeriesOut(SeriesOut):
    """Ventas netas por día contra el mismo día de la semana anterior."""

    days_with_reference: int = 0
    days_above: int = 0
    #: El día que más creció contra su mismo día (mayor `delta_bp`).
    best_key: str | None = None


class CategoryMarginPointOut(SeriesPointOut):
    """`value` y `reference` en puntos básicos de margen bruto sobre la
    venta neta de la categoría. `delta_points_bp`: cambio contra el período
    anterior, en puntos básicos (100 = 1 punto)."""

    net: int = 0
    gross_margin: int | None = None
    costed_pct: int | None = None
    previous_bp: int | None = None
    delta_points_bp: int | None = None
    #: Por debajo de la meta, cuántos puntos básicos le faltan (positivo).
    gap_bp: int | None = None


class CategoryMarginSeriesOut(BaseModel):
    available: bool = True
    reason: str | None = None
    unit: Literal["bp"] = "bp"
    bad_side: BadSide = "below"
    #: La meta de margen de la sede (Ajustes › Ventas), en puntos básicos.
    reference: int | None = None
    #: Margen bruto del período entero, en puntos básicos.
    total_bp: int | None = None
    points: list[CategoryMarginPointOut] = []


class StoreWeekPointOut(SeriesPointOut):
    store_id: int
    avg_ticket: int | None = None
    #: Margen bruto de la sede en el período, en puntos básicos sobre su
    #: venta neta. `None` sin costo o sin venta (nunca un 0 % mudo).
    margin_bp: int | None = None


class StoresWeekSeriesOut(BaseModel):
    """Ventas netas del período por sede contra el período anterior del
    mismo largo (sólo con «Todas las sedes»)."""

    available: bool = True
    reason: str | None = None
    unit: Literal["cop"] = "cop"
    bad_side: BadSide = "below"
    points: list[StoreWeekPointOut] = []


class PeakHourPointOut(SeriesPointOut):
    """`value` = comandas de salón abiertas en esa hora (promedio por día
    operado, redondeado); `reference` = capacidad = `waiters` × comandas
    por mesero; `waiters` = meseros en turno a la media hora (promedio)."""

    waiters: int | None = None


class PeakHoursViewOut(BaseModel):
    key: str  # "avg" o el día de la semana ("mon"…"sun")
    label: str  # «Promedio», «sáb»…
    days: int  # días operados que entran al promedio
    points: list[PeakHourPointOut] = []


class PeakHoursSeriesOut(BaseModel):
    available: bool = True
    reason: str | None = None
    unit: Literal["count"] = "count"
    bad_side: BadSide = "above"
    orders_per_waiter: int | None = None
    views: list[PeakHoursViewOut] = []


#: El grupo de un plato en el «Mix de platos» (cuadrante contra los
#: promedios): `keep` venden y dejan, `promote` dejan pero venden poco,
#: `reprice` venden pero dejan poco, `review` venden poco y dejan poco.
DishMixGroup = Literal["keep", "promote", "reprice", "review"]


class DishMixPointOut(BaseModel):
    key: str
    label: str
    #: Unidades vendidas en el período (eje x).
    units: int
    #: Margen bruto sobre la venta neta del plato, en puntos básicos (eje y).
    margin_bp: int
    net: int
    group: DishMixGroup


class DishMixSeriesOut(BaseModel):
    """«¿Qué platos venden y dejan plata?»: unidades contra margen de los
    platos más vendidos con costo, partidos en cuatro por los promedios
    (simples) de los dos ejes. Los platos sin costo no se ubican: se cuentan
    en `without_cost`."""

    available: bool = True
    reason: str | None = None
    avg_units: int | None = None
    avg_margin_bp: int | None = None
    points: list[DishMixPointOut] = []
    #: Platos vendidos en el período que no tienen costo (no se pueden ubicar).
    without_cost: int = 0


class OverviewSeriesOut(BaseModel):
    daily_sales: DailySalesSeriesOut
    category_margin: CategoryMarginSeriesOut
    stores_week: StoresWeekSeriesOut | None = None
    peak_hours: PeakHoursSeriesOut
    #: Mix de platos (unidades × margen). `None` en respuestas viejas.
    dish_mix: DishMixSeriesOut | None = None


# ---------------------------------------------------------------------------
# Ficha de turno (`GET /admin/records/shift/{id}` → `cash_by_hour`)
# ---------------------------------------------------------------------------


class CashHourPointOut(SeriesPointOut):
    """`value` = efectivo esperado en el cajón al final de esa hora (o
    ahora, en la hora en curso). `pickups`: los retiros de esa hora."""

    pickups: list[int] = []


class CashByHourSeriesOut(BaseModel):
    available: bool = True
    reason: str | None = None
    unit: Literal["cop"] = "cop"
    bad_side: BadSide = "above"
    #: El umbral de retiro de la sede (`cash_pickup_threshold`).
    reference: int | None = None
    points: list[CashHourPointOut] = []
    #: Horas en que el efectivo pasó el umbral.
    hours_over: int = 0
    #: La serie se cortó (turno abandonado de muchas horas).
    truncated: bool = False
    #: Cuando se cortó, en palabras: hasta dónde se dibuja y por qué.
    truncated_reason: str | None = None


# ---------------------------------------------------------------------------
# Ficha de insumo (`GET /admin/records/ingredient/{id}` → `stock_by_day`)
# ---------------------------------------------------------------------------


class StockDayPointOut(BaseModel):
    """Cantidades en texto decimal de la unidad base (`format_qty_base`),
    como el resto de las cantidades de la API: nunca milésimas crudas."""

    key: str
    label: str
    business_date: date
    qty: str | None
    outside: bool = False
    future: bool = False
    now: bool = False


class StockByDaySeriesOut(BaseModel):
    available: bool = True
    reason: str | None = None
    bad_side: BadSide = "below"
    base_unit: str
    min_stock: str
    #: Consumo diario promedio de los días cerrados (texto decimal), `None`
    #: sin consumo.
    daily_use: str | None = None
    points: list[StockDayPointOut] = []
    #: Primer día (cerrado o proyectado) en el mínimo o debajo.
    below_min_on: date | None = None
    #: Primer día proyectado en que se acaba (≤ 0).
    runs_out_on: date | None = None


# ---------------------------------------------------------------------------
# Hoy (`GET /admin/panel` → `stores[].bullets`)
# ---------------------------------------------------------------------------


class BulletOut(BaseModel):
    """Un «bullet» de 90 × 10: el dato, su raya y si está del lado malo."""

    value: int | None
    reference: int | None
    bad_side: BadSide
    outside: bool = False
    delta_bp: int | None = None
    #: Lo que pasa de la raya (positivo), cuando la pasa.
    over_by: int | None = None
    reason: str | None = None


class AreaProgressOut(BaseModel):
    area_id: int
    area_name: str
    counted: int | None
    total: int | None
    #: Va atrasado: la apertura es obligatoria y falta.
    behind: bool = False


class PanelBulletsOut(BaseModel):
    #: Ventas netas de hoy contra el mismo día de la semana pasada a esta hora.
    sales: BulletOut
    reference_business_date: date | None = None
    #: Efectivo esperado en caja contra el umbral de retiro.
    cash: BulletOut | None = None
    #: Personas en turno por hora, 6 a. m. a 12 a. m.; lo futuro marcado.
    staff_by_hour: SeriesOut
    area_progress: list[AreaProgressOut] = []
    #: Minutos de cada mesa abierta contra «mesa larga».
    tables: SeriesOut
    #: Minutos de cada tiquete en cocina contra «tiquete demorado».
    tickets: SeriesOut
    generated_at: datetime


# ---------------------------------------------------------------------------
# Celular: Caja, Equipo e Informes (`GET /admin/panel/sections`)
# ---------------------------------------------------------------------------

#: Cómo está una tarjeta o un renglón: `ok` (en orden), `warning`
#: (atención), `critical` (falta plata o algo sin cerrar), `muted` (sin
#: dato o nada que decir). El color nunca va solo: la forma y el texto los
#: pone la pantalla.
SectionTone = Literal["ok", "warning", "critical", "muted"]
#: Qué dibujo pide la serie: `columns` (una barra por punto), `diverging`
#: (arriba sobra, abajo falta: el cero al medio) o `dual` (cada barra con
#: su raya propia: hoy contra la semana pasada).
SectionChart = Literal["columns", "diverging", "dual"]
SectionKey = Literal["caja", "equipo", "informes"]


class SectionRowOut(BaseModel):
    """Un renglón de la lista de excepciones de una tarjeta (44 px)."""

    key: str
    label: str
    #: El dato, en la unidad de `unit`. `None` = el renglón no tiene cifra y
    #: dice `note` («Sin cierre», «Sugerido»).
    value: int | None = None
    unit: SeriesUnit = "cop"
    #: La palabra que va en lugar de la cifra («Cuadra», «Sin salida»).
    note: str | None = None
    tone: SectionTone = "muted"


class SectionCardOut(BaseModel):
    """Una de las cuatro tarjetas de una sección del celular: la cifra, el
    estado en palabras, la serie con su raya y las excepciones. Todo lo
    decide el servidor; la pantalla sólo formatea `value` según `unit`."""

    key: str
    available: bool = True
    reason: str | None = None
    unit: SeriesUnit = "cop"
    #: La cifra de la tarjeta. `None` = sin dato (nunca 0).
    value: int | None = None
    #: «de cuántos», cuando la cifra es un recuento («2 de 4»).
    of: int | None = None
    #: La cifra cuando no es un número (una sede, una franja horaria).
    value_text: str | None = None
    tone: SectionTone = "muted"
    #: El estado en una línea: «1 faltante · 1 sin cerrar».
    status: str | None = None
    #: De qué está hecha la cifra y cómo leer el gráfico.
    note: str | None = None
    chart: SectionChart = "columns"
    series: SeriesOut
    rows: list[SectionRowOut] = []


class SectionOut(BaseModel):
    section: SectionKey
    scope: Literal["all", "store"]
    store_ids: list[int]
    generated_at: datetime
    cards: list[SectionCardOut]
