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

/**
 * Una hora de reloj de Bogotá (0-23). Desde la revisión de datos de
 * septiembre, `sales_by_hour`/`sales_by_hour_reference` traen SIEMPRE las 24
 * horas, ya ordenadas desde el `cutoff_hour` de la sede (06, 07… 23, 00…
 * 05), con `0` explícito donde no hubo venta. Se pintan en el orden en que
 * llegan: nunca se reordenan por `hour`.
 */
export interface HourBucketOut {
  hour: number
  gross: number
  net: number
  /** Comandas con comprobante emitido en esa hora. */
  orders?: number
  /** `true` = hora del día en curso que todavía no empezó: su `0` no es
   * venta cero, es «todavía no pasó» (no se dibuja como barra en 0). */
  pending?: boolean
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
  /**
   * Plata en juego, en pesos enteros; con signo cuando el signo dice algo
   * (`cash_diff_summary`: negativo = faltante neto). `null`/ausente = el
   * aviso no es de plata (nunca `0`). La lista `alerts` ya llega ordenada:
   * gravedad y después `|amount|` descendente.
   */
  amount?: number | null
}

/**
 * `payload` del aviso `type: "cash_diff_summary"`: todas las diferencias de
 * caja al cierre sin leer, en UN aviso (reemplaza en `alerts` a los
 * `cash_difference`/`cash_difference_critical`/`difference_streak` sueltos,
 * que siguen existiendo en la campana). Montos en pesos con signo
 * (negativo = faltante). Fechas: día operativo `YYYY-MM-DD`.
 */
export interface CashDiffSummaryPayload {
  count: number
  shortage_count: number
  /** ≤ 0 */
  shortage_total: number
  surplus_count: number
  /** ≥ 0 */
  surplus_total: number
  /** = `amount` del aviso. */
  net_total: number
  critical_count: number
  shift_ids: number[]
  first_business_date: string | null
  last_business_date: string | null
  /** Días operativos desde el primer cierre con diferencia hasta hoy, inclusive. */
  days: number | null
  /** Personas con racha vigente (≥ 2 cierres seguidos con diferencia), la más larga primero. */
  streaks: { employee_id: number; employee_name: string; streak: number }[]
}

export const CASH_DIFF_SUMMARY_ALERT_TYPE = "cash_diff_summary"

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
  /** Lo que vale la cantidad que falta (|qty| × costo vigente), en pesos
   * enteros positivos. `null` = el insumo no tiene costo todavía. La lista
   * llega ordenada por este monto, descendente (los `null` al final). */
  amount?: number | null
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

/**
 * Hoy contra el MISMO día de la semana pasada HASTA LA MISMA HORA (`until` =
 * ahora − 7 días, truncado al minuto). `net`/`orders` `null` (con `null_reason`) cuando la sede
 * todavía no operaba ese día. `delta_bp`: variación del neto de hoy en
 * puntos básicos con signo (−1.200 = 12 % abajo); `null` sin divisor
 * (referencia en $0). `reference_operated`: si ese día la sede abrió.
 */
export interface TodayComparisonOut {
  reference_business_date: string
  until: string
  net: number | null
  orders: number | null
  delta_bp: number | null
  orders_delta_bp: number | null
  reference_operated: boolean | null
  null_reason: string | null
}

/** Cómo cerró un día operativo completo (`yesterday_close`). */
export interface DayCloseOut {
  business_date: string
  net: number
  orders: number
  avg_ticket: number | null
  /** `false` = ese día la sede no abrió (su $0 no es un mal día). */
  operated: boolean
}

export interface AreaCountDoneTodayOut {
  count_id: number
  counted_at: string
  employee_name: string
}

/** Un área y si contó hoy; `null` = todavía nadie contó ese momento. */
export interface AreaCountAreaTodayOut {
  area_id: number
  area_name: string
  opening: AreaCountDoneTodayOut | null
  closing: AreaCountDoneTodayOut | null
}

/** Un artículo con diferencia (la calcula el servidor). `shortage_qty`
 * positivo = faltó; `window`: de noche, en el turno o recuento sorpresa. */
