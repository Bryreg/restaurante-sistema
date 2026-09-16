/**
 * Insumos, stock teórico, libro de movimientos, ajustes manuales y mermas
 * (`features/fase-2-costo-inventario/spec.md § API contract`, dominio
 * `app.inventory` del backend — tipado contra `backend/app/inventory/
 * schemas.py` y `router.py`, ya escritos cuando este archivo se creó).
 *
 * Mismas convenciones que `api/recipes.ts`: las cantidades de insumo NUNCA
 * viajan como número JSON, siempre `string` decimal (`"18.5"`) — el backend
 * las guarda en enteros sobre una unidad base y rechaza `float`. Los costos
 * ya vienen resueltos a pesos (string decimal) con su `cost_source`; este
 * archivo no calcula nada, sólo tipa y transporta.
 *
 * `Ingredient` es dato maestro (igual que `Category`/`Product` de
 * `catalog`): `GET/POST/PATCH/DELETE /admin/ingredients*` no exige ninguna
 * función encendida — `catalog.recipes` (territorio ajeno) necesita poder
 * leerlos aunque `inventory.perpetual` esté apagada. Lo que SÍ exige función
 * son movimientos, stock, ajustes (`inventory.perpetual`) y mermas
 * (`inventory.waste`) — el backend corta con `400 FEATURE_DISABLED` antes de
 * ejecutar nada; este archivo nunca reemplaza ese gate, sólo lo refleja.
 */

import { api } from "@/api/client"

export type BaseUnit = "g" | "ml" | "unit"
export type CostSource = "official" | "weighted_average" | "last_purchase" | "estimated" | "none"

/** `app.inventory.models.MovementCause` — enum cerrado, nunca texto libre.
 * Los últimos cuatro ya están en el enum del backend pero son de 2b
 * (compras, conteos, traslados): se incluyen acá para que el filtro de
 * causa sea la MISMA lista cerrada que acepta el servidor, aunque hoy no
 * los produzca ningún flujo de 2a. */
export type MovementCause =
  | "sale"
  | "production_in"
  | "production_out"
  | "void_after_send"
  | "waste"
  | "note_return"
  | "manual_adjustment"
  | "purchase"
  | "count_adjustment"
  | "transfer_in"
  | "transfer_out"

/** `app.inventory.models.WasteType`. No existe `staff_meal` acá — eso es un
 * canal de comanda, nunca un tipo de merma (SPEC-NEGOCIO §5.5). */
export type WasteType =
  | "expired"
  | "overproduction"
  | "kitchen_error"
  | "breakage"
  | "customer_return"
  | "tasting"
  | "courtesy_no_dish"
  | "unidentified"

// ---------------------------------------------------------------------------
// Insumos (admin).
// ---------------------------------------------------------------------------

export interface IngredientIn {
  name: string
  category?: string | null
  base_unit: BaseUnit
  purchase_unit: string
  purchase_factor: number
  /** Default 100 en el servidor si se omite; este cliente siempre lo manda explícito. */
  yield_pct: number
  official_cost?: string | null
  estimated_cost?: string | null
  /** Obligatorio y `> 0` — el servidor corta con `400 MIN_STOCK_REQUIRED` si no. */
  min_stock: string
  lead_time_days?: number | null
  perishable: boolean
  key_item: boolean
  consumption_untracked: boolean
  substitute_ingredient_id?: number | null
  supplier_id?: number | null
  active: boolean
}

export interface IngredientUpdateIn {
  name?: string
  category?: string | null
  base_unit?: BaseUnit
  purchase_unit?: string
  purchase_factor?: number
  yield_pct?: number
  official_cost?: string | null
  clear_official_cost?: boolean
  estimated_cost?: string | null
  clear_estimated_cost?: boolean
  min_stock?: string
  lead_time_days?: number | null
  perishable?: boolean
  key_item?: boolean
  consumption_untracked?: boolean
  substitute_ingredient_id?: number | null
  clear_substitute?: boolean
  supplier_id?: number | null
  active?: boolean
}

