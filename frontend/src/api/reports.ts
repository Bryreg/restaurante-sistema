/**
 * Reportes del administrador — `GET /admin/today`, `GET /admin/sales`,
 * `GET /admin/accountant-report`, `GET /admin/unavailable-log`
 * (`features/fase-1b-venta/spec.md` «Admin reports», tipado contra
 * `backend/app/reports/schemas.py` y `backend/app/reports/service.py`
 * — territorio de `backend-reportes`, ya escrito cuando este archivo se
 * creó). `GET /admin/documents` y `GET /admin/notes` (documentos con
 * detalle, notas) y `GET /admin/employees/{id}/activity` viven en
 * `app/payments`, `app/fiscal` y `app/shifts` respectivamente — no son
 * territorio de este archivo; las pantallas de "Ventas" enlazan a las
 * pantallas de Documentos fiscales/Notas ya construidas por ese equipo en
 * vez de duplicar esos listados acá.
 *
 * Todo campo de un tipo `Out` es opcional o `| null` (mismo patrón que
 * `src/api/orders.ts`): el backend puede no mandarlo y un tipo que lo exige
 * no puede romper la pantalla. `null` nunca se pinta como `0` — es "sin
 * dato", y `formatCOP`/estos tipos lo respetan.
 *
 * El frontend NUNCA recalcula un KPI de estos reportes: todo `gross`, `net`,
 * `tax`, `tips`, `avg_ticket`, `p50_seconds`, `sent_at_payment_ratio`, etc.
 * se pinta tal como llega.
 */

import { api } from "@/api/client"

// ---------------------------------------------------------------------------
// Piezas compartidas.
// ---------------------------------------------------------------------------

export interface EmployeeRefOut {
  id?: number
  name?: string
}

export interface MethodAmountOut {
  method: string
  amount: number
}

// ---------------------------------------------------------------------------
// GET /admin/today
// ---------------------------------------------------------------------------

export interface HourBucketOut {
  hour: number
  gross: number
  net: number
}

export interface OpenOrderAgeOut {
  id: number
  channel?: string
  tables?: string[]
  opened_at?: string
  minutes_since_opened?: number
  bill_presented_at?: string | null
  minutes_since_bill_presented?: number | null
  unsent_flag?: boolean
  unpaid_flag?: boolean
  total?: number
}

export interface UnavailableProductOut {
  product_id: number
  name?: string
  unavailable_at?: string
  by?: EmployeeRefOut | null
}

export type AlertLevel = "info" | "warning" | "critical"

export interface AlertOut {
  type: string
  level: AlertLevel
  title: string
  body: string
  created_at: string
  payload?: Record<string, unknown> | null
}

// ---------------------------------------------------------------------------
// Pedido 2a: las cuatro alertas que gana `GET /admin/today`
// (`backend/app/reports/schemas.py`, sección "Pedido 2a"). Cada una envuelve
// tal cual el `dict` que arma `app.inventory.hooks`/`app.recipes.hooks` —
// nunca se recalcula acá. Ninguna trae `cost`/`margin`: `negative_stock_
// alerts` trae cantidad y causa probable, no plata (el mismo invariante de
// OpenAPI de `tests/audit` que corre sobre `/admin/today` lo exige).
// ---------------------------------------------------------------------------

export interface IngredientAlertOut {
  ingredient_id: number
  name?: string
  qty_base?: number
  min_stock?: number
  base_unit?: string
}

export interface NegativeStockAlertOut {
  ingredient_id: number
  name?: string
  qty_base?: number
  min_stock?: number
  base_unit?: string
  negative_since?: string | null
  /** Server-computed; `null` cuando no hay causa clara — nunca se adivina en el cliente. */
  probable_cause?: string | null
}

export interface PrepAlertOut {
  type?: string
  preparation_id: number
  preparation_name?: string
  current_stock?: number
  unit?: string
}

export interface UncostedProductOut {
  product_id: number
  product_name?: string | null
  items_sold?: number
  qty_sold?: number
}

