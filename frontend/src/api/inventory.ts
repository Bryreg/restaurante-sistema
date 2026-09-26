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

/** Espejo EXACTO de `app/inventory/schemas.py::MovementCauseLiteral` — enum
 * cerrado, nunca texto libre. Ese `Literal` es el que tipa
 * `StockMovementOut.cause` **y** el que valida el query `?cause=` de
 * `GET /admin/ingredients/{id}/movements`, así que la igualdad tiene que ser
 * exacta en las dos direcciones, y hay un invariante que la cobra
 * (`src/audit/purchases-counts.test.ts`).
 *
 * Las dos direcciones se rompieron una vez cada una en este pedido, con
 * dueños distintos y sin que el typecheck viera ninguna: el backend AGREGÓ
 * `reception_reversal` y el cliente no tenía etiqueta (un `500` al leer el
 * libro de un insumo con una recepción reversada), y el backend QUITÓ
 * `void_after_send` —nunca llegó a producirse— mientras el cliente seguía
 * ofreciéndola en el desplegable del filtro, que devolvía `422`. Un filtro
 * que siempre falla es peor que no tener el filtro. */
export type MovementCause =
  | "sale"
  | "production_in"
  | "production_out"
  | "waste"
  | "note_return"
  | "manual_adjustment"
  | "purchase"
  | "count_adjustment"
  | "reception_reversal"
  | "transfer_in"
  | "transfer_out"

/** `app.inventory.models.WasteType`. No existe `staff_meal` acá — eso es un
 * canal de comanda, nunca un tipo de merma (SPEC-NEGOCIO §5.5).
 * `internal_use` (consumo interno: pide quién) y `transfer_out` (traslado a
 * otra sede: pide la sede destino) son salidas EXPLICADAS, no pérdida: el
 * backend no las suma en ningún indicador de merma. */
export type WasteType =
  | "expired"
  | "overproduction"
  | "kitchen_error"
  | "breakage"
  | "customer_return"
  | "tasting"
  | "courtesy_no_dish"
  | "unidentified"
  | "internal_use"
  | "transfer_out"

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
  /**
   * La unidad en que viene `qty` (`entry_unit` del insumo); el servidor
   * convierte a la unidad base. Sin ella, `qty` va en unidad base.
   */
  entry_unit?: string
  type: WasteType
  note?: string | null
  employee_pin: string
  photo?: string | null
  /** Consumo interno: quién — un empleado o un texto («dueño»). */
  consumer_employee_id?: number | null
  consumer_name?: string | null
  /** Traslado: la sede destino, de la misma organización. */
  destination_store_id?: number | null
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
  consumer_employee_id: number | null
  consumer_name: string | null
  destination_store_id: number | null
}

export interface WasteAdminOut extends WasteOut {
  cost: string | null
  cost_source: CostSource
  note: string | null
  photo: string | null
  /** Traslado: `null` = todavía en camino (o no es un traslado). */
  received_at: string | null
  received_by_employee_name: string | null
}

/** Mermas ÷ compras semanal. `ratio` es el único número no entero de toda la
 * fase 2 — **2b lo cierra** (deuda declarada en `outputs-2a/ENTREGA.md §5`,
 * O-6): entero en puntos básicos reales (100 = 1 %, mismo `ratio` en
 * `app.inventory.schemas.WasteKpiOut.ratio: int | None`), nunca `float`.
 * `null` con `label` legible cuando no hay compras en la semana (mermas ÷ 0
 * no es `0`, es "sin datos"); deja de ser `null` en cuanto hay al menos una
 * compra (`cause=purchase`) en el rango. Formatear con
 * `formatBasisPoints` (`features/inventory/lib.ts`), nunca `ratio * 100`
 * a mano (esa cuenta era correcta cuando `ratio` era una fracción 0..1 en
 * 2a; con la escala en puntos básicos de 2b da cien veces más). */
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
// Traslados entre sedes (merma `transfer_out` y su recepción).
// ---------------------------------------------------------------------------

export interface TransferStoreOut {
  id: number
  name: string
}

/** Las otras sedes de la organización (dispositivo). Vacía = una sola sede:
 * el formulario de merma no ofrece «Traslado a otra sede». */
