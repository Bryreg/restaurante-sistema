/**
 * Ingeniería de menú, varianza por plato, salud sostenida (D-1) y reposición
 * sugerida (`features/fase-3-dinero-control/spec.md` § T4 `backend-analitica`,
 * contrato de API mínimo). Dominio `app.analytics` del backend.
 *
 * El contrato mínimo (spec.md § 2) sólo fija RUTAS; los campos de este
 * archivo se verificaron por lectura directa de
 * `backend/app/analytics/schemas.py` ya escrito — no adivinados. Se
 * mantienen opcionales/`| null` los que ese archivo no fija con un tipo
 * cerrado, para no romper si el backend agrega algo más encima.
 *
 * "Cobro por mesero" **no tiene cliente acá**: es `GET /admin/sales?
 * group_by=employee`, ya tipado en `api/reports.ts::getSales` — este archivo
 * no lo duplica.
 */

import { api } from "@/api/client"

export interface PeriodQuery {
  storeId: number
  from: string
  to: string
}

// ---------------------------------------------------------------------------
// GET /admin/menu-engineering — clasificación por plato, sobre el costo
// congelado en el ítem. Nunca revalora con la carta de hoy.
// ---------------------------------------------------------------------------

/** Clasificación de la matriz de ingeniería de menú (popularidad × margen). */
export type MenuEngineeringClass = "star" | "plowhorse" | "puzzle" | "dog" | "unclassified"

export interface MenuEngineeringRowOut {
  product_id: number
  /** Nombre CONGELADO del último ítem agregado — nunca la carta de hoy. */
  product_name?: string | null
  /** Categoría de la carta (la de hoy: agrupa, no valora). `null` si el producto ya no existe. */
  category_id?: number | null
  category_name?: string | null
  qty_sold?: number | null
  /** Participación en unidades vendidas del período, en puntos básicos. */
  popularity_share_bp?: number | null
  /** Ingreso neto (sin impuesto) del período para este plato. */
  revenue_net?: number | null
  /** `null` cuando NINGÚN ítem vendido de este plato tenía costo congelado. */
  theoretical_cost?: number | null
  /** Margen de las unidades CON costo (ingreso neto de esas unidades − su costo), pesos. */
  contribution_margin?: number | null
  /** Margen de contribución POR UNIDAD, pesos (eje Y de la matriz). `null` sin unidades con costo. */
  contribution_margin_per_unit?: number | null
  margin_pct_bp?: number | null
  costed_qty_pct_bp?: number | null
  /** `true` si vendió menos de `min_units`: no se clasifica (`classification: null`), motivo en `classification_reason`. */
  insufficient_sample?: boolean
  /** `null` = muestra chica; `"unclassified"` = sin costo suficiente. */
  classification?: MenuEngineeringClass | string | null
  classification_reason?: string | null
  /** «Mantener» | «Revisar precio» | «Promocionar» | «Sacar o rediseñar»; `null` si no se clasificó. */
  recommended_action?: string | null
}

/** Filas por clase (contar filas, no plata). */
export interface MenuClassCountsOut {
  star: number
  plowhorse: number
  puzzle: number
  dog: number
  unclassified: number
  insufficient_sample: number
}

export interface MenuEngineeringOut {
  store_id?: number
  date_from?: string
  date_to?: string
  available: boolean
  reason: string | null
  /** Umbral de popularidad (regla del 70 %: 0,7 ÷ n platos vendibles), bp de las unidades. Línea vertical de la matriz. */
  popularity_threshold_bp?: number | null
  /** Margen de contribución promedio por unidad (ponderado), pesos. Línea horizontal de la matriz. */
  avg_contribution_margin_per_unit?: number | null
  rows?: MenuEngineeringRowOut[]
  /** Filtro aplicado; `null` = toda la carta. Con filtro, los umbrales son de la categoría. */
  category_id?: number | null
  /** Mínimo de unidades para clasificar (20 por defecto). */
  min_units?: number
  /** Cobertura mínima de costo (bp de las unidades del plato) para clasificar. */
  min_costed_pct_bp?: number
  /** Parte del ingreso neto del análisis con costo congelado, bp. */
  costed_pct_bp?: number | null
  counts_by_class?: MenuClassCountsOut
  /** Productos vendidos fuera del análisis (cargos como el de domicilio, comida de personal). */
  excluded_products?: number
}

export interface MenuEngineeringQuery extends PeriodQuery {
  categoryId?: number | null
  minUnits?: number | null
}

export function getMenuEngineering(params: MenuEngineeringQuery): Promise<MenuEngineeringOut> {
  return api<MenuEngineeringOut>("/admin/menu-engineering", {
    query: {
      store_id: params.storeId,
      from: params.from,
      to: params.to,
      category_id: params.categoryId ?? undefined,
      min_units: params.minUnits ?? undefined,
    },
  })
}

// ---------------------------------------------------------------------------
// GET /admin/variance/by-dish — SÓLO estimación prorrateada (§5.4):
// `method: "prorated"` explícito, mostrado en pantalla, no sólo en la
// respuesta. Rango real: por `count_id` (la ventana entre dos conteos
// aplicados), no por `from`/`to` — ver `getVarianceByDish`.
// ---------------------------------------------------------------------------