// ---------------------------------------------------------------------------
// Pedido 2b: los tres grupos nuevos de `GET /admin/today`
// (`backend/app/reports/schemas.py`, sección "Pedido 2b"). Cada uno envuelve
// el `dict` que devuelve el hook del dominio DUEÑO (`app.inventory.hooks.
// expiring_or_expired_lots`/`last_applied_full_count_at`, `app.purchases.
// hooks.overdue_payables`/`pending_review_payables_count`), acotado por
// `find_spec_safe` Y `features.is_enabled` — con el módulo ausente o la
// función apagada, `[]`/`0`/`null`, nunca un error ni una alerta que la
// sede no puede resolver.
// ---------------------------------------------------------------------------

export interface LotAlertOut {
  batch_id: number
  ingredient_id: number
  /** Texto decimal (`format_qty_base`) — nunca milésimas crudas. */
  qty_base: string
  expires_at: string
  status: "expiring" | "expired"
}

export interface PayableAlertOut {
  payable_id: number
  supplier_id: number
  supplier_name: string
  due_date: string
  /** Saldo en pesos enteros — ya derivado por el servidor de los pagos vivos. */
  balance: number
  days_overdue: number
}

export interface TodayOut {
  store_id: number
  business_date: string
  sales_by_hour?: HourBucketOut[]
  gross?: number
  net?: number
  tax?: number
  tips_total?: number
  tips_by_method?: MethodAmountOut[]
  orders?: number
  covers?: number | null
  avg_ticket?: number | null
  avg_per_cover?: number | null
  tables_occupied?: number
  tables_total?: number
  open_orders?: OpenOrderAgeOut[]
  unsent_count?: number
  unpaid_count?: number
  /** `null` = no hay turno abierto (no es "$0 esperado"). */
  expected_cash?: number | null
  unavailable_products?: UnavailableProductOut[]
  pending_refunds_count?: number
  unreviewed_closes_count?: number
  alerts?: AlertOut[]
  // Pedido 2a: `[]` cuando `catalog.recipes`/`inventory.perpetual` están
  // apagadas o el dominio todavía no está montado — el backend nunca omite
  // la llave, pero este tipo la deja opcional por el mismo motivo que el
  // resto del archivo (un campo nuevo del servidor no puede romper la
  // pantalla si algún día falta).
  ingredients_below_min?: IngredientAlertOut[]
  ingredients_negative?: NegativeStockAlertOut[]
  preps_without_production?: PrepAlertOut[]
  products_discounting_nothing?: UncostedProductOut[]
  // Pedido 2b: `[]`/`0`/`null` cuando `inventory.lots`/`purchases`/
  // `inventory.variance` están apagadas o el dominio todavía no está
  // montado — nunca falta la llave (mismo criterio que las cuatro de
  // arriba, `backend/app/reports/schemas.py::TodayOut`).
  lots_expiring_or_expired?: LotAlertOut[]
  payables_overdue?: PayableAlertOut[]
  payables_pending_review_count?: number
  /** `null` (no `false` mudo) cuando `inventory.variance` está apagada o el
   * dominio no está montado: "confiable/no confiable" sólo tiene sentido si
   * la sede lleva el control. */
  inventory_unreliable?: boolean | null
  days_since_last_full_count?: number | null
}

export function getToday(storeId: number): Promise<TodayOut> {
  return api<TodayOut>("/admin/today", { query: { store_id: storeId } })
}

// ---------------------------------------------------------------------------
// GET /admin/sales
// ---------------------------------------------------------------------------

export type SalesGroupBy = "business_date" | "shift" | "method" | "channel" | "employee" | "hour" | "zone"

export interface SalesBucketOut {
  key: string
  label?: string
  gross?: number
  net?: number
  tax?: number
  tips?: number
  orders?: number
  covers?: number | null
  avg_ticket?: number | null
  avg_per_cover?: number | null
  // Pedido 2a (`backend/app/reports/schemas.py`, `_document_cost_stats`):
  // leídos de `OrderItem.unit_cost` CONGELADO al enviar, nunca de la ficha
  // actual. `null` cuando NINGÚN documento del grupo tuvo costo todavía
  // (nunca `0` mudo).
  //
  // Se llaman como los nombra la spec. Durante 2a estuvieron publicados con
  // otras llaves para esquivar dos invariantes de OpenAPI que barrían
  // `/admin/sales` buscando la subcadena `cost` en rutas de admin: el
  // barrido era más viejo que la superficie de costo que 2a existía para
  // construir, así que se acotaron los barridos y volvieron los nombres de
  // la spec. Deformar un contrato publicado para pasar un test es arreglar
  // el termómetro.
  /** = costo teórico (spec: `theoretical_cost`). */
  theoretical_cost?: number | null
  /** = margen bruto teórico (spec: `gross_margin`): `net − theoretical_cost`. */
  gross_margin?: number | null
  /** = `costed_pct` (spec): % de la venta neta que tuvo ficha de verdad. */
  costed_pct?: number | null
}

