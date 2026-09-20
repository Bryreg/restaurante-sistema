"""Esquemas Pydantic de `analytics` (T4, `features/fase-3-dinero-control/spec.md § 2`).

Convenciones (`docs/CONTEXTO-AGENTES.md §4/§9`, mismas que el resto del
proyecto, sin excepción):

- Plata: `int` de pesos enteros.
- Costo POR UNIDAD BASE de insumo (nunca un total ya cerrado): texto decimal
  vía `format_cost_micros`, anotado `str | None` — nunca `int`.
- Cantidad de insumo: texto decimal vía `format_qty_base` — nunca `int` en
  milésimas crudas.
- Porcentajes/puntos: puntos básicos (`_bp`, `int`, 1 % = 100).
- Todo indicador sin datos suficientes es `None` **con** `reason` — nunca
  `0`, nunca una lista vacía muda sin explicación.
- `NINGÚN float`, en ningún campo, en ninguna capa.

Este dominio es COSTOS Y MÁRGENES: todas sus rutas son de administrador
(`current_admin`), nunca de operador (`AGENTS.md`: "el operador no recibe
costos ni márgenes en ninguna respuesta").
"""

from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import BaseModel

# ---------------------------------------------------------------------------
# GET /admin/menu-engineering
# ---------------------------------------------------------------------------

MenuClassLiteral = Literal["star", "plowhorse", "puzzle", "dog", "unclassified"]


class MenuEngineeringRowOut(BaseModel):
    product_id: int
    # Nombre CONGELADO del último ítem agregado (`OrderItem.name`), nunca
    # `Product.name` de la carta actual — el plato pudo renombrarse después.
    product_name: str
    qty_sold: int
    # Participación del plato en las unidades vendidas del período, en
    # puntos básicos (Σ de todas las filas == 10000, salvo redondeo).
    popularity_share_bp: int
    # Ingreso NETO (sin impuesto) del período para este plato — misma
    # convención que `app.reports.schemas.SalesBucketOut.net`
    # (`gross - tax`), NUNCA el total con impuesto incluido.
    revenue_net: int
    # Costo teórico CONGELADO (`OrderItem.unit_cost_micros`, nunca la ficha
    # de hoy), acumulado en micros y redondeado una sola vez al cierre.
    # `None` cuando NINGÚN ítem vendido de este plato tenía costo congelado.
    theoretical_cost: int | None
    # `revenue_net - theoretical_cost`; `None` si `theoretical_cost` es `None`.
    contribution_margin: int | None
    margin_pct_bp: int | None
    # Cuántas de las unidades vendidas SÍ tenían costo congelado, en puntos
    # básicos de `qty_sold` — transparencia sobre cuánto de `theoretical_cost`
    # es cobertura parcial (mismo espíritu que `SalesBucketOut.costed_pct`,
    # pero sobre unidades, no sobre pesos).
    costed_qty_pct_bp: int | None
    classification: MenuClassLiteral
    classification_reason: str


class MenuEngineeringOut(BaseModel):
    store_id: int
    date_from: date
    date_to: date
    available: bool
    reason: str | None
    # Umbral de popularidad usado para clasificar (regla del 70 %,
    # Kasavana–Smith: `0.7 / n_platos`, en bp). `None` si `available=False`.
    popularity_threshold_bp: int | None
    # Margen de contribución promedio PONDERADO por unidad vendida
    # (Σ contribution_margin de platos costeados ÷ Σ qty_sold de esos
    # mismos platos), pesos por unidad. `None` si `available=False` o si
    # ningún plato tiene costo congelado en el período.
    avg_contribution_margin_per_unit: int | None
    rows: list[MenuEngineeringRowOut]


# ---------------------------------------------------------------------------
# GET /admin/variance/by-dish
# ---------------------------------------------------------------------------


class VarianceByDishRowOut(BaseModel):
    product_id: int
    product_name: str
    # Cuánto del consumo TEÓRICO (de los insumos con varianza en la
    # ventana) le corresponde a este plato, en puntos básicos — el peso que
    # usó el prorrateo, publicado para que quien audite pueda reproducir el
    # reparto.
    theoretical_consumption_share_bp: int
    # Valor de la varianza PRORRATEADA sobre este plato, en pesos.
    # Positivo = el prorrateo le atribuye más consumo real que teórico
    # (misma convención de signo que `VarianceRowOut.variance_qty`:
    # "positivo = se usó más de lo esperado").
    variance_value: int
    # De cuántos insumos con varianza en la ventana participó este plato
    # (transparencia del método, no una cifra de plata).
    ingredients_involved: int


