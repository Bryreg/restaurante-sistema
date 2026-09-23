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
    # Categoría de la carta (la de HOY: agrupa, no valora). `None` si el
    # producto ya no existe en la carta.
    category_id: int | None = None
    category_name: str | None = None
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
    # Margen de contribución de las unidades CON costo congelado: ingreso
    # neto de esas unidades − su costo teórico. Con cobertura completa es
    # `revenue_net - theoretical_cost`; con cobertura parcial NO resta el
    # costo de una parte contra el ingreso del todo (informe #4). `None` si
    # ninguna unidad tenía costo.
    contribution_margin: int | None
    # Margen de contribución POR UNIDAD, pesos: `contribution_margin ÷
    # unidades con costo`, half-up. Es el eje Y de la matriz y lo que se
    # compara contra `avg_contribution_margin_per_unit`. `None` si ninguna
    # unidad tenía costo.
    contribution_margin_per_unit: int | None = None
    # `contribution_margin ÷ ingreso neto de las unidades con costo`, bp.
    margin_pct_bp: int | None
    # Cuántas de las unidades vendidas SÍ tenían costo congelado, en puntos
    # básicos de `qty_sold` — transparencia sobre cuánto de `theoretical_cost`
    # es cobertura parcial (mismo espíritu que `SalesBucketOut.costed_pct`,
    # pero sobre unidades, no sobre pesos).
    costed_qty_pct_bp: int | None
    # `True` cuando el plato vendió menos de `min_units` en el período: no
    # se clasifica (`classification: None`), el motivo va en
    # `classification_reason`. Sigue contando para el umbral de popularidad
    # (es parte real de la mezcla vendida).
    insufficient_sample: bool = False
    # `None` = no se clasificó por muestra chica. `"unclassified"` = no hay
    # costo suficiente (ninguna unidad con costo, o menos de
    # `min_costed_pct_bp` de sus unidades).
    classification: MenuClassLiteral | None
    classification_reason: str
    # Qué hacer, en palabras del dueño: «Mantener» (estrella), «Revisar
    # precio» (caballo de batalla), «Promocionar» (rompecabezas), «Sacar o
    # rediseñar» (perro). `None` si no se clasificó.
    recommended_action: str | None = None


class MenuClassCountsOut(BaseModel):
    star: int = 0
    plowhorse: int = 0
    puzzle: int = 0
    dog: int = 0
    unclassified: int = 0
    insufficient_sample: int = 0