export interface VarianceByDishRowOut {
  product_id: number
  product_name?: string | null
  /** Peso del plato en el costo teórico consumido (pesos, homogéneo entre insumos) de los insumos con varianza, bp. */
  theoretical_consumption_share_bp?: number | null
  /** Valor de la varianza PRORRATEADA sobre este plato, en pesos (signo: positivo = se usó más de lo esperado). */
  variance_value?: number | null
  ingredients_involved?: number | null
  /** `"shortage"` (faltante, positivo) o `"surplus"` (sobrante, negativo). */
  direction?: "shortage" | "surplus"
}

export interface VarianceByDishOut {
  store_id?: number
  count_id?: number
  /** Fijo por contrato: `"prorated"`. Esta pantalla lo muestra tal cual, nunca lo asume. */
  method: "prorated" | string
  available: boolean
  reason: string | null
  opening_count_id?: number | null
  window_from?: string | null
  window_to?: string | null
  total_variance_value?: number | null
  /** Varianza que no se pudo atribuir a ningún plato (`0` cuando se repartió todo). */
  unattributed_variance_value?: number | null
  /** Faltantes primero, cada grupo por |valor| desc. */
  rows?: VarianceByDishRowOut[]
  /** Horas y días completos de la ventana; `null` sin ventana. */
  window_hours?: number | null
  window_days?: number | null
  /** Comandas cobradas en la ventana; `null` sin ventana. */
  sales_in_window?: number | null
  /** `true` con ventana < `min_window_days` o < `min_sales_in_window` comandas: mostrar en gris con el motivo. */
  insufficient_sample?: boolean
  insufficient_sample_reason?: string | null
  min_window_days?: number
  min_sales_in_window?: number
}

/** El período real de esta ruta es una VENTANA de conteo (`count_id`
 * opcional: el más reciente si se omite), no un `from`/`to` de fecha de
 * negocio como el resto del contrato — verificado contra
 * `app/analytics/schemas.py::VarianceByDishOut`. Se conserva `PeriodQuery`
 * como firma pública por uniformidad con el resto de este archivo, pero
 * `from`/`to` NO se mandan: es el contrato (H-3, iteración 2, decisión del
 * Maestro: se movió `backend-analitica`, que ya resuelve el `count_id` del
 * último conteo aplicado cuando se omite — `app/analytics/router.py::
 * get_variance_by_dish` — y devuelve `available: false` + `reason` cuando
 * no hay ninguno). Dejó de ser un gap declarado: mandar `from`/`to` acá
 * sería el error, no omitirlos. */
export function getVarianceByDish(params: { storeId: number }): Promise<VarianceByDishOut> {
  return api<VarianceByDishOut>("/admin/variance/by-dish", { query: { store_id: params.storeId } })
}

// ---------------------------------------------------------------------------
// GET /admin/control-health/sustained — D-1: la brecha de food cost real
// está sostenida en rojo en al menos 2 de las últimas 3 ventanas.
// ---------------------------------------------------------------------------

export interface SustainedWindowOut {
  window_index: number
  window_from?: string
  window_to?: string
  real_pct_bp?: number
  /** Teórico ESCALADO a la cobertura de fichas (costo ÷ ventas de lo costeado). */
  theoretical_pct_bp?: number
  gap_bp?: number
  exceeds_red?: boolean
  window_hours?: number
  window_days?: number
  orders_in_window?: number
  /** Parte de las ventas netas de la ventana con ficha con costo, bp. */
  costed_pct_bp?: number
}

export interface SustainedHealthOut {
  store_id?: number
  /** `null` con `reason` cuando hay menos de 2 ventanas computables — nunca "verde" por defecto. */
  sustained_red: boolean | null
  windows_evaluated: number
  reason: string | null
  red_threshold_bp?: number
  windows?: SustainedWindowOut[]
  /** Reglas para que una ventana cuente: días mínimos y cobertura mínima (bp). */
  min_window_days?: number
  min_costed_pct_bp?: number
  /** Ventanas entre conteos saltadas por esas reglas. */
  windows_skipped?: number
}

export function getControlHealthSustained(storeId: number): Promise<SustainedHealthOut> {
  return api<SustainedHealthOut>("/admin/control-health/sustained", { query: { store_id: storeId } })
}

// ---------------------------------------------------------------------------
// GET /admin/replenishment — reposición sugerida por insumo (consumo × lead
// time del proveedor).
// ---------------------------------------------------------------------------

export interface ReplenishmentRowOut {
  ingredient_id: number
  ingredient_name?: string | null
  /** Unidad base del insumo («g», «ml», «unidad»): la manda el backend. */
  base_unit?: string | null
  current_stock?: string | null
  min_stock?: string | null
  /** Promedio diario sobre `history_days` (no 30 fijos). */
  avg_daily_consumption?: string | null
  /** Mediana diaria sobre los mismos días (un día sin consumo cuenta 0). */
  median_daily_consumption?: string | null
  /** Días de negocio con historial usados (desde el primer movimiento o el inicio de la ventana, hasta hoy). */
  history_days?: number
  /** Texto decimal (mismo criterio que `qty_base`) — nunca se reescala acá. SIEMPRE calculable, nunca `null`. */
  suggested_qty?: string | null
  /** `null` con `reason` sin `lead_time_days` configurado o sin consumo registrado. */
  suggested_min?: string | null
  lead_time_days?: number | null
  based_on?: string | null
  reason?: string | null
}

export interface ReplenishmentOut {
  store_id?: number
  available: boolean
  reason: string | null
  lookback_days?: number
  rows?: ReplenishmentRowOut[]
}

export function getReplenishment(storeId: number): Promise<ReplenishmentOut> {
  return api<ReplenishmentOut>("/admin/replenishment", { query: { store_id: storeId } })
}