export function listTransferStores(): Promise<TransferStoreOut[]> {
  return api<TransferStoreOut[]>("/device/waste/transfer-stores")
}

/** Un traslado que llega a esta sede (admin). `cost` es el costo por unidad
 * base con que salió y con el que entra (texto; `null` = sin costo, nunca
 * `0`). `suggested_ingredient_id` lo propone el servidor. */
export interface IncomingTransferOut {
  id: number
  source_store_id: number
  source_store_name: string
  ingredient_id: number
  ingredient_name: string
  base_unit: BaseUnit
  qty: string
  cost: string | null
  cost_source: CostSource
  sent_at: string
  sent_by_employee_name: string
  note: string | null
  photo: string | null
  suggested_ingredient_id: number | null
  received_at: string | null
  received_ingredient_id: number | null
  received_by_employee_name: string | null
}

export function getIncomingTransfers(storeId: number, status: "pending" | "all" = "pending"): Promise<IncomingTransferOut[]> {
  return api<IncomingTransferOut[]>("/admin/transfers/incoming", { query: { store_id: storeId, status } })
}

export function receiveTransfer(
  storeId: number,
  transferId: number,
  ingredientId: number,
  idempotencyKey: string,
): Promise<IncomingTransferOut> {
  return api<IncomingTransferOut>(`/admin/transfers/${transferId}/receive`, {
    method: "POST",
    query: { store_id: storeId },
    body: { ingredient_id: ingredientId },
    idempotencyKey,
  })
}

// ---------------------------------------------------------------------------
// Dispositivo: sin ningún campo de costo (AGENTS.md).
// ---------------------------------------------------------------------------

export interface DeviceIngredientOut {
  id: number
  name: string
  base_unit: BaseUnit
  /** La unidad cómoda en que se teclea (la misma del conteo corto por área). */
  entry_mode: "weight" | "bottle" | "volume" | "unit"
  /** «kg», «L», «unidad» o la unidad de compra («botella», «garrafa»). */
  entry_unit: string
}

export function listDeviceIngredients(): Promise<DeviceIngredientOut[]> {
  return api<DeviceIngredientOut[]>("/device/ingredients")
}

// ---------------------------------------------------------------------------
// Umbrales de varianza (configuración de sede; pedido 2b, `inventory.
// variance`). `GET/PUT /admin/stores/{id}/inventory-settings` vive en
// `app.inventory` en el backend (decisión de arquitectura de ese dominio,
// no de `app.stores`), aunque la pantalla que lo edita esté en
// `features/settings/**` (huérfano nombrado con dueño — ver
// `features/fase-2-costo-inventario/spec.md`). Enteros en puntos básicos
// REALES (100 = 1 %, `backend/app/inventory/models.py::
// StoreInventorySettings`): SPEC-NEGOCIO §5.4 los llama "puntos" (< 2 verde,
// 2–4 revisar, > 4–5 rojo sostenido) sobre la MISMA escala que
// `VarianceRowOut.variance_pct_bp` — nunca `float` (AGENTS.md).
// ---------------------------------------------------------------------------

export interface InventorySettingsIn {
  variance_yellow_threshold_bp: number
  variance_red_threshold_bp: number
}

export interface InventorySettingsOut extends InventorySettingsIn {
  store_id: number
}

export function getInventorySettings(storeId: number): Promise<InventorySettingsOut> {
  return api<InventorySettingsOut>(`/admin/stores/${storeId}/inventory-settings`)
}

export function putInventorySettings(storeId: number, data: InventorySettingsIn): Promise<InventorySettingsOut> {
  return api<InventorySettingsOut>(`/admin/stores/${storeId}/inventory-settings`, { method: "PUT", body: data })
}

// ---------------------------------------------------------------------------
// Lotes y vencimientos (pedido 2b, `inventory.lots`, SPEC-NEGOCIO §5.7).
// ---------------------------------------------------------------------------

export type LotStatus = "active" | "expiring" | "expired" | "depleted"

export interface LotOut {
  id: number
  ingredient_id: number
  ingredient_name: string
  lot_code: string | null
  qty_received: string
  qty_remaining: string
  unit_cost: string
  cost_source: CostSource
  /** Fecha ISO (`date`), o `null` == nunca vence. */
  expires_at: string | null
  received_at: string
  status: LotStatus
  source_type: string
  source_id: number
}