export interface IngredientOut {
  id: number
  name: string
  category: string | null
  base_unit: BaseUnit
  purchase_unit: string
  purchase_factor: number
  yield_pct: number
  official_cost: string | null
  estimated_cost: string | null
  /** Costo resuelto (jerarquía `official > estimated > none` en 2a). */
  cost: string | null
  cost_source: CostSource
  min_stock: string
  lead_time_days: number | null
  perishable: boolean
  key_item: boolean
  consumption_untracked: boolean
  substitute_ingredient_id: number | null
  supplier_id: number | null
  active: boolean
}

export function listIngredients(
  storeId: number,
  params: { activeOnly?: boolean } = {},
): Promise<IngredientOut[]> {
  return api<IngredientOut[]>("/admin/ingredients", {
    query: { store_id: storeId, active_only: params.activeOnly },
  })
}

export function ingredientsCsvUrl(params: { storeId: number; activeOnly?: boolean }): string {
  const query = new URLSearchParams()
  query.set("format", "csv")
  query.set("store_id", String(params.storeId))
  if (params.activeOnly !== undefined) query.set("active_only", String(params.activeOnly))
  return `/api/v1/admin/ingredients?${query.toString()}`
}

export function createIngredient(storeId: number, data: IngredientIn): Promise<IngredientOut> {
  return api<IngredientOut>("/admin/ingredients", { method: "POST", query: { store_id: storeId }, body: data })
}

export function updateIngredient(ingredientId: number, data: IngredientUpdateIn): Promise<IngredientOut> {
  return api<IngredientOut>(`/admin/ingredients/${ingredientId}`, { method: "PATCH", body: data })
}

/** Baja lógica (`DELETE` = `active: false` en el servidor), nunca un borrado de fila. */
export function deactivateIngredient(ingredientId: number): Promise<IngredientOut> {
  return api<IngredientOut>(`/admin/ingredients/${ingredientId}`, { method: "DELETE" })
}

// ---------------------------------------------------------------------------
// Libro de movimientos (por insumo).
// ---------------------------------------------------------------------------

export interface StockMovementOut {
  id: number
  ingredient_id: number | null
  preparation_id: number | null
  qty_base: string
  cause: MovementCause
  cost: string | null
  cost_source: CostSource
  employee_id: number
  employee_name: string
  at: string
  business_date: string
  ref_type: string | null
  ref_id: number | null
  note: string | null
}

export interface MovementsQuery {
  ingredientId: number
  from?: string
  to?: string
  cause?: MovementCause
}

export function getIngredientMovements(params: MovementsQuery): Promise<StockMovementOut[]> {
  return api<StockMovementOut[]>(`/admin/ingredients/${params.ingredientId}/movements`, {
    query: { from: params.from, to: params.to, cause: params.cause },
  })
}

export function ingredientMovementsCsvUrl(params: MovementsQuery): string {
  const query = new URLSearchParams()
  query.set("format", "csv")
  if (params.from) query.set("from", params.from)
  if (params.to) query.set("to", params.to)
  if (params.cause) query.set("cause", params.cause)
  return `/api/v1/admin/ingredients/${params.ingredientId}/movements?${query.toString()}`
}

// ---------------------------------------------------------------------------
// Stock teórico.
// ---------------------------------------------------------------------------

export interface StockRowOut {
  ingredient_id: number
  name: string
  base_unit: BaseUnit
  qty_base: string
  min_stock: string
  below_min: boolean
  /** `qty_base < 0`. Deuda de registro — NUNCA se lee como "agotado" (SPEC-NEGOCIO §5.2). */
  negative: boolean
  negative_since: string | null
  cost: string | null
  cost_source: CostSource
  key_item: boolean
}

export interface StockQuery {
  storeId: number
  criticalOnly?: boolean
  belowMin?: boolean
  negative?: boolean
}

export function getInventoryStock(params: StockQuery): Promise<StockRowOut[]> {
  return api<StockRowOut[]>("/admin/inventory/stock", {
    query: {
      store_id: params.storeId,
      critical_only: params.criticalOnly,
      below_min: params.belowMin,
      negative: params.negative,
    },
  })
}

