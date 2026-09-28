/**
 * Cliente del panel de control (`GET /admin/panel`) y de las fichas
 * relacionales (`GET /admin/records/...`). Espejo de
 * `backend/app/reports/panel_schemas.py`.
 *
 * Nada de acá se calcula en el cliente: el semáforo, sus razones, el
 * esperado, quién marcó entrada y quién sólo se identificó, las ventas de un
 * turno o de una persona llegan hechas del servidor, que las saca de las
 * mismas funciones que Hoy, Dinero, Ventas e Informes.
 */
import { api } from "@/api/client"
import type { SalesBucketOut, SeriesBadSide, SeriesOut, SeriesPointOut, SeriesUnit } from "@/api/reports"

/** Espejo de `PanelLevelLiteral` (`app/reports/schemas.py`). */
export type PanelLevel = "critical" | "warning" | "info"
/** Espejo de `PanelLightLiteral` (`app/reports/schemas.py`). */
export type PanelLight = "red" | "amber" | "green" | "gray"

/** Una persona con el nombre congelado del registro y si HOY sigue activa. */
export interface PersonRefOut {
  id: number
  name: string
  active: boolean
}

export interface PanelCashOut {
  shift_id: number
  business_date: string
  opened_at: string
  responsible: PersonRefOut
  is_stale: boolean
  stale_since: string | null
  cash_over_threshold: boolean
  expected_cash: number
}

export interface PanelStaffPersonOut {
  employee_id: number
  name: string
  since: string
  on_pause: boolean
  active: boolean
  puesto?: string | null
}

/** Una salida olvidada: entrada abierta de un día que ya pasó (no suma horas hasta corregirla). */
export interface PanelPendingExitOut {
  entry_id: number
  employee_id: number
  name: string
  business_date: string
  in_at: string
}

/** Quién trabaja: la asistencia real del día, con o sin caja abierta. */
export interface PanelStaffOut {
  present: PanelStaffPersonOut[]
  pending_review: PanelPendingExitOut[]
  reason: string | null
}

export interface PanelAreaCountsOut {
  enabled: boolean
  areas_total: number
  opening_done: number
  /** Áreas con la apertura obligatoria sin hacer. */
  opening_missing: number
  closing_done: number
  flagged: number
  pending_recounts: number
}

export interface PanelSalonOut {
  tables_occupied: number
  tables_total: number
  open_orders: number
  unsent: number
  unpaid: number
}

export interface PanelKitchenOut {
  enabled: boolean
  in_kitchen: number
  late: number
  very_late: number
  oldest_late_minutes: number | null
}

export interface PanelPendingOut {
  deposits_to_confirm: number
  requests_pending: number
  novelties_open: number
  novelties_urgent: number
  unreviewed_closes: number
  reserve_loans_open: number
  /** `null`: la sede no usa base de respaldo. */
  reserve_loans_total: number | null
  attendance_review: number
}

export interface PanelReasonOut {
  key: string
  level: PanelLevel
  text: string
}

export interface StorePanelOut {
  store_id: number
  store_name: string
  business_date: string
  light: PanelLight
  reasons: PanelReasonOut[]
  /** Sin turno y sin actividad: la sede está cerrada (semáforo gris). */
  closed: boolean
  cash: PanelCashOut | null
  staff: PanelStaffOut
  area_counts: PanelAreaCountsOut
  salon: PanelSalonOut
  kitchen: PanelKitchenOut
  pending: PanelPendingOut
  /** Los bullets «barra + raya» de los bloques de Hoy. */
  bullets?: PanelBulletsOut | null
}

/** Un bullet de 90 × 10: el dato, su raya y si quedó del lado malo (lo decide el servidor). */
export interface BulletOut {
  value: number | null
  reference: number | null
  bad_side: SeriesBadSide
  outside: boolean
  /** Variación contra la raya, en puntos básicos con signo. */
  delta_bp: number | null
  /** Lo que pasa de la raya (positivo), cuando la pasa. */
  over_by: number | null
  /** Por qué no hay dato o raya. */
  reason: string | null
}

export interface AreaProgressOut {
  area_id: number
  area_name: string
  counted: number | null
  total: number | null
  /** Va atrasado: la apertura es obligatoria y falta. */
  behind: boolean
}