export interface LotsQuery {
  storeId: number
  ingredientId?: number | null
  status?: LotStatus
  expiringWithinDays?: number | null
}

/**
 * GAP de contrato declarado (§8 del entregable): `GET /admin/lots`
 * (`backend/app/inventory/router.py::get_lots`) devuelve `list[LotOut]`
 * directo — sin `Request` ni `wants_csv`/`csv_response` — así que **no
 * soporta `format=csv`** aunque SPEC-NEGOCIO §9.3 pide "toda lista exporta".
 * A propósito NO hay `lotsCsvUrl` acá: agregar el botón igual descargaría un
 * archivo `.csv` con JSON adentro, roto en silencio — peor que no tenerlo.
 */
export function getLots(params: LotsQuery): Promise<LotOut[]> {
  return api<LotOut[]>("/admin/lots", {
    query: {
      store_id: params.storeId,
      ingredient_id: params.ingredientId,
      status: params.status,
      expiring_within_days: params.expiringWithinDays,
    },
  })
}

// ---------------------------------------------------------------------------
// Conteos a ciegas (pedido 2b, `inventory.counts`, SPEC-NEGOCIO §5.4).
// ---------------------------------------------------------------------------

export type CountScope = "key_items" | "full"
export type CountStatus = "open" | "applied"

export interface CountLineRefIn {
  ingredient_id: number
  /** Texto decimal (`parse_qty_base` en el servidor); un número JSON crudo se rechaza. */
  qty_counted: string
  was_counted: boolean
}

export interface CountLinesIn {
  lines: CountLineRefIn[]
}

/**
 * A CIEGAS por diseño (SPEC-NEGOCIO §5.4): ni un campo de stock teórico, ni
 * una diferencia, ni un "sugerido". `previous_qty_counted` es la ÚNICA
 * referencia en pantalla — el valor que alguien escribió en el conteo
 * anterior, nunca un cálculo del libro. Este tipo no tiene, y no puede
 * tener, ningún campo de stock: es el contrato que hace que "a ciegas" sea
 * estructural, no una promesa de la pantalla.
 */
export interface CountLineOut {
  ingredient_id: number
  ingredient_name: string
  base_unit: BaseUnit
  qty_counted: string | null
  was_counted: boolean
  previous_qty_counted: string | null
}

/** Salida de `PUT /admin/counts/{id}/lines`: `partial` dice explícitamente
 * que el guardado es PARCIAL — nunca implica "todo coincide". */
export interface CountLinesSaveOut {
  lines: CountLineOut[]
  lines_counted: number
  lines_total: number
  partial: boolean
}

export interface CountOut {
  id: number
  scope: CountScope
  status: CountStatus
  opened_at: string
  business_date: string
  opened_by_employee_id: number
  opened_by_employee_name: string
  applied_at: string | null
  applied_by_employee_id: number | null
  applied_by_employee_name: string | null
  lines_total: number
  lines_counted: number
}

export interface CountDetailOut extends CountOut {
  lines: CountLineOut[]
}

export interface CountApplyLineOut {
  ingredient_id: number
  ingredient_name: string
  qty_counted: string
  stock_before: string
  adjustment: string
  stock_after: string
}

export interface CountApplyOut {
  id: number
  applied_at: string
  applied_by_employee_id: number
  applied_by_employee_name: string
  lines: CountApplyLineOut[]
}

export function postOpenCount(storeId: number, scope: CountScope): Promise<CountDetailOut> {
  return api<CountDetailOut>("/admin/counts", { method: "POST", query: { store_id: storeId }, body: { scope } })
}

export interface CountsQuery {
  storeId: number
  scope?: CountScope
  from?: string
  to?: string
}

export function listCounts(params: CountsQuery): Promise<CountOut[]> {
  return api<CountOut[]>("/admin/counts", {
    query: { store_id: params.storeId, scope: params.scope, from: params.from, to: params.to },
  })
}

export function countsCsvUrl(params: CountsQuery): string {
  const query = new URLSearchParams()
  query.set("format", "csv")
  query.set("store_id", String(params.storeId))
  if (params.scope) query.set("scope", params.scope)
  if (params.from) query.set("from", params.from)
  if (params.to) query.set("to", params.to)
  return `/api/v1/admin/counts?${query.toString()}`
}