export interface AreaCountFlagOut {
  count_id: number
  area_name: string
  window: "night" | "shift" | "spot"
  ingredient_id: number
  ingredient_name: string
  base_unit: string
  shortage_qty: string
  shortage_value: number | null
  flagged: boolean
  counted_at: string
  employee_name: string
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
  // Consignar desde el POS (2026-09-24). Con «Consignaciones» apagada llegan
  // `0` y `null`: sin saldo publicado no hay aviso, y `null` no es `$ 0`.
  /** Consignaciones hechas desde el POS que esperan que el administrador las confirme. */
  deposits_to_confirm_count?: number
  /** Plata de cierres todavía sin consignar, sumada por el servidor. */
  undeposited_total?: number | null
  /** Fecha de negocio (ISO) del día más viejo con plata sin consignar. */
  undeposited_oldest_date?: string | null
  /** La rutina del turno en el POS (2026-09-25). `0` con la función apagada. */
  reception_drafts_pending_count?: number
  requests_pending_count?: number
  novelties_open_count?: number
  novelties_urgent_count?: number
  transfers_incoming_count?: number
  /** Conteo corto por área (`inventory.shift_counts`). Apagada: `false` y listas vacías. */
  area_counts_enabled?: boolean
  area_counts_areas?: AreaCountAreaTodayOut[]
  area_counts_flags?: AreaCountFlagOut[]
  area_recounts_pending_count?: number
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
  // Revisión de datos (septiembre). Plata en juego del riel, sumada por el
  // servidor: `null` = función apagada (`payables_overdue_total`) o ningún
  // insumo en negativo con costo (`ingredients_negative_amount`, y
  // `ingredients_negative_unvalued` dice cuántos quedaron sin valorar).
  payables_overdue_total?: number | null
  ingredients_negative_amount?: number | null
  ingredients_negative_unvalued?: number
  /** `null` sólo si un servidor viejo no la manda. */
  comparison?: TodayComparisonOut | null
  /** Mismo día de la semana pasada, día COMPLETO, misma forma que
   * `sales_by_hour` (24 horas, ninguna `pending`). `[]` si la sede no
   * operaba ese día. */
  sales_by_hour_reference?: HourBucketOut[]
  /** Día operativo anterior, para mostrar antes de la primera venta.
   * `null` si la sede todavía no operaba. */
  yesterday_close?: DayCloseOut | null
}

export function getToday(storeId: number): Promise<TodayOut> {
  return api<TodayOut>("/admin/today", { query: { store_id: storeId } })
}

// ---------------------------------------------------------------------------
// GET /admin/sales
// ---------------------------------------------------------------------------

export type SalesGroupBy = "business_date" | "shift" | "method" | "channel" | "employee" | "hour" | "zone"

/**
 * «Qué se vendió»: agrupa por las LÍNEAS del comprobante (unidades, neto y
 * costo/margen por plato o categoría, ordenado por neto desc). Tipo aparte
 * de `SalesGroupBy` para no obligar a `Record<SalesGroupBy, …>` existentes
 * a conocerlo antes de que la pantalla lo use; el día que lo haga, se
 * pueden fundir.
 */
export type SalesLineGroupBy = "product" | "category"

/**
 * El período del mismo largo inmediatamente anterior a `[from, to]` (sólo en
 * `SalesReportOut.total`). `net`/`orders`/`avg_ticket` `null` (con
 * `null_reason`) si la sede no operaba todavía; `partial` = empezó a operar
 * dentro de ese período. `*_delta_bp`: variación del período actual contra
 * éste, en puntos básicos con signo; `null` sin divisor.
 */
export interface PreviousPeriodOut {
  date_from: string
  date_to: string
  net: number | null
  orders: number | null
  avg_ticket: number | null
  delta_bp: number | null
  orders_delta_bp: number | null
  avg_ticket_delta_bp: number | null
  partial: boolean
  null_reason: string | null
}

/**
 * Una fila de `GET /admin/sales`. Las filas llegan YA ordenadas por el
 * servidor y se pintan en ese orden: `business_date` cronológico con todos
 * los días (los vacíos en `0`); `hour` las 24 horas desde el corte;
 * `shift` por apertura real; el resto por `net` descendente.
 */