export interface PanelBulletsOut {
  /** Ventas netas de hoy contra el mismo día de la semana pasada a esta hora. */
  sales: BulletOut
  reference_business_date: string | null
  /** Efectivo esperado contra el umbral de retiro; `null` sin turno. */
  cash: BulletOut | null
  /** Personas en turno por hora, 6 a. m.–12 a. m.; lo que viene va `future`. */
  staff_by_hour: SeriesOut
  area_progress: AreaProgressOut[]
  /** Minutos de cada mesa abierta contra «mesa larga» (Ajustes). */
  tables: SeriesOut
  /** Minutos de cada tiquete contra «tiquete demorado» (Ajustes). */
  tickets: SeriesOut
  generated_at: string
}

export interface PanelOut {
  scope: "all" | "store"
  generated_at: string
  stores: StorePanelOut[]
}

export function getPanel(storeId: number | "all"): Promise<PanelOut> {
  return api<PanelOut>("/admin/panel", { query: { store_id: storeId } })
}

// ---------------------------------------------------------------------------
// Celular: Caja, Equipo e Informes (`GET /admin/panel/sections`). Espejo de
// `SectionOut` en `backend/app/reports/series_schemas.py`. Cada tarjeta
// trae su cifra, su estado en palabras, su serie «barra + raya» y sus
// excepciones: la pantalla sólo formatea `value` según `unit`.
// ---------------------------------------------------------------------------

/** Cómo está una tarjeta o un renglón. Espejo de `SectionToneLiteral`. */
export type SectionTone = "ok" | "warning" | "critical" | "muted"
/** Qué dibujo pide la serie. Espejo de `SectionChartLiteral`. */
export type SectionChart = "columns" | "diverging" | "dual"
/** Espejo de `SectionKeyLiteral`. */
export type SectionKey = "caja" | "equipo" | "informes"

export interface SectionRowOut {
  key: string
  label: string
  /** `null`: el renglón no tiene cifra y dice `note`. */
  value: number | null
  unit: SeriesUnit
  note: string | null
  tone: SectionTone
}

export interface SectionCardOut {
  key: string
  available: boolean
  reason: string | null
  unit: SeriesUnit
  /** `null` = sin dato (nunca 0). */
  value: number | null
  /** «de cuántos» («2 de 4»). */
  of: number | null
  /** La cifra cuando no es un número (una sede, una franja). */
  value_text: string | null
  tone: SectionTone
  status: string | null
  note: string | null
  chart: SectionChart
  series: SeriesOut
  rows: SectionRowOut[]
}

export interface SectionOut {
  section: SectionKey
  scope: "all" | "store"
  store_ids: number[]
  generated_at: string
  cards: SectionCardOut[]
}

export function getPanelSection(section: SectionKey, storeId: number | "all"): Promise<SectionOut> {
  return api<SectionOut>("/admin/panel/sections", { query: { section, store_id: storeId } })
}

// ---------------------------------------------------------------------------
// Fichas
// ---------------------------------------------------------------------------

export interface RecordNoveltyOut {
  id: number
  title: string
  level: string
  category: string
  employee_name: string
  created_at: string
  resolved_at: string | null
}

export interface RecordVoidOut {
  order_id: number
  item_name: string
  qty: number
  amount: number
  reason: string | null
  voided_at: string | null
  voided_by: string | null
  authorized_by: string | null
  after_bill: boolean
}

export interface RecordDiscountOut {
  order_id: number
  kind: "discount" | "courtesy"
  amount: number | null
  reason: string | null
  employee_name: string | null
  authorized_by: string | null
  at: string | null
}

export interface RecordAreaCountOut {
  count_id: number
  area_name: string
  moment: string
  counted_at: string
  employee_name: string
}

export interface RecordAttendanceOut {
  shift_id: number | null
  business_date: string | null
  employee_id: number
  employee_name: string
  in_at: string
  out_at: string | null
  /** `open`, `closed` o `review` (salida olvidada). */
  status: string
  /** Minutos trabajados, restadas las pausas (motor de nómina). `null` sin salida. */
  worked_minutes?: number | null
}

export interface RecordEnvelopeOut {
  source_shift_id: number | null
  business_date: string | null
  expected: number | null
  counted: number | null
  difference: number | null
}

export interface RecordOpeningCountOut {
  envelopes: RecordEnvelopeOut[]
  expected_total: number
  counted_total: number
  /** Contado − esperado de la apertura entera (negativo = faltante). Ausente en un backend viejo. */
  difference_total?: number
  counted_by: string
  counted_at: string
}

