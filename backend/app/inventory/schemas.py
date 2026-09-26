"""Esquemas de `inventory`. Ningún esquema de este módulo expone `cost`,
`cost_micros`, `margin` ni `food_cost` en una respuesta de **dispositivo**
(`DeviceIngredientOut`, `POST /waste`'s `WasteOut`): el operador no recibe
costos ni márgenes (regla dura, probada por el test del OpenAPI de
`tests/audit/test_security_invariants.py`, territorio ajeno, que tiene que
seguir pasando con este dominio montado).
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.photos.hooks import PhotoIn

BaseUnitLiteral = Literal["g", "ml", "unit"]
AreaCountEntryModeLiteral = Literal["weight", "bottle", "volume", "unit"]
CostSourceLiteral = Literal["official", "weighted_average", "last_purchase", "estimated", "none"]
MovementCauseLiteral = Literal[
    "sale",
    "production_in",
    "production_out",
    "waste",
    "note_return",
    "manual_adjustment",
    "purchase",
    "count_adjustment",
    "reception_reversal",
    "transfer_in",
    "transfer_out",
]
WasteTypeLiteral = Literal[
    "expired",
    "overproduction",
    "kitchen_error",
    "breakage",
    "customer_return",
    "tasting",
    "courtesy_no_dish",
    "unidentified",
    "internal_use",
    "transfer_out",
]


# ---------------------------------------------------------------------------
# Insumos (admin).
# ---------------------------------------------------------------------------


class IngredientIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    category: str | None = None
    base_unit: BaseUnitLiteral
    purchase_unit: str = Field(min_length=1, max_length=50)
    purchase_factor: int = Field(gt=0)
    yield_pct: int = Field(default=100, ge=1, le=100)
    # Decimales como texto (nunca `float` de JSON): `app.core.quantity`.
    official_cost: str | None = None
    estimated_cost: str | None = None
    min_stock: str  # obligatorio; `> 0` lo exige el service (`400 MIN_STOCK_REQUIRED`)
    lead_time_days: int | None = Field(default=None, ge=0)
    perishable: bool = False
    key_item: bool = False
    consumption_untracked: bool = False
    substitute_ingredient_id: int | None = None
    supplier_id: int | None = None
    active: bool = True


class IngredientUpdateIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    category: str | None = None
    base_unit: BaseUnitLiteral | None = None
    purchase_unit: str | None = Field(default=None, min_length=1, max_length=50)
    purchase_factor: int | None = Field(default=None, gt=0)
    yield_pct: int | None = Field(default=None, ge=1, le=100)
    official_cost: str | None = None
    clear_official_cost: bool = False
    estimated_cost: str | None = None
    clear_estimated_cost: bool = False
    min_stock: str | None = None
    lead_time_days: int | None = Field(default=None, ge=0)
    perishable: bool | None = None
    key_item: bool | None = None
    consumption_untracked: bool | None = None
    substitute_ingredient_id: int | None = None
    clear_substitute: bool = False
    supplier_id: int | None = None
    active: bool | None = None


class IngredientOut(BaseModel):
    id: int
    name: str
    category: str | None
    base_unit: BaseUnitLiteral
    purchase_unit: str
    purchase_factor: int
    yield_pct: int
    official_cost: str | None
    estimated_cost: str | None
    cost: str | None  # resuelto (`resolve_ingredient_cost`), en pesos por unidad base
    cost_source: CostSourceLiteral
    min_stock: str
    lead_time_days: int | None
    perishable: bool
    key_item: bool
    consumption_untracked: bool
    substitute_ingredient_id: int | None
    supplier_id: int | None
    active: bool


# ---------------------------------------------------------------------------
# Movimientos.
# ---------------------------------------------------------------------------


class StockMovementOut(BaseModel):
    id: int
    ingredient_id: int | None
    preparation_id: int | None
    qty_base: str
    cause: MovementCauseLiteral
    cost: str | None
    cost_source: CostSourceLiteral
    employee_id: int
    employee_name: str
    at: datetime
    business_date: str
    ref_type: str | None
    ref_id: int | None
    note: str | None


# ---------------------------------------------------------------------------
# Stock teórico.
# ---------------------------------------------------------------------------


class StockRowOut(BaseModel):
    ingredient_id: int
    name: str
    base_unit: BaseUnitLiteral
    qty_base: str
    min_stock: str
    below_min: bool
    negative: bool
    negative_since: datetime | None
    cost: str | None
    cost_source: CostSourceLiteral
    key_item: bool


# ---------------------------------------------------------------------------
# Mermas.
# ---------------------------------------------------------------------------


class WasteIn(BaseModel):
    ingredient_id: int | None = None
    preparation_id: int | None = None
    qty: str
    # La unidad en que viene `qty`. `None` = unidad base (g, ml, und), como
    # siempre. El POS manda la unidad cómoda del insumo (`entry_unit` de
    # `GET /device/ingredients`: «kg», «botella», «L», «unidad») y el
    # servidor convierte; si no coincide con la del insumo, `400` (la
    # pantalla quedó vieja). Sólo para insumos.
    entry_unit: str | None = Field(default=None, max_length=50)
    type: WasteTypeLiteral
    note: str | None = None
    employee_pin: str = Field(min_length=1, max_length=20)
    photo: PhotoIn | None = None
    # Consumo interno (`internal_use`): quién. Un empleado o un texto
    # («dueño»); uno de los dos es obligatorio para ese tipo y se ignoran en
    # los demás.
    consumer_employee_id: int | None = None
    consumer_name: str | None = Field(default=None, max_length=200)
    # Traslado (`transfer_out`): la sede destino, de la misma organización.
    destination_store_id: int | None = None


class WasteOut(BaseModel):
    """Salida de `POST /waste` (ruta de dispositivo): sin `cost` ni
    `cost_source` a propósito — el operador no recibe costos. El admin lee
    el costo en `WasteAdminOut` (`GET /admin/waste`)."""

    id: int
    ingredient_id: int | None
    preparation_id: int | None
    qty: str
    type: WasteTypeLiteral
    employee_id: int
    employee_name: str
    at: datetime
    consumer_employee_id: int | None = None
    consumer_name: str | None = None
    destination_store_id: int | None = None


class WasteAdminOut(WasteOut):
    cost: str | None
    cost_source: CostSourceLiteral
    note: str | None
    photo: str | None
    # Traslado: cuándo y quién lo recibió en la sede destino (`None` =
    # todavía en camino, o no es un traslado).
    received_at: datetime | None = None
    received_by_employee_name: str | None = None


class WasteKpiOut(BaseModel):
    """Mermas ÷ compras semanal (SPEC-NEGOCIO §5.5). **`ratio` es el único
    número no entero de toda la fase 2 — 2b lo cierra** (`outputs-2a/
    ENTREGA.md § 5`, O-6): en puntos básicos (× 10.000: `2.5 %` = `250`),
    nunca `float`. `null` con `label` legible cuando no hay compras en el
    período (mermas sin denominador no es `0`, es "sin datos"); deja de ser
    `null` en cuanto hay al menos una compra (`cause=PURCHASE` en el libro)
    en el rango."""

    ratio: int | None
    label: str


class WasteListOut(BaseModel):
    items: list[WasteAdminOut]
    weekly_kpi: WasteKpiOut


# ---------------------------------------------------------------------------
# Traslados entre sedes (merma `transfer_out` y su recepción).
# ---------------------------------------------------------------------------


class TransferStoreOut(BaseModel):
    """Una sede a la que se puede trasladar (dispositivo): sólo id y nombre."""

    id: int
    name: str


class IncomingTransferOut(BaseModel):
    """Un traslado que llega a esta sede (admin). `cost` es el costo por
    unidad base con el que salió de la sede origen — el mismo con el que
    entra acá (`format_cost_micros`, texto; `None` = sin costo conocido,
    nunca `0`). `suggested_ingredient_id` es el insumo de esta sede con el
    mismo nombre y la misma unidad base, si hay uno; quien recibe decide."""

    id: int
    source_store_id: int
    source_store_name: str
    ingredient_id: int
    ingredient_name: str
    base_unit: BaseUnitLiteral
    qty: str
    cost: str | None
    cost_source: CostSourceLiteral
    sent_at: datetime
    sent_by_employee_name: str
    note: str | None
    photo: str | None
    suggested_ingredient_id: int | None
    received_at: datetime | None
    received_ingredient_id: int | None
    received_by_employee_name: str | None


class TransferReceiveIn(BaseModel):
    """El insumo de ESTA sede donde entra el traslado."""

    ingredient_id: int


# ---------------------------------------------------------------------------
# Ajustes manuales.
# ---------------------------------------------------------------------------


class AdjustmentIn(BaseModel):
    ingredient_id: int
    qty_delta: str  # decimal, con signo (positivo = entra, negativo = sale)
    reason: str = Field(min_length=1, max_length=500)
    authorizer_pin: str = Field(min_length=1, max_length=20)


class AdjustmentOut(BaseModel):
    """`id` es el del `StockMovement` resultante (`cause=manual_adjustment`);
    `employee_id`/`employee_name` son quien autorizó (`authorizer_pin`
    verificado contra el personal admin de la organización), la misma
    persona que queda como atribución del movimiento."""

    id: int
    ingredient_id: int
    qty_delta: str
    reason: str
    employee_id: int
    employee_name: str
    at: datetime


# ---------------------------------------------------------------------------
# Dispositivo: sin ningún campo de costo.
# ---------------------------------------------------------------------------


class DeviceIngredientOut(BaseModel):
    id: int
    name: str
    base_unit: BaseUnitLiteral
    # La unidad cómoda en que se teclea (la misma del conteo corto por área,
    # `units.entry_spec`): la merma del POS la muestra junto al campo y la
    # devuelve en `WasteIn.entry_unit`.
    entry_mode: AreaCountEntryModeLiteral
    entry_unit: str


# ---------------------------------------------------------------------------
# Lotes y vencimientos (pedido 2b, SPEC-NEGOCIO §5.7).
# ---------------------------------------------------------------------------

LotStatusLiteral = Literal["active", "expiring", "expired", "depleted"]


class LotOut(BaseModel):
    id: int
    ingredient_id: int
    ingredient_name: str
    lot_code: str | None
    qty_received: str
    qty_remaining: str
    unit_cost: str
    cost_source: CostSourceLiteral
    expires_at: str | None  # fecha ISO (`date`), o `null` == nunca vence
    received_at: datetime
    status: LotStatusLiteral
    source_type: str
    source_id: int


# ---------------------------------------------------------------------------
# Conteos a ciegas (pedido 2b, SPEC-NEGOCIO §5.4).
# ---------------------------------------------------------------------------

CountScopeLiteral = Literal["key_items", "full"]
CountStatusLiteral = Literal["open", "applied"]


class CountOpenIn(BaseModel):
    scope: CountScopeLiteral


class CountLineRefIn(BaseModel):
    """Una línea capturada. `was_counted` la escribe la persona que cuenta,
    renglón por renglón — **no existe un atajo que la ponga en `True` para
    todos los renglones a la vez** (SPEC-NEGOCIO §5.4)."""

    ingredient_id: int
    qty_counted: str  # texto decimal (`parse_qty_base`); un número JSON crudo se rechaza
    was_counted: bool = True


class CountLinesIn(BaseModel):
    lines: list[CountLineRefIn] = Field(min_length=1)


class CountLineOut(BaseModel):
    """**A CIEGAS por diseño**: ni un campo de stock teórico, ni una
    diferencia, ni un "sugerido". `previous_qty_counted` es la ÚNICA
    referencia en pantalla (SPEC-NEGOCIO §5.4: "la referencia en pantalla es
    el conteo anterior") — el valor que una persona escribió en el conteo
    anterior, nunca un cálculo del libro."""

    ingredient_id: int
    ingredient_name: str
    base_unit: BaseUnitLiteral
    qty_counted: str | None
    was_counted: bool
    previous_qty_counted: str | None


class CountLinesSaveOut(BaseModel):
    """Salida de `PUT /admin/counts/{id}/lines`: dice explícitamente que el
    guardado es PARCIAL (nunca implica "todo coincide")."""

    lines: list[CountLineOut]
    lines_counted: int
    lines_total: int
    partial: bool


class CountOut(BaseModel):
    id: int
    scope: CountScopeLiteral
    status: CountStatusLiteral
    opened_at: datetime
    business_date: str
    opened_by_employee_id: int
    opened_by_employee_name: str
    applied_at: datetime | None
    applied_by_employee_id: int | None
    applied_by_employee_name: str | None
    lines_total: int
    lines_counted: int


class CountDetailOut(CountOut):
    lines: list[CountLineOut]


class CountApplyIn(BaseModel):
    authorizer_pin: str = Field(min_length=1, max_length=20)


class CountApplyLineOut(BaseModel):
    ingredient_id: int
    ingredient_name: str
    qty_counted: str
    stock_before: str
    adjustment: str
    stock_after: str


class CountApplyOut(BaseModel):
    id: int
    applied_at: datetime
    applied_by_employee_id: int
    applied_by_employee_name: str
    lines: list[CountApplyLineOut]


# ---------------------------------------------------------------------------
# Varianza, food cost real y salud del control (pedido 2b, SPEC-NEGOCIO §5.4).
# ---------------------------------------------------------------------------

VarianceLevelLiteral = Literal["green", "yellow", "red"]


class VarianceRowOut(BaseModel):
    ingredient_id: int
    ingredient_name: str
    base_unit: BaseUnitLiteral
    opening_qty: str
    inflow_qty: str
    closing_qty: str
    real_usage_qty: str
    theoretical_usage_qty: str
    variance_qty: str  # real - teórico; positivo = se usó más de lo esperado
    # TOTAL de plata (no costo por unidad base): pesos enteros, igual
    # convención que cualquier total de venta ya cerrado (`app.core.money`;
    # NUNCA `format_cost_micros`, que es para costo POR UNIDAD, no un total).
    # Nombrado `variance_value`, no `variance_cost`: el barrido heredado
    # `tests/audit/test_cost_invariants.py::
    # test_no_cost_field_of_inventory_or_recipes_is_typed_as_an_integer`
    # exige que TODO campo `cost`/`*_cost` de `inventory`/`recipes` sea texto
    # decimal (por unidad base) — correcto para el resto del dominio, pero
    # este campo es a propósito un TOTAL ya cerrado, no una tarifa por
    # unidad; cambiarle el nombre evita forzar ese barrido a mentir sobre lo
    # que audita en vez de acotarlo sin necesidad.
    variance_value: int | None
    cost_source: CostSourceLiteral
    variance_pct_bp: int | None  # |variance| / teórico, en puntos básicos (× 10.000); null si teórico == 0
    # Semáforo. El rojo es SÓLO para faltante (`variance_qty > 0`): un
    # sobrante (se contó más de lo que el libro explica) llega como mucho a
    # `yellow`, por grande que sea (informe de visualización, #9).
    level: VarianceLevelLiteral


class VarianceParetoRowOut(BaseModel):
    """Un renglón del Pareto de varianza por insumo: los insumos ordenados
    por |valor| descendente (a igual valor, el faltante primero), con la
    participación y el acumulado de |valor| sobre el total de |valor|."""

    ingredient_id: int
    ingredient_name: str
    # Con signo, pesos enteros (misma convención que `VarianceRowOut.
    # variance_value`): positivo = faltante (se usó más de lo esperado).
    variance_value: int
    # |variance_value|, pesos enteros — el alto de la barra del Pareto.
    abs_value: int
    direction: Literal["shortage", "surplus"]
    # |valor| de este renglón ÷ Σ |valor| de todos, en bp.
    share_bp: int
    # Σ |valor| de este renglón y todos los anteriores ÷ Σ |valor|, en bp
    # (el último renglón da 10000 exacto).
    cumulative_bp: int
    level: VarianceLevelLiteral


class VarianceOut(BaseModel):
    # `None` sólo cuando se pidió «el último» (`count_id` omitido) y la sede
    # no tiene ningún conteo aplicado (`available: false` con `reason`).
    count_id: int | None
    opening_count_id: int | None
    window_from: datetime | None
    window_to: datetime | None
    available: bool
    reason: str | None
    rows: list[VarianceRowOut]
    yellow_threshold_bp: int
    red_threshold_bp: int
    # El conteo aplicado más reciente de la sede (cualquier alcance), para
    # que la pantalla abra con él sin pedirle al dueño que lo elija. `None`
    # si no hay ninguno.
    latest_applied_count_id: int | None = None
    # Pareto: sólo los renglones con `variance_value` distinto de 0 y no
    # nulo, ordenados por |valor| desc. Los que no tienen costo resuelto no
    # entran (no hay |$| que ordenar) y se cuentan en `unvalued_rows`.
    pareto: list[VarianceParetoRowOut] = []
    # Σ |valor| del Pareto (el 100 % del acumulado); `None` si no hay
    # ningún renglón valorizado con varianza.
    total_abs_variance_value: int | None = None
    # Σ de los faltantes (positivo) y Σ de los sobrantes (negativo, con su
    # signo), pesos; `None` en las mismas condiciones que el total.
    shortage_value: int | None = None
    surplus_value: int | None = None
    # Σ con signo (faltantes + sobrantes), pesos.
    net_variance_value: int | None = None
    unvalued_rows: int = 0


class FoodCostOut(BaseModel):
    """(inventario inicial + compras − final) ÷ ventas netas, **sólo entre
    dos conteos completos consecutivos**. `pct_bp` es `null` (con `reason`)
    sin esos dos conteos — **jamás `0`**."""

    available: bool
    reason: str | None
    opening_count_id: int | None
    closing_count_id: int | None
    window_from: str | None
    window_to: str | None
    # TOTALES de plata: pesos enteros (`app.core.money`), no costo por
    # unidad base -- `format_cost_micros` no aplica acá.
    opening_value: int | None
    purchases_value: int | None
    closing_value: int | None
    net_sales: int | None
    # Food cost REAL en bp de `net_sales`, con signo. `null` con `reason`
    # también cuando el cálculo existe pero no tiene sentido: ventana más
    # corta que `min_window_days`, compras en $0 habiendo recepciones, o
    # resultado negativo (el inventario final vale más que inicial + compras).
    pct_bp: int | None
    # La ventana son los INSTANTES de apertura de los dos conteos
    # (`window_from`, `window_to`); ventas e inventario usan la misma: las
    # comandas cuentan por `paid_at` en `(window_from, window_to]`, así una
    # venta nunca cae en dos ventanas. Horas y días COMPLETOS (truncados).
    # `null` sólo cuando no hay par de conteos.
    window_hours: int | None = None
    window_days: int | None = None
    # Comandas cobradas en la ventana (el `n` del porcentaje).
    orders_in_window: int | None = None
    # Food cost TEÓRICO de lo vendido en la misma ventana (costo congelado ÷
    # ventas netas de lo costeado), en bp. `null` con `theoretical_reason`
    # sin ventas, sin fichas o con cobertura bajo `min_costed_pct_bp`.
    theoretical_pct_bp: int | None = None
    theoretical_reason: str | None = None
    # Qué parte de las ventas netas de la ventana tenía ficha con costo, en bp.
    costed_pct_bp: int | None = None
    # `pct_bp − theoretical_pct_bp` (puntos básicos de brecha: positivo =
    # se gastó más insumo del que explican las ventas). `null` si falta
    # cualquiera de los dos.
    gap_bp: int | None = None
    # Umbrales usados, publicados para que la pantalla los muestre sin
    # conocerlos por fuera (`app.inventory.hooks`).
    min_window_days: int = 1
    min_costed_pct_bp: int = 8000


class ControlHealthOut(BaseModel):
    days_since_full_count: int | None
    last_full_count_at: datetime | None
    inventory_unreliable: bool
    reception_invoice_ratio_bp: int | None
    reception_invoice_ratio_reason: str | None
    batch_preps_produced_ratio_bp: int | None
    batch_preps_produced_reason: str | None
    waste_entries_this_week: int


# ---------------------------------------------------------------------------
# Umbrales de varianza (configuración de sede; vive en `inventory` por
# decisión de arquitectura — no toca `app.stores`).
# ---------------------------------------------------------------------------


class InventorySettingsIn(BaseModel):
    variance_yellow_threshold_bp: int = Field(gt=0)
    variance_red_threshold_bp: int = Field(gt=0)


class InventorySettingsOut(BaseModel):
    store_id: int
    variance_yellow_threshold_bp: int
    variance_red_threshold_bp: int


# ---------------------------------------------------------------------------
# NOTA (ronda 2, H-2): los esquemas de la lectura agregada de consumo por
# comanda (§5.3) y el endpoint `GET /admin/orders/{order_id}/consumption`
# que los servía vivieron acá durante la ronda 1 de 2b y se SACARON por
# decisión del Maestro: la implementación de `app.orders` (que ya despachaba
# esa misma ruta en runtime) lee el costo CONGELADO de cada fila del libro
# -- snapshot, regla dura -- y suma `SALE + NOTE_RETURN` (consumo neto
# real), mientras la de acá revaloraba con `resolve_ingredient_cost` de HOY
# y sólo miraba `SALE`. Sacar la de acá no cambió ni una respuesta servida
# (la de `orders` es la que el ruteo real usaba); sólo alineó el contrato
# publicado con lo servido. Ver `outputs-2b/backend-inventario-espejo.md §
# Ronda 2`.
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Conteo corto por área (`inventory.shift_counts`). Los esquemas de
# DISPOSITIVO (`Device*`, `AreaCount*In`, `AreaCountReceiptOut`) no llevan
# stock del sistema, ni conteo anterior, ni costo: el conteo es a ciegas y el
# operador nunca ve plata de inventario. Los de administrador sí llevan la
# diferencia valorizada.
# ---------------------------------------------------------------------------

AreaCountMomentLiteral = Literal["opening", "closing", "spot"]
AreaCountRegularMomentLiteral = Literal["opening", "closing"]
# Cómo se teclea cada artículo en el POS (lo decide el servidor, por insumo):
# `AreaCountEntryModeLiteral` (arriba, junto a `BaseUnitLiteral`): `weight`
# en kg (carnes, vegetales), `bottle` en botellas con décimas de la abierta
# (licores: unidad de compra en ml), `volume` en litros, `unit` en unidades.
# `night` = del cierre anterior a esta apertura; `shift` = de la apertura a
# este cierre; `spot` = recuento sorpresa contra el sistema en ese instante.
AreaCountWindowLiteral = Literal["night", "shift", "spot"]
AreaRecountStatusLiteral = Literal["pending", "answered"]


class AreaCountItemOut(BaseModel):
    ingredient_id: int
    name: str
    base_unit: BaseUnitLiteral
    entry_mode: AreaCountEntryModeLiteral
    # Rótulo de la unidad en que se teclea («kg», «botella», «unidad»).
    entry_unit: str


class AreaCountDoneOut(BaseModel):
    count_id: int
    counted_at: datetime
    employee_name: str


class DeviceAreaRecountOut(BaseModel):
    id: int
    requested_at: datetime
    requested_by_employee_name: str
    note: str | None
    items: list[AreaCountItemOut]


class DeviceAreaCountBoardOut(BaseModel):
    """`GET /device/area-count`: la lista del área de la persona identificada,
    sin stock ni conteo anterior. `area_id=None` con `reason` cuando no hay
    lista que mostrar (nadie identificado, persona sin área, área sin
    artículos)."""

    area_id: int | None
    area_name: str | None
    reason: str | None
    business_date: str
    items: list[AreaCountItemOut]
    suggested_moment: AreaCountRegularMomentLiteral
    opening_done: AreaCountDoneOut | None
    closing_done: AreaCountDoneOut | None
    recounts: list[DeviceAreaRecountOut]


class AreaCountLineIn(BaseModel):
    ingredient_id: int
    # Texto decimal en la unidad de `entry_unit` («2.3» = 2 botellas y 3/10).
    qty: str = Field(min_length=1, max_length=20)


class AreaCountIn(BaseModel):
    moment: AreaCountRegularMomentLiteral
    lines: list[AreaCountLineIn] = Field(min_length=1, max_length=50)


class AreaRecountAnswerIn(BaseModel):
    lines: list[AreaCountLineIn] = Field(min_length=1, max_length=5)


AreaCountScopeLiteral = Literal["short", "full"]


class AreaCountItemIn(BaseModel):
    """`POST /device/area-count-items`: UN artículo contado (se guarda al
    contarlo). Cualquier persona identificada cuenta cualquier área: quien
    termina primero ayuda al otro."""

    area_id: int
    moment: AreaCountRegularMomentLiteral
    ingredient_id: int
    qty: str = Field(min_length=1, max_length=20)


class AreaCountMarkOut(BaseModel):
    """Quién contó un artículo y a qué hora — **sin la cantidad**: el conteo
    es a ciegas también entre compañeros. `entries` > 1 = se recontó (manda
    la última)."""

    employee_name: str
    counted_at: datetime
    entries: int


class AreaCountProgressOut(BaseModel):
    """Cuántos artículos de la lista del día tienen conteo. `complete` lo
    decide el servidor (todos contados); `completed_at` es la hora del último
    que faltaba, y `people` quién contó."""

    counted: int
    total: int
    complete: bool
    completed_at: datetime | None
    people: list[str]


class AreaCountSheetItemOut(AreaCountItemOut):
    opening: AreaCountMarkOut | None
    closing: AreaCountMarkOut | None


class AreaCountSheetAreaOut(BaseModel):
    area_id: int
    area_name: str
    # `full` el día del conteo completo mensual (todo lo del área por
    # categoría); `short` los demás días (la lista corta, 5–15).
    scope: AreaCountScopeLiteral
    # Si es el área de la persona identificada (la pestaña «Mi área»).
    mine: bool
    items: list[AreaCountSheetItemOut]
    opening: AreaCountProgressOut
    closing: AreaCountProgressOut


class DeviceAreaCountSheetOut(BaseModel):
    """`GET /device/area-count/sheet`: las listas del día de TODAS las áreas
    (la pantalla filtra por Mi área | Bar | Cocina | Todo), con quién contó
    cada artículo y cuándo, sin cantidades, sin stock y sin costo."""

    business_date: str
    my_area_id: int | None
    # Por qué no hay «Mi área» (persona sin área), o `None`.
    reason: str | None
    suggested_moment: AreaCountRegularMomentLiteral
    full_count_today: bool
    # La apertura del área de esta persona es obligatoria y todavía no está.
    opening_required: bool
    areas: list[AreaCountSheetAreaOut]
    recounts: list[DeviceAreaRecountOut]


class AreaCountItemSavedOut(BaseModel):
    """Lo que vuelve al guardar un artículo: que quedó, quién y cuándo, y cómo
    va el área. Ninguna cifra."""

    area_id: int
    area_name: str
    moment: AreaCountRegularMomentLiteral
    ingredient_id: int
    ingredient_name: str
    count_id: int
    counted_at: datetime
    employee_name: str
    progress: AreaCountProgressOut


class AreaOpeningPendingOut(BaseModel):
    area_id: int
    area_name: str
    counted: int
    total: int
    full_count: bool


class DeviceOpeningGateOut(BaseModel):
    """`GET /device/area-count/gate`: si la persona identificada tiene que
    hacer primero el conteo de apertura de su área (`required`), y qué áreas
    no terminaron su apertura hoy (`pending`, para el aviso rojo del KDS,
    que no se bloquea nunca). Sin persona, `required=False`."""

    business_date: str
    required: bool
    area_id: int | None
    area_name: str | None
    message: str | None
    pending: list[AreaOpeningPendingOut]


class AdminAreaCountStatusOut(BaseModel):
    """`GET /admin/area-count-status`: cómo va el conteo de hoy por área y
    artículo (quién y cuándo). Las cantidades y diferencias están en el
    detalle de cada conteo."""

    business_date: str
    full_count_today: bool
    areas: list[AreaCountSheetAreaOut]


class AreaCountReceiptOut(BaseModel):
    """Lo que vuelve a la tablet: que quedó registrado, quién y cuándo.
    Ninguna cifra del sistema ni diferencia: el resultado lo ve el dueño."""

    id: int
    area_name: str
    moment: AreaCountMomentLiteral
    counted_at: datetime
    employee_name: str
    lines_count: int


class CountAreaIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class CountAreaUpdateIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    active: bool | None = None


class CountAreaItemsIn(BaseModel):
    ingredient_ids: list[int] = Field(max_length=15)


class CountAreaMemberIn(BaseModel):
    employee_id: int
    # `None` saca a la persona de su área (queda sin lista en el POS).
    area_id: int | None


class CountAreaMemberOut(BaseModel):
    employee_id: int
    employee_name: str


class CountAreaCategoriesIn(BaseModel):
    # Categorías de insumo (`ingredients.category`) del conteo completo mensual.
    categories: list[str] = Field(max_length=40)


class CountAreaOut(BaseModel):
    id: int
    name: str
    active: bool
    members: list[CountAreaMemberOut]
    items: list[AreaCountItemOut]
    # Las categorías que cuenta el día del conteo completo, y cuántos insumos
    # activos tendría esa lista hoy (lista corta incluida).
    categories: list[str]
    full_count_items: int


class AreaCountSettingsIn(BaseModel):
    # `None` = esa frontera no se exige.
    threshold_pct_bp: int | None = Field(default=None, gt=0, le=10000)
    threshold_amount: int | None = Field(default=None, gt=0)
    # Día del mes del conteo completo (1–28; `None` = apagado). Si no viene en
    # el cuerpo, queda como estaba (guardar el umbral no lo apaga).
    monthly_full_count_day: int | None = Field(default=None, ge=1, le=28)


class AreaCountSettingsOut(BaseModel):
    store_id: int
    threshold_pct_bp: int | None
    threshold_amount: int | None
    # La regla en palabras, escrita por el servidor (patrón 9, «la lectura»).
    reading: str
    monthly_full_count_day: int | None
    monthly_reading: str
    full_count_today: bool


class AreaCountLineOut(BaseModel):
    """Un renglón con su derivación completa (patrón: cada cifra dice de
    dónde sale): `expected = reference + inflow − outflow` y
    `shortage = expected − counted` (positivo = faltó, negativo = sobró).
    En un recuento sorpresa `reference` es el stock del sistema en ese
    instante y `inflow`/`outflow` van en `None`. Todo `None` con
    `null_reason` cuando no hay contra qué comparar (nunca un `0` mudo)."""

    ingredient_id: int
    ingredient_name: str
    base_unit: BaseUnitLiteral
    entered_qty: str
    entered_unit: str
    counted_qty: str
    reference_qty: str | None
    inflow_qty: str | None
    outflow_qty: str | None
    expected_qty: str | None
    shortage_qty: str | None
    shortage_value: int | None
    shortage_pct_bp: int | None
    flagged: bool
    null_reason: str | None
    # Quién contó este artículo y cuándo (la entrada que manda), y las
    # entradas anteriores del mismo artículo en este conteo (recuentos).
    employee_name: str | None
    counted_at: datetime | None
    history: list["AreaCountEntryOut"]


class AreaCountEntryOut(BaseModel):
    employee_name: str | None
    counted_at: datetime | None
    entered_qty: str
    entered_unit: str
    counted_qty: str


AreaCountLineOut.model_rebuild()


class AreaCountOut(BaseModel):
    id: int
    area_id: int
    area_name: str
    moment: AreaCountMomentLiteral
    window: AreaCountWindowLiteral
    counted_at: datetime
    business_date: str
    employee_name: str
    # El conteo contra el que se compara (`None` en un recuento sorpresa o
    # cuando no hay anterior; `reason` dice cuál de las dos).
    reference_count_id: int | None
    reference_counted_at: datetime | None
    reference_employee_name: str | None
    reason: str | None
    # `True` cuando hay un conteo posterior del mismo área, momento y día:
    # manda el último, éste queda en el historial.
    superseded: bool
    lines_count: int
    flagged_count: int
    # Σ de las diferencias valorizadas (faltante positivo). `None` si ningún
    # renglón tiene valor; `unvalued_lines` dice cuántos quedaron afuera.
    shortage_value_total: int | None
    unvalued_lines: int
    # 0030: con qué lista (`short`/`full`, `None` en un recuento), quiénes
    # contaron (en orden) y la hora del último artículo.
    scope: AreaCountScopeLiteral | None
    people: list[str]
    last_counted_at: datetime


class AreaCountDetailOut(AreaCountOut):
    lines: list[AreaCountLineOut]


class AreaRecountRequestIn(BaseModel):
    area_id: int
    ingredient_ids: list[int] = Field(min_length=1, max_length=5)
    note: str | None = Field(default=None, max_length=300)


class AreaRecountRequestOut(BaseModel):
    id: int
    area_id: int
    area_name: str
    items: list[AreaCountItemOut]
    note: str | None
    status: AreaRecountStatusLiteral
    requested_at: datetime
    requested_by_employee_name: str
    answered_at: datetime | None
    count_id: int | None