export interface SalesBucketOut {
  key: string
  label?: string
  gross?: number
  net?: number
  tax?: number
  /** `null` en `product`/`category`: la propina no es de un plato. */
  tips?: number | null
  /** En `group_by=method` cuenta PAGOS, no comandas (ver `payments`). */
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
  /** = `costed_pct` (spec): % de la venta neta que tuvo ficha de verdad.
   * `null` en las filas por medio de pago (no aplica). */
  costed_pct?: number | null
  /** Participación en el neto del reporte, en puntos básicos; las filas
   * suman exacto 10.000. `null` en `total`. */
  share_bp?: number | null
  /** Sólo `group_by=method` (filas y total): cantidad de pagos. */
  payments?: number | null
  /** Sólo `group_by=product|category`: unidades vendidas. */
  units?: number | null
  /** Sólo `group_by=business_date`: la sede abrió ese día. */
  operated?: boolean | null
  /** Sólo en `total`. */
  previous_period?: PreviousPeriodOut | null
}

export interface SalesReportOut {
  store_id: number
  date_from: string
  date_to: string
  group_by: SalesGroupBy | SalesLineGroupBy
  rows: SalesBucketOut[]
  total: SalesBucketOut
}

export interface SalesQuery {
  storeId: number
  from: string
  to: string
  groupBy: SalesGroupBy | SalesLineGroupBy
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

// ---------------------------------------------------------------------------
// GET /admin/reports/overview — «Informes»: todas las secciones de una vez.
// Toda cifra sale de la misma agregación de `GET /admin/sales`
// (`backend/app/reports/overview.py`); la pantalla sólo la formatea.
// ---------------------------------------------------------------------------

/** Un dato que Informes pediría y el servidor no tiene: «sin dato» con motivo. */
export interface MissingDataOut {
  key: string
  label: string
  reason: string
}

/** La hora de más venta neta del período: la marca el servidor. */
export interface PeakHourOut {
  hour: number
  label: string
  net: number
  orders: number
  share_bp: number | null
}

export interface TopProductOut {
  key: string
  label: string
  net: number
  units: number | null
  share_bp: number | null
  category_key: string
  category_label: string
}

export interface CategoryRefOut {
  key: string
  label: string
}

export interface DeliveryCustomersOut {
  delivery: SalesBucketOut | null
  platform: SalesBucketOut | null
  identified_customers: number
  identified_orders: number
  missing: MissingDataOut[]
}

export interface MenuSummaryOut {
  available: boolean
  reason: string | null
  star: number | null
  plowhorse: number | null
  puzzle: number | null
  dog: number | null
  unclassified: number | null
  insufficient_sample: number | null
}

export interface CostSectionOut {
  theoretical_cost: number | null
  gross_margin: number | null
  costed_pct: number | null
  by_category: SalesBucketOut[]
}

export interface StoreRowOut {
  store_id: number
  store_name: string
  net: number
  orders: number
  avg_ticket: number | null
  share_bp: number | null
}

export interface ReportsOverviewOut {
  scope: "store" | "all"
  store_id: number | null
  store_ids: number[]
  date_from: string
  date_to: string
  total: SalesBucketOut
  by_method: SalesBucketOut[]
  by_hour: SalesBucketOut[]
  peak_hour: PeakHourOut | null
  products: TopProductOut[]
  categories: CategoryRefOut[]
  by_employee: SalesBucketOut[]
  by_channel: SalesBucketOut[]
  by_zone: SalesBucketOut[]
  delivery_customers: DeliveryCustomersOut
  menu_engineering: MenuSummaryOut
  cost: CostSectionOut
  /** Sólo con «Todas las sedes»; `null` por sede. */
  by_store: StoreRowOut[] | null
}

export interface ReportsOverviewQuery {
  /** El id de una sede, o `"all"` para todas las de la organización. */
  storeId: number | "all"
  from: string
  to: string
}

export function getReportsOverview(params: ReportsOverviewQuery): Promise<ReportsOverviewOut> {
  return api<ReportsOverviewOut>("/admin/reports/overview", {
    query: { store_id: params.storeId, from: params.from, to: params.to },
  })
}