export interface RecordReserveMovementOut {
  kind: string
  amount: number
  employee_name: string
  authorized_by: string | null
  at: string
  reversed: boolean
}

export interface RecordDepositOut {
  deposited_total: number
  to_deposit: number | null
  outstanding: number | null
}

export interface ShiftRecordOut {
  shift_id: number
  store_id: number
  store_name: string
  business_date: string
  status: string
  opened_at: string
  closed_at: string | null
  is_stale: boolean
  responsible: PersonRefOut
  opened_by: PersonRefOut
  closed_by: string | null
  reviewed: boolean
  sales: SalesBucketOut | null
  deposit: RecordDepositOut | null
  opening_mode: string
  opening_count: RecordOpeningCountOut | null
  reserve_movements: RecordReserveMovementOut[]
  /** `null`: la sede no usa base de respaldo. */
  reserve_loan_outstanding: number | null
  voids: RecordVoidOut[]
  discounts: RecordDiscountOut[]
  novelties: RecordNoveltyOut[]
  area_counts: RecordAreaCountOut[]
  attendance: RecordAttendanceOut[]
  /** «¿Cuándo hubo más efectivo del que debía?»: esperado por hora contra el umbral de retiro. */
  cash_by_hour?: CashByHourSeriesOut | null
}

export interface CashHourPointOut extends SeriesPointOut {
  /** Los retiros de esa hora, en pesos. */
  pickups: number[]
}

export interface CashByHourSeriesOut {
  available: boolean
  reason: string | null
  unit: "cop"
  bad_side: SeriesBadSide
  /** El umbral de retiro de la sede. */
  reference: number | null
  points: CashHourPointOut[]
  hours_over: number
  /** La serie se cortó (turno abandonado de muchas horas). */
  truncated: boolean
  /** Hasta dónde se dibuja y por qué, cuando la serie se cortó. */
  truncated_reason?: string | null
}

export function getShiftRecord(shiftId: number): Promise<ShiftRecordOut> {
  return api<ShiftRecordOut>(`/admin/records/shift/${shiftId}`)
}

export interface RecordShiftRowOut {
  shift_id: number
  business_date: string
  status: string
  is_stale: boolean
  difference: number | null
  closed_without_count: boolean
}

export interface EmployeeRecordOut {
  employee: PersonRefOut
  role: string
  store_id: number | null
  date_from: string
  date_to: string
  charged: SalesBucketOut | null
  shifts_as_responsible: RecordShiftRowOut[]
  attendance: RecordAttendanceOut[]
  voids: RecordVoidOut[]
  discounts: RecordDiscountOut[]
}

export interface RecordRange {
  from?: string
  to?: string
}

export function getEmployeeRecord(employeeId: number, storeId: number, range: RecordRange = {}): Promise<EmployeeRecordOut> {
  return api<EmployeeRecordOut>(`/admin/records/employee/${employeeId}`, {
    query: { store_id: storeId, from: range.from, to: range.to },
  })
}

export interface IngredientCauseTotalOut {
  cause: string
  movements: number
  qty: string
}

export interface IngredientCountLineOut {
  count_id: number
  area_name: string
  moment: string
  counted_at: string
  employee_name: string
  qty: string
}

export interface IngredientRecordOut {
  ingredient_id: number
  name: string
  base_unit: string
  active: boolean
  store_id: number
  date_from: string
  date_to: string
  stock: string | null
  by_cause: IngredientCauseTotalOut[]
  area_counts: IngredientCountLineOut[]
  /** «¿Cuándo se me acaba?»: stock al cierre, 14 días + 7 proyectados, contra el mínimo. */
  stock_by_day?: StockByDaySeriesOut | null
}

/** Cantidades en texto decimal de la unidad base, como el resto de la API. */
export interface StockDayPointOut {
  key: string
  label: string
  business_date: string
  qty: string | null
  outside: boolean
  future: boolean
  now: boolean
}

export interface StockByDaySeriesOut {
  available: boolean
  reason: string | null
  bad_side: SeriesBadSide
  base_unit: string
  min_stock: string
  daily_use: string | null
  points: StockDayPointOut[]
  below_min_on: string | null
  runs_out_on: string | null
}

export function getIngredientRecord(ingredientId: number, range: RecordRange = {}): Promise<IngredientRecordOut> {
  return api<IngredientRecordOut>(`/admin/records/ingredient/${ingredientId}`, {
    query: { from: range.from, to: range.to },
  })
}