export function getCount(countId: number, storeId: number): Promise<CountDetailOut> {
  return api<CountDetailOut>(`/admin/counts/${countId}`, { query: { store_id: storeId } })
}

/** `was_counted` lo escribe, renglón por renglón, quien cuenta — no existe
 * ningún parámetro ni atajo acá que marque todo de una vez ("todo coincide"
 * no existe: SPEC-NEGOCIO §5.4). Un `was_counted: false` entrante (un
 * borrador) nunca pisa un renglón que el servidor ya tenía en `true`
 * (confirmado) — el servidor lo ignora en silencio para ESA línea, sin
 * abortar el resto del guardado. */
export function putCountLines(countId: number, storeId: number, data: CountLinesIn): Promise<CountLinesSaveOut> {
  return api<CountLinesSaveOut>(`/admin/counts/${countId}/lines`, {
    method: "PUT",
    query: { store_id: storeId },
    body: data,
  })
}

/** Acción explícita del administrador, una sola vez: `409
 * COUNT_ALREADY_APPLIED` en el segundo intento, sin importar si llega con la
 * misma `Idempotency-Key` (la capa de idempotencia la resuelve antes) o una
 * distinta (la guarda de negocio corta antes de tocar el libro). */
export function postApplyCount(
  countId: number,
  storeId: number,
  authorizerPin: string,
  idempotencyKey: string,
): Promise<CountApplyOut> {
  return api<CountApplyOut>(`/admin/counts/${countId}/apply`, {
    method: "POST",
    query: { store_id: storeId },
    body: { authorizer_pin: authorizerPin },
    idempotencyKey,
  })
}

// ---------------------------------------------------------------------------
// Varianza, food cost real y salud del control (pedido 2b, `inventory.
// variance`, SPEC-NEGOCIO §5.4).
// ---------------------------------------------------------------------------

export type VarianceLevel = "green" | "yellow" | "red"

export interface VarianceRowOut {
  ingredient_id: number
  ingredient_name: string
  base_unit: BaseUnit
  opening_qty: string
  inflow_qty: string
  closing_qty: string
  real_usage_qty: string
  theoretical_usage_qty: string
  /** `real - teórico`; positivo = se usó más de lo esperado. */
  variance_qty: string
  /** TOTAL de plata YA CERRADO (pesos enteros con `formatCOP`) — no un costo
   * por unidad base: nunca pasar por `formatCOPDecimal`/`CostValue`. */
  variance_value: number | null
  cost_source: CostSource
  /** `|variance| / teórico`, puntos básicos reales (100 = 1 %); `null` si el
   * uso teórico es `0` (no hay denominador, no es "0 % de diferencia"). */
  variance_pct_bp: number | null
  /** Semáforo YA CALCULADO por el servidor contra los umbrales de la sede
   * (`GET/PUT /admin/stores/{id}/inventory-settings`) — el cliente nunca
   * compara `variance_pct_bp` contra un umbral propio. `red` es SÓLO
   * faltante: un sobrante, por grande que sea, llega como mucho a `yellow`
   * (ámbar). */
  level: VarianceLevel
}

/** Un renglón del Pareto de varianza por insumo (ordenado por |$| desc; a
 * igual |$|, faltante primero). Todo viene del backend: la pantalla no
 * suma, no ordena por plata ni acumula. */
export interface VarianceParetoRowOut {
  ingredient_id: number
  ingredient_name: string
  /** Pesos enteros con signo: positivo = faltante. */
  variance_value: number
  /** |variance_value|, pesos enteros: el alto de la barra. */
  abs_value: number
  direction: "shortage" | "surplus"
  /** |valor| ÷ Σ |valor|, puntos básicos. */
  share_bp: number
  /** Acumulado de |valor| hasta este renglón ÷ Σ |valor|, puntos básicos
   * (el último da 10000). La línea del Pareto. */
  cumulative_bp: number
  level: VarianceLevel
}

