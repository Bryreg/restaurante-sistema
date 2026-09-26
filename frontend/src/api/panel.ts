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
import type { SalesBucketOut } from "@/api/reports"

/** Espejo de `PanelLevelLiteral` (`app/reports/schemas.py`). */
export type PanelLevel = "critical" | "warning" | "info"
/** Espejo de `PanelLightLiteral` (`app/reports/schemas.py`). */
export type PanelLight = "red" | "amber" | "green"

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
}

export interface PanelStaffOut {
  clocked_in: PanelStaffPersonOut[]
  identified_only: PanelStaffPersonOut[]
  reason: string | null
}

export interface PanelAreaCountsOut {
  enabled: boolean
  areas_total: number
  opening_done: number
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
  cash: PanelCashOut | null
  staff: PanelStaffOut
  area_counts: PanelAreaCountsOut
  salon: PanelSalonOut
  kitchen: PanelKitchenOut
  pending: PanelPendingOut
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
  shift_id: number
  business_date: string | null
  employee_id: number
  employee_name: string
  in_at: string
  out_at: string | null
  clocked_in: boolean
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
  voids: RecordVoidOut[]
  discounts: RecordDiscountOut[]
  novelties: RecordNoveltyOut[]
  area_counts: RecordAreaCountOut[]
  attendance: RecordAttendanceOut[]
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
}

export function getIngredientRecord(ingredientId: number, range: RecordRange = {}): Promise<IngredientRecordOut> {
  return api<IngredientRecordOut>(`/admin/records/ingredient/${ingredientId}`, {
    query: { from: range.from, to: range.to },
  })
}
