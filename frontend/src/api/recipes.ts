/**
 * Fichas técnicas, preparaciones y `recipe_effect` de modificadores
 * (`features/fase-2-costo-inventario/spec.md § API contract`, dominio
 * `app.recipes` del backend). Mismas convenciones que `api/catalog.ts`: todo
 * campo que el backend pueda agregar más adelante es opcional acá.
 *
 * Cantidades **nunca** viajan como número JSON: siempre `string` decimal
 * (`"18.5"`), tal como las exige `app.recipes.units`/`app.core.quantity` en
 * el borde. Costos (`unit_cost`, `total_cost`, `theoretical_cost`) viajan
 * igual: `string` decimal en pesos con precisión completa (no entero — un
 * costo por gramo real como $0,003/g redondeado a peso publicaría `0` con
 * origen `official`, el cero mudo que la spec prohíbe), o `null` con su
 * `cost_source`. Este archivo no calcula nada, sólo tipa y transporta.
 */

import { api } from "@/api/client"

export type PrepMode = "batch" | "exploded"
export type RecipeEffectType = "add" | "remove" | "replace"
export type CostSource = "official" | "weighted_average" | "last_purchase" | "estimated" | "none"
/** Unidades de entrada de una línea (`app.recipes.units.INPUT_UNIT_VALUES`):
 * conversión métrica exacta contra la unidad base del componente, o
 * `400 UNIT_MISMATCH` si no corresponde — nunca una adivinanza. */
export type LineUnit = "g" | "kg" | "ml" | "l" | "unit"
/** Unidad base de un insumo o el rendimiento estándar de una preparación. */
export type BaseUnit = "g" | "ml" | "unit"

// ---------------------------------------------------------------------------
// Líneas compartidas (insumo XOR preparación).
// ---------------------------------------------------------------------------

export interface ComponentLineIn {
  ingredient_id?: number | null
  preparation_id?: number | null
  qty: string
  unit: string
}

export interface ComponentLineOut {
  ingredient_id: number | null
  ingredient_name: string | null
  preparation_id: number | null
  preparation_name: string | null
  qty: string
  unit: string
}

// ---------------------------------------------------------------------------
// Preparaciones — admin.
// ---------------------------------------------------------------------------

export interface PreparationIn {
  name: string
  mode: PrepMode
  standard_yield_qty: string
  standard_yield_unit: BaseUnit
  process_loss_pct?: number
  shelf_life_days?: number | null
  lines: ComponentLineIn[]
}

/** Sin `mode`: cambiar de modo es sólo `PATCH .../mode` con PIN de admin
 * (spec § 4.2) — nunca un campo más de una edición común. */
export interface PreparationUpdateIn {
  name?: string
  standard_yield_qty?: string
  standard_yield_unit?: BaseUnit
  process_loss_pct?: number
  shelf_life_days?: number | null
  lines?: ComponentLineIn[]
  active?: boolean
}

export interface PreparationModeIn {
  mode: PrepMode
  authorizer_pin?: string | null
}

export interface PreparationAdminOut {
  id: number
  name: string
  mode: PrepMode
  standard_yield_qty: string
  standard_yield_unit: string
  process_loss_pct: number
  shelf_life_days: number | null
  active: boolean
  /** Sólo tiene sentido en modo `batch`; `null` en `exploded` (sin stock ni lotes). */
  current_stock: string | null
  /** Decimal serializado como texto en pesos, con precisión completa (no
   * entero): un costo por gramo real como $0,003/g redondeado a peso
   * publicaría `0` con origen `official` — el mismo cero mudo que la spec
   * prohíbe. Mismo formato que `inventory` (ronda 2 del contrato). */
  unit_cost: string | null
  cost_source: CostSource
  lines: ComponentLineOut[]
}

// ---------------------------------------------------------------------------
// Preparaciones — dispositivo (producción rápida). SIN ningún campo de costo.
// ---------------------------------------------------------------------------

export interface PreparationDeviceOut {
  id: number
  name: string
  mode: PrepMode
  /** = `standard_yield_qty`, precargada en la pantalla de producción. */
  prefilled_qty: string
  standard_yield_unit: string
  shelf_life_days: number | null
}

export interface ProduceIn {
  qty_expected: string
  qty_real: string
  employee_pin: string
  note?: string | null
}