class VarianceByDishOut(BaseModel):
    store_id: int
    # `count_id` del conteo aplicado que cierra la ventana (el mismo que
    # recibiría `GET /admin/variance?count_id=`) — el explícito si vino en
    # la query, o el resuelto por el backend (el más reciente `full`
    # `applied` de la sede) si se omitió. AJUSTE ITERACIÓN 2 (C3/H-3):
    # `None` únicamente cuando la sede no tiene NINGÚN conteo aplicado
    # todavía (no hay nada que resolver) — mismo criterio `null` con
    # `reason` que ya usa `SustainedOut` (D-1) para "sin historial
    # suficiente".
    count_id: int | None
    # Explícito en la respuesta, tal como pide SPEC-NEGOCIO §5.4: la
    # varianza por plato es SIEMPRE una estimación prorrateada, nunca una
    # medición directa por plato (eso no existe: el conteo es por insumo).
    method: Literal["prorated"]
    available: bool
    reason: str | None
    opening_count_id: int | None
    window_from: str | None
    window_to: str | None
    # Suma de `variance_value` de los insumos con varianza en la ventana,
    # antes de prorratear — para que Σ de `rows[].variance_value` se pueda
    # verificar contra esta cifra (pueden no calzar exactamente cuando algún
    # insumo con varianza no tuvo consumo teórico atribuible a ningún plato
    # en la ventana: ver `unattributed_variance_value`).
    total_variance_value: int | None
    # Varianza de insumos que SÍ tuvo valor pero que esta función no pudo
    # atribuir a ningún plato (sin movimientos `sale` con `ref_type=
    # "order_item"` de ese insumo en la ventana — p. ej. si todo su consumo
    # fue por una preparación por lote). `0` cuando todo se pudo repartir.
    unattributed_variance_value: int
    rows: list[VarianceByDishRowOut]


# ---------------------------------------------------------------------------
# GET /admin/control-health/sustained (D-1)
# ---------------------------------------------------------------------------


class SustainedWindowOut(BaseModel):
    window_index: int  # 1 = la más reciente computable, 2 la anterior, ...
    opening_count_id: int
    closing_count_id: int
    window_from: str
    window_to: str
    # Food cost real de la ventana, en puntos básicos de ventas netas
    # (mismo criterio que `app.inventory.schemas.FoodCostOut.pct_bp`, pero
    # recalculado acá para esta ventana histórica puntual — ver el docstring
    # de `service._window_food_cost_gap_bp`).
    real_pct_bp: int
    # Food cost TEÓRICO de la ventana (costo congelado de lo vendido ÷
    # ventas netas), misma escala.
    theoretical_pct_bp: int
    # `real_pct_bp - theoretical_pct_bp`, en PUNTOS PORCENTUALES (bp): la
    # brecha que D-1 define como base de "sostenido".
    gap_bp: int
    exceeds_red: bool


class SustainedOut(BaseModel):
    store_id: int
    # D-1: `null` con `reason` cuando hay menos de dos ventanas computables
    # — nunca verde/`False` por defecto.
    sustained_red: bool | None
    # Cuántas ventanas COMPUTABLES (con food cost real disponible) se
    # usaron, de las últimas 3 buscadas hacia atrás en el historial de
    # conteos completos aplicados. Nunca cuenta una ventana sin datos.
    windows_evaluated: int
    reason: str | None
    # El umbral rojo de la sede (`StoreInventorySettings.variance_red_
    # threshold_bp`, el mismo que ya calibra `_variance_level`; ver el
    # docstring de `service.control_health_sustained` sobre por qué se
    # reutiliza en vez de inventar un segundo umbral) — publicado para que
    # la pantalla pueda mostrar contra qué se está comparando.
    red_threshold_bp: int
    windows: list[SustainedWindowOut]


# ---------------------------------------------------------------------------
# GET /admin/replenishment
# ---------------------------------------------------------------------------


class ReplenishmentRowOut(BaseModel):
    ingredient_id: int
    ingredient_name: str
    base_unit: str
    current_stock: str  # format_qty_base
    min_stock: str  # format_qty_base (el configurado, `Ingredient.min_stock`)
    # Consumo diario promedio de los últimos `lookback_days`, texto decimal.
    # `None` sin consumo registrado en la ventana — nunca `0` mudo.
    avg_daily_consumption: str | None
    lead_time_days: int | None
    # Cuánto reponer AHORA para volver al mínimo configurado
    # (`max(0, min_stock - current_stock)`). SIEMPRE calculable (un `"0"`
    # real cuando el stock ya está sobre el mínimo, nunca `null`).
    suggested_qty: str
    # Mínimo PROPUESTO (punto de reorden): consumo diario promedio ×
    # `lead_time_days`. `None` con `reason` sin `lead_time_days` configurado
    # o sin consumo registrado — nunca `0`.
    suggested_min: str | None
    based_on: str
    reason: str | None


class ReplenishmentOut(BaseModel):
    store_id: int
    available: bool
    reason: str | None
    lookback_days: int
    rows: list[ReplenishmentRowOut]