export interface VarianceOut {
  /** `null` sólo cuando se pidió el último conteo (sin `countId`) y la sede
   * no tiene ninguno aplicado (`available: false` con `reason`). */
  count_id: number | null
  opening_count_id: number | null
  window_from: string | null
  window_to: string | null
  /** `false` con `reason` cuando no hay un conteo completo/aplicado anterior
   * contra el cual comparar — nunca una lista vacía sin explicación. */
  available: boolean
  reason: string | null
  rows: VarianceRowOut[]
  yellow_threshold_bp: number
  red_threshold_bp: number
  /** El conteo aplicado más reciente de la sede (cualquier alcance), para
   * abrir la pestaña con él sin que el dueño lo elija. `null` sin ninguno. */
  latest_applied_count_id: number | null
  /** Pareto por insumo: sólo renglones con varianza valorizada ≠ 0. */
  pareto: VarianceParetoRowOut[]
  /** Σ |valor| del Pareto, pesos; `null` sin renglones valorizados. */
  total_abs_variance_value: number | null
  /** Σ de faltantes (positivo), pesos; `null` sin renglones valorizados. */
  shortage_value: number | null
  /** Σ de sobrantes (negativo, con su signo), pesos; `null` igual. */
  surplus_value: number | null
  /** Σ con signo, pesos; `null` igual. */
  net_variance_value: number | null
  /** Renglones con varianza pero sin costo resuelto (fuera del Pareto). */
  unvalued_rows: number
}

/** La varianza sólo existe sobre un conteo ya APLICADO
 * (`400 COUNT_NOT_APPLIED` si no). Sin `countId`, el backend usa el último
 * conteo aplicado de la sede. */
export function getVariance(params: { storeId: number; countId?: number | null }): Promise<VarianceOut> {
  return api<VarianceOut>("/admin/variance", {
    query: { store_id: params.storeId, count_id: params.countId ?? undefined },
  })
}

export function varianceCsvUrl(params: { storeId: number; countId: number }): string {
  const query = new URLSearchParams()
  query.set("format", "csv")
  query.set("store_id", String(params.storeId))
  query.set("count_id", String(params.countId))
  return `/api/v1/admin/variance?${query.toString()}`
}

/** `(inventario inicial + compras − final) ÷ ventas netas`, **sólo entre dos
 * conteos completos consecutivos aplicados** dentro del rango. `pct_bp` es
 * `null` con `reason` sin esos dos conteos, con salud del control "no
 * confiable", con una ventana más corta que `min_window_days`, con compras
 * en $0 habiendo recepciones, o si el resultado sería negativo — **jamás
 * `0`** y ya nunca negativo. Ventas, compras e inventario usan los mismos
 * instantes (`window_from`, `window_to`); las comandas cuentan por su hora
 * de cobro. */
export interface FoodCostOut {
  available: boolean
  reason: string | null
  opening_count_id: number | null
  closing_count_id: number | null
  window_from: string | null
  window_to: string | null
  /** Totales de plata (pesos enteros, `formatCOP`) — no `formatCOPDecimal`. */
  opening_value: number | null
  purchases_value: number | null
  closing_value: number | null
  net_sales: number | null
  pct_bp: number | null
  /** Horas y días COMPLETOS de la ventana; `null` sin par de conteos. */
  window_hours: number | null
  window_days: number | null
  /** Comandas cobradas en la ventana (el `n`); `null` sin par de conteos. */
  orders_in_window: number | null
  /** Food cost teórico de lo vendido en la misma ventana, puntos básicos
   * (costo congelado ÷ ventas netas de lo que tiene ficha). `null` con
   * `theoretical_reason` sin ventas, sin fichas o con cobertura bajo
   * `min_costed_pct_bp`. */
  theoretical_pct_bp: number | null
  theoretical_reason: string | null
  /** Qué parte de las ventas netas de la ventana tenía ficha con costo, bp. */
  costed_pct_bp: number | null
  /** `pct_bp − theoretical_pct_bp`, puntos básicos (positivo = se gastó más
   * insumo del que explican las ventas). `null` si falta cualquiera. */
  gap_bp: number | null
  /** Umbrales usados: ventana mínima (días) y cobertura mínima (bp). */
  min_window_days: number
  min_costed_pct_bp: number
}

/** Reporte de un solo objeto, no una lista — no exporta CSV (la regla
 * "toda lista exporta" no le aplica). */