export interface SalesReportOut {
  store_id: number
  date_from: string
  date_to: string
  group_by: SalesGroupBy
  rows: SalesBucketOut[]
  total: SalesBucketOut
}

export interface SalesQuery {
  storeId: number
  from: string
  to: string
  groupBy: SalesGroupBy
}

export function getSales(params: SalesQuery): Promise<SalesReportOut> {
  return api<SalesReportOut>("/admin/sales", {
    query: { store_id: params.storeId, from: params.from, to: params.to, group_by: params.groupBy },
  })
}

/** URL directa (con `format=csv`), mismo patrón que `adminOrdersCsvUrl`. */
export function salesCsvUrl(params: SalesQuery): string {
  const query = new URLSearchParams()
  query.set("format", "csv")
  query.set("store_id", String(params.storeId))
  query.set("from", params.from)
  query.set("to", params.to)
  query.set("group_by", params.groupBy)
  return `/api/v1/admin/sales?${query.toString()}`
}

// ---------------------------------------------------------------------------
// GET /admin/accountant-report
// ---------------------------------------------------------------------------

export interface AccountantRateBreakdownOut {
  rate: number
  documents_base: number
  documents_tax: number
  notes_base: number
  notes_tax: number
}

export interface AccountantRowOut {
  business_date: string
  documents_count: number
  notes_count: number
  tips_amount: number
  by_rate: AccountantRateBreakdownOut[]
}

export interface AccountantReportOut {
  store_id: number
  year: number
  period_kind: "bimester" | "month"
  period: number
  date_from: string
  date_to: string
  rows: AccountantRowOut[]
  totals_by_method: MethodAmountOut[]
  documents_total_base: number
  documents_total_tax: number
  notes_total_base: number
  notes_total_tax: number
  tips_total: number
}

export interface AccountantQuery {
  storeId: number
  year: number
  bimester?: number
  month?: number
}

export function getAccountantReport(params: AccountantQuery): Promise<AccountantReportOut> {
  return api<AccountantReportOut>("/admin/accountant-report", {
    query: { store_id: params.storeId, year: params.year, bimester: params.bimester, month: params.month },
  })
}

export function accountantReportCsvUrl(params: AccountantQuery): string {
  const query = new URLSearchParams()
  query.set("format", "csv")
  query.set("store_id", String(params.storeId))
  query.set("year", String(params.year))
  if (params.bimester !== undefined) query.set("bimester", String(params.bimester))
  if (params.month !== undefined) query.set("month", String(params.month))
  return `/api/v1/admin/accountant-report?${query.toString()}`
}

// ---------------------------------------------------------------------------
// GET /admin/unavailable-log
// ---------------------------------------------------------------------------

export interface UnavailableLogRowOut {
  product_id: number
  name?: string
  unavailable_at?: string
  by?: EmployeeRefOut | null
  /** `null` = sin ventas previas para estimar, no "0 perdidas". */
  estimated_lost_units?: number | null
  estimated_lost_sales?: number | null
}

export interface UnavailableLogQuery {
  storeId: number
  from: string
  to: string
}

export function getUnavailableLog(params: UnavailableLogQuery): Promise<UnavailableLogRowOut[]> {
  return api<UnavailableLogRowOut[]>("/admin/unavailable-log", {
    query: { store_id: params.storeId, from: params.from, to: params.to },
  })
}

export function unavailableLogCsvUrl(params: UnavailableLogQuery): string {
  const query = new URLSearchParams()
  query.set("format", "csv")
  query.set("store_id", String(params.storeId))
  query.set("from", params.from)
  query.set("to", params.to)
  return `/api/v1/admin/unavailable-log?${query.toString()}`
}