export interface ProduceOut {
  id: number
  preparation_id: number
  qty_expected: string
  qty_real: string
  unit: string
  variance_pct: string
  variance_alert: boolean
  expiry_date: string | null
  produced_at: string
}

export interface PrepBatchAdminOut {
  id: number
  preparation_id: number
  qty_expected: string
  qty_real: string
  unit: string
  variance_pct: string
  variance_alert: boolean
  /** Decimal serializado como texto en pesos, precisión completa (ver
   * `PreparationAdminOut.unit_cost`). */
  total_cost: string | null
  unit_cost: string | null
  cost_source: CostSource
  expiry_date: string | null
  produced_by_employee_id: number
  produced_by_employee_name: string
  produced_at: string
  note: string | null
  closed_at: string | null
  closed_reason: string | null
}

// ---------------------------------------------------------------------------
// Ficha técnica del plato (versionada).
// ---------------------------------------------------------------------------

export interface ProductRecipeIn {
  /** Versión que el cliente cree vigente (bloqueo optimista) — `0` para la
   * primera ficha de un producto que todavía no tiene ninguna. */
  version: number
  lines: ComponentLineIn[]
}

export interface ProductRecipeOut {
  product_id: number
  version: number
  /** Decimal serializado como texto en pesos, precisión completa (ver
   * `PreparationAdminOut.unit_cost`). */
  theoretical_cost: string | null
  cost_source: CostSource
  /** Decimal serializado como texto (p. ej. `"28.57"`); `null` sin ficha o sin costo. */
  food_cost_pct: string | null
  net_price: number
  lines: ComponentLineOut[]
}

// ---------------------------------------------------------------------------
// `recipe_effect` de las opciones de modificador.
// ---------------------------------------------------------------------------

export interface RecipeEffectLineIn extends ComponentLineIn {
  replaces_ingredient_id?: number | null
  replaces_preparation_id?: number | null
}

export interface RecipeEffectIn {
  effect: RecipeEffectType
  lines: RecipeEffectLineIn[]
}

export interface RecipeEffectLineOut extends ComponentLineOut {
  replaces_ingredient_id: number | null
  replaces_preparation_id: number | null
}

export interface RecipeEffectOut {
  modifier_option_id: number
  effect: RecipeEffectType
  lines: RecipeEffectLineOut[]
}

// ---------------------------------------------------------------------------
// Validaciones y cobertura.
// ---------------------------------------------------------------------------

export interface CoverageItemOut {
  product_id: number
  product_name: string | null
  items_sold: number
  qty_sold: number
}

export interface SuspiciousLineOut {
  product_id: number
  product_name: string | null
  ingredient_id: number
  ingredient_name: string | null
  qty: string
  unit: string
  reason: string
}

// ---------------------------------------------------------------------------
// Insumos, sólo para los selectores de línea (endpoint de `inventory`, otro
// territorio — acá se tipa nada más el recorte que estas pantallas
// necesitan; `IngredientOut` completo, con costo y umbrales, es de quien
// construya `src/features/inventory/**`).
// ---------------------------------------------------------------------------

export interface IngredientOption {
  id: number
  name: string
  base_unit: BaseUnit
  category?: string | null
  active?: boolean
}

export function listIngredientOptions(storeId: number): Promise<IngredientOption[]> {
  return api<IngredientOption[]>("/admin/ingredients", {
    query: { store_id: storeId, active_only: true },
  })
}

// ---------------------------------------------------------------------------
// Admin: preparaciones.
// ---------------------------------------------------------------------------

export function listPreparations(
  storeId: number,
  params?: { activeOnly?: boolean }
): Promise<PreparationAdminOut[]> {
  return api<PreparationAdminOut[]>("/admin/preparations", {
    query: { store_id: storeId, active_only: params?.activeOnly },
  })
}

export function createPreparation(storeId: number, data: PreparationIn): Promise<PreparationAdminOut> {
  return api<PreparationAdminOut>("/admin/preparations", {
    method: "POST",
    query: { store_id: storeId },
    body: data,
  })
}

export function updatePreparation(
  preparationId: number,
  data: PreparationUpdateIn
): Promise<PreparationAdminOut> {
  return api<PreparationAdminOut>(`/admin/preparations/${preparationId}`, { method: "PATCH", body: data })
}