export function getFoodCost(params: { storeId: number; from: string; to: string }): Promise<FoodCostOut> {
  return api<FoodCostOut>("/admin/food-cost", {
    query: { store_id: params.storeId, from: params.from, to: params.to },
  })
}

/** Los cuatro indicadores de SPEC-NEGOCIO §5.4/§10: días desde el último
 * conteo completo aplicado (`> 14` apaga el food cost real), % de
 * recepciones con factura, % de preparaciones por lote producidas esta
 * semana, mermas registradas esta semana. Cada ratio es `null` con su
 * `_reason` propio cuando no hay denominador — nunca `0`. */
export interface ControlHealthOut {
  days_since_full_count: number | null
  last_full_count_at: string | null
  inventory_unreliable: boolean
  reception_invoice_ratio_bp: number | null
  reception_invoice_ratio_reason: string | null
  batch_preps_produced_ratio_bp: number | null
  batch_preps_produced_reason: string | null
  waste_entries_this_week: number
}

export function getControlHealth(storeId: number): Promise<ControlHealthOut> {
  return api<ControlHealthOut>("/admin/control-health", { query: { store_id: storeId } })
}

// ---------------------------------------------------------------------------
// Lectura agregada de consumo por comanda (`GET /admin/orders/{id}/
// consumption`, corrección a SPEC-NEGOCIO §5.3 hecha realidad en 2b: la
// fusión es de LECTURA; el libro sigue guardando una fila por ítem). **Ronda
// 2 — retipado**: el endpoint vive en `backend/app/orders/router.py`
// (`get_order_consumption`) y su esquema en `backend/app/orders/
// schemas.py:322-364` (`OrderConsumptionRowOut`/`OrderConsumptionOut`) — NO
// en `app.inventory` como se tipó en la ronda anterior contra una
// implementación que el orquestador decidió borrar (la de `app.inventory`
// perdió frente a la de `app.orders`, que usa el costo CONGELADO del libro
// y el consumo NETO `SALE + NOTE_RETURN`, ver el docstring de
// `service.order_consumption`). Sin pantalla propia en ESTE territorio —
// "Pedidos" es `features/orders/**`, de otro agente (fuera de mi
// territorio, ver §7 del entregable); el tipo y la función quedan acá
// porque siguen siendo del dominio `app.orders` expuesto para admin, listos
// para quien construya esa pantalla.
// ---------------------------------------------------------------------------

export interface OrderConsumptionRowOut {
  ingredient_id: number | null
  preparation_id: number | null
  name: string
  unit: string
  /** Cantidad NETA consumida (`SALE` menos lo que devolvió un `NOTE_RETURN`),
   * texto decimal ya escalado (`format_qty_base`) — NUNCA milésimas crudas.
   * PUEDE SER NEGATIVA (salida neta) y puede ser `"0"` si una nota devolvió
   * exactamente lo que la venta había descontado — no es un error, no se
   * corrige a positivo acá. */
  qty_base: string
  /** Costo TOTAL de este renglón (suma de todas las filas del libro que
   * aportan a este insumo/preparación), en pesos enteros — el costo
   * CONGELADO de cada movimiento en el momento en que se escribió
   * (`record_movement`), nunca el costo resuelto de HOY: revalorar acá
   * violaría el snapshot que ya protege `unit_cost` en el ítem. `null`
   * cuando NINGUNA fila del libro para este insumo tuvo costo — nunca un
   * `0` mudo. */
  cost: number | null
  /** Origen de la fila de costo más reciente que sí tuvo costo; `null`
   * junto con `cost: null` (nunca `CostSource` con un `cost` ausente). */
  cost_source: CostSource | null
}

export interface OrderConsumptionOut {
  order_id: number
  rows: OrderConsumptionRowOut[]
}

/** Sin `store_id`: la ruta servida no lo pide (`current_admin` + `admin_
 * store` resuelven la sede desde `order.store_id`, no desde la query) —
 * mandarlo igual sería un parámetro que el servidor ignora en silencio. */
export function getOrderConsumption(orderId: number): Promise<OrderConsumptionOut> {
  return api<OrderConsumptionOut>(`/admin/orders/${orderId}/consumption`)
}