class MenuEngineeringOut(BaseModel):
    store_id: int
    date_from: date
    date_to: date
    available: bool
    reason: str | None
    # Umbral de popularidad usado para clasificar (regla del 70 %,
    # Kasavana–Smith: `0.7 / n_platos`, en bp de las unidades vendidas; es
    # la línea vertical de la matriz). `n_platos` cuenta sólo platos
    # vendibles (sin cargos como el de domicilio, sin comida de personal) de
    # la categoría filtrada si hay filtro. `None` si `available=False`.
    popularity_threshold_bp: int | None
    # Margen de contribución promedio PONDERADO por unidad (Σ
    # contribution_margin ÷ Σ unidades con costo, de los platos con
    # cobertura suficiente), pesos por unidad; es la línea horizontal de la
    # matriz. `None` si `available=False` o si ningún plato tiene costo
    # suficiente en el período.
    avg_contribution_margin_per_unit: int | None
    rows: list[MenuEngineeringRowOut]
    # Filtro aplicado (`?category_id=`), `None` = toda la carta. Con filtro,
    # los dos umbrales se calculan DENTRO de la categoría.
    category_id: int | None = None
    # Mínimo de unidades para clasificar un plato (`?min_units=`, 20 por
    # defecto).
    min_units: int = 20
    # Cobertura mínima de costo (bp de unidades del plato) para clasificar.
    min_costed_pct_bp: int = 8000
    # Qué parte del ingreso neto de los platos del análisis tiene costo
    # congelado, bp. `None` si `available=False`.
    costed_pct_bp: int | None = None
    # Cuántas filas quedaron en cada clase (contar filas, no plata).
    counts_by_class: MenuClassCountsOut = MenuClassCountsOut()
    # Productos vendidos que NO entran al análisis: cargos
    # (`is_delivery_fee`) y lo consumido como comida de personal.
    excluded_products: int = 0


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
    #
    # Informe #8: antes sumaba cantidades de insumos con unidades distintas
    # (gramos de papa con unidades de gaseosa). Ahora el peso es HOMOGÉNEO:
    # costo teórico consumido por el plato (cantidad teórica × costo del
    # insumo, en pesos), sobre los insumos con varianza valorizada.
    theoretical_consumption_share_bp: int
    # Valor de la varianza PRORRATEADA sobre este plato, en pesos.
    # Positivo = el prorrateo le atribuye más consumo real que teórico
    # (misma convención de signo que `VarianceRowOut.variance_qty`:
    # "positivo = se usó más de lo esperado").
    variance_value: int
    # De cuántos insumos con varianza en la ventana participó este plato
    # (transparencia del método, no una cifra de plata).
    ingredients_involved: int
    # `"shortage"` si `variance_value > 0` (faltante), `"surplus"` si < 0.
    direction: Literal["shortage", "surplus"] = "shortage"


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
    # Orden: faltantes primero, cada grupo por |variance_value| desc.
    rows: list[VarianceByDishRowOut]
    # Largo de la ventana entre los dos conteos (horas y días completos) y
    # comandas cobradas en ella (`paid_at` en la ventana). `None` si no hay
    # ventana.
    window_hours: int | None = None
    window_days: int | None = None
    sales_in_window: int | None = None
    # `True` si la ventana dura menos de `min_window_days` o tiene menos de
    # `min_sales_in_window` comandas: el reparto existe, pero es ruido; la
    # pantalla lo muestra en gris con `insufficient_sample_reason`.
    insufficient_sample: bool = False
    insufficient_sample_reason: str | None = None
    min_window_days: int = 3
    min_sales_in_window: int = 20


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
    # Largo de la ventana (horas y días completos), comandas cobradas en
    # ella, y qué parte de sus ventas netas tenía ficha con costo (bp). El
    # teórico está ESCALADO a esa cobertura (costo ÷ ventas de lo costeado),
    # y una ventana bajo `min_costed_pct_bp` no se evalúa (informe #4/#15).
    window_hours: int = 0
    window_days: int = 0
    orders_in_window: int = 0
    costed_pct_bp: int = 0


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
    # Reglas para que una ventana cuente (las mismas del food cost real,
    # `app.inventory.hooks`): al menos `min_window_days` días y
    # `min_costed_pct_bp` de cobertura de fichas; además, costo real no
    # negativo. Las que no cumplen se saltan, nunca cuentan como verdes.
    min_window_days: int = 1
    min_costed_pct_bp: int = 8000
    # Ventanas entre conteos que se saltaron por esas reglas (buscando las
    # últimas 3 computables).
    windows_skipped: int = 0


# ---------------------------------------------------------------------------
# GET /admin/replenishment
# ---------------------------------------------------------------------------


class ReplenishmentRowOut(BaseModel):
    ingredient_id: int
    ingredient_name: str
    base_unit: str
    current_stock: str  # format_qty_base
    min_stock: str  # format_qty_base (el configurado, `Ingredient.min_stock`)
    # Consumo diario PROMEDIO sobre `history_days` (los días reales con
    # historial dentro de los últimos `lookback_days`, no 30 fijos — informe
    # #17), texto decimal. `None` sin consumo registrado — nunca `0` mudo.
    avg_daily_consumption: str | None
    # Consumo diario MEDIANO sobre los mismos días (un día sin consumo
    # cuenta como 0), texto decimal: el «día típico», que no se deja mover
    # por un pico. `None` en las mismas condiciones que el promedio.
    median_daily_consumption: str | None = None
    # Días de negocio con historial que entraron a la cuenta: desde el
    # primer movimiento del insumo (o el inicio de la ventana, lo que sea
    # más reciente) hasta hoy, inclusive. `0` si el insumo no tiene
    # movimientos.
    history_days: int = 0
    lead_time_days: int | None
    # Cuánto reponer AHORA para volver al mínimo configurado
    # (`max(0, min_stock - current_stock)`). SIEMPRE calculable (un `"0"`
    # real cuando el stock ya está sobre el mínimo, nunca `null`).
    suggested_qty: str
    # Mínimo PROPUESTO (punto de reorden): consumo diario PROMEDIO ×
    # `lead_time_days` (el promedio y no la mediana: lo que importa es el
    # total esperado durante el plazo de entrega, picos incluidos). `None` con `reason` sin `lead_time_days` configurado
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