export function switchPreparationMode(
  preparationId: number,
  data: PreparationModeIn
): Promise<PreparationAdminOut> {
  return api<PreparationAdminOut>(`/admin/preparations/${preparationId}/mode`, {
    method: "PATCH",
    body: data,
  })
}

export function listPrepBatches(preparationId: number): Promise<PrepBatchAdminOut[]> {
  return api<PrepBatchAdminOut[]>(`/admin/preparations/${preparationId}/batches`)
}

/** URL directa (con `format=csv`) — mismo patrón que `adminOrdersCsvUrl`. */
export function preparationsCsvUrl(params: { storeId: number; activeOnly?: boolean }): string {
  const query = new URLSearchParams()
  query.set("format", "csv")
  query.set("store_id", String(params.storeId))
  if (params.activeOnly !== undefined) query.set("active_only", String(params.activeOnly))
  return `/api/v1/admin/preparations?${query.toString()}`
}

export function prepBatchesCsvUrl(preparationId: number): string {
  return `/api/v1/admin/preparations/${preparationId}/batches?format=csv`
}

// ---------------------------------------------------------------------------
// Dispositivo: producción rápida (POS/cocina, dos toques).
// ---------------------------------------------------------------------------

export function listDevicePreparations(): Promise<PreparationDeviceOut[]> {
  return api<PreparationDeviceOut[]>("/preparations")
}

export function producePreparation(
  preparationId: number,
  data: ProduceIn,
  idempotencyKey: string
): Promise<ProduceOut> {
  return api<ProduceOut>(`/preparations/${preparationId}/produce`, {
    method: "POST",
    body: data,
    idempotencyKey,
  })
}

// ---------------------------------------------------------------------------
// Ficha técnica del plato.
// ---------------------------------------------------------------------------

export function getProductRecipe(productId: number): Promise<ProductRecipeOut> {
  return api<ProductRecipeOut>(`/admin/products/${productId}/recipe`)
}

export function putProductRecipe(productId: number, data: ProductRecipeIn): Promise<ProductRecipeOut> {
  return api<ProductRecipeOut>(`/admin/products/${productId}/recipe`, { method: "PUT", body: data })
}

// ---------------------------------------------------------------------------
// `recipe_effect` de las opciones de modificador.
// ---------------------------------------------------------------------------

export function putModifierOptionRecipeEffect(
  optionId: number,
  data: RecipeEffectIn
): Promise<RecipeEffectOut> {
  return api<RecipeEffectOut>(`/admin/modifier-options/${optionId}/recipe-effect`, {
    method: "PUT",
    body: data,
  })
}

// ---------------------------------------------------------------------------
// Cobertura y unidades sospechosas.
// ---------------------------------------------------------------------------

export function getRecipeCoverage(
  storeId: number,
  params?: { dateFrom?: string; dateTo?: string }
): Promise<CoverageItemOut[]> {
  return api<CoverageItemOut[]>("/admin/recipes/coverage", {
    query: { store_id: storeId, date_from: params?.dateFrom, date_to: params?.dateTo },
  })
}

/** Ojo: acá el contrato usa `date_from`/`date_to`, no `from`/`to` como el
 * resto de los reportes admin — así lo declara `app.recipes.router`. */
export function recipeCoverageCsvUrl(params: { storeId: number; dateFrom?: string; dateTo?: string }): string {
  const query = new URLSearchParams()
  query.set("format", "csv")
  query.set("store_id", String(params.storeId))
  if (params.dateFrom) query.set("date_from", params.dateFrom)
  if (params.dateTo) query.set("date_to", params.dateTo)
  return `/api/v1/admin/recipes/coverage?${query.toString()}`
}

export function getSuspiciousUnits(storeId: number): Promise<SuspiciousLineOut[]> {
  return api<SuspiciousLineOut[]>("/admin/recipes/suspicious-units", { query: { store_id: storeId } })
}

export function suspiciousUnitsCsvUrl(storeId: number): string {
  const query = new URLSearchParams()
  query.set("format", "csv")
  query.set("store_id", String(storeId))
  return `/api/v1/admin/recipes/suspicious-units?${query.toString()}`
}