export function inventoryStockCsvUrl(params: StockQuery): string {
  const query = new URLSearchParams()
  query.set("format", "csv")
  query.set("store_id", String(params.storeId))
  if (params.criticalOnly) query.set("critical_only", "true")
  if (params.belowMin) query.set("below_min", "true")
  if (params.negative) query.set("negative", "true")
  return `/api/v1/admin/inventory/stock?${query.toString()}`
}

// ---------------------------------------------------------------------------
// Ajustes manuales.
// ---------------------------------------------------------------------------

export interface AdjustmentIn {
  ingredient_id: number
  /** Decimal con signo: positivo entra, negativo sale. */
  qty_delta: string
  reason: string
  authorizer_pin: string
}

export interface AdjustmentOut {
  id: number
  ingredient_id: number
  qty_delta: string
  reason: string
  employee_id: number
  employee_name: string
  at: string
}

export function postInventoryAdjustment(
  storeId: number,
  data: AdjustmentIn,
  idempotencyKey: string,
): Promise<AdjustmentOut> {
  return api<AdjustmentOut>("/admin/inventory/adjustments", {
    method: "POST",
    query: { store_id: storeId },
    body: data,
    idempotencyKey,
  })
}

// ---------------------------------------------------------------------------
// Mermas.
// ---------------------------------------------------------------------------

export interface WasteIn {
  ingredient_id?: number | null
  preparation_id?: number | null
  qty: string
  type: WasteType
  note?: string | null
  employee_pin: string
  photo?: string | null
}

/** Salida de `POST /waste` (dispositivo): SIN `cost` ni `cost_source` a
 * propósito — el operador no recibe costos (AGENTS.md). El admin lo lee en
 * `WasteAdminOut` (`GET /admin/waste`). */
export interface WasteOut {
  id: number
  ingredient_id: number | null
  preparation_id: number | null
  qty: string
  type: WasteType
  employee_id: number
  employee_name: string
  at: string
}

export interface WasteAdminOut extends WasteOut {
  cost: string | null
  cost_source: CostSource
  note: string | null
  photo: string | null
}

/** Mermas ÷ compras semanal. `null` con `label="sin datos"` hasta 2b (no hay
 * compras todavía) — nunca `0`, que mentiría "no hay merma". */
export interface WasteKpiOut {
  ratio: number | null
  label: string
}

export interface WasteListOut {
  items: WasteAdminOut[]
  weekly_kpi: WasteKpiOut
}

export function postWaste(data: WasteIn, idempotencyKey: string): Promise<WasteOut> {
  return api<WasteOut>("/waste", { method: "POST", body: data, idempotencyKey })
}

export interface WasteQuery {
  storeId: number
  from?: string
  to?: string
  type?: WasteType
  employeeId?: number | null
}

export function getWasteList(params: WasteQuery): Promise<WasteListOut> {
  return api<WasteListOut>("/admin/waste", {
    query: {
      store_id: params.storeId,
      from: params.from,
      to: params.to,
      type: params.type,
      employee_id: params.employeeId,
    },
  })
}

export function wasteCsvUrl(params: WasteQuery): string {
  const query = new URLSearchParams()
  query.set("format", "csv")
  query.set("store_id", String(params.storeId))
  if (params.from) query.set("from", params.from)
  if (params.to) query.set("to", params.to)
  if (params.type) query.set("type", params.type)
  if (params.employeeId !== undefined && params.employeeId !== null) {
    query.set("employee_id", String(params.employeeId))
  }
  return `/api/v1/admin/waste?${query.toString()}`
}

// ---------------------------------------------------------------------------
// Dispositivo: sin ningún campo de costo (AGENTS.md).
// ---------------------------------------------------------------------------

export interface DeviceIngredientOut {
  id: number
  name: string
  base_unit: BaseUnit
}

export function listDeviceIngredients(): Promise<DeviceIngredientOut[]> {
  return api<DeviceIngredientOut[]>("/device/ingredients")
}
