/**
 * Gastos, obligaciones agendadas, punto de equilibrio y utilidad
 * (`features/fase-3-dinero-control/spec.md` § T2 `backend-obligaciones`,
 * contrato de API mínimo). Dominio `app.expenses` del backend.
 *
 * El contrato mínimo (spec.md § 2) sólo fija RUTAS; el resto de los campos
 * de este archivo se verificó por lectura directa de
 * `backend/app/expenses/schemas.py` ya escrito (categorías cerradas,
 * `ObligationStatusLiteral = "pending" | "paid"`, sin campo `recurring`) —
 * no adivinado. Igual que `api/reports.ts`, los campos que SÍ quedan
 * opcionales/`| null` son los que ese archivo no fija con un `Literal`
 * cerrado, para no romper si el backend agrega algo más.
 */

import { api } from "@/api/client"

// ---------------------------------------------------------------------------
// GET/POST /admin/expenses — gastos del período. `category`/`source` son
// enums cerrados (`app/expenses/schemas.py::ExpenseCategoryLiteral` /
// `ExpenseSourceLiteral`), nunca texto libre.
// ---------------------------------------------------------------------------

export type ExpenseCategory = "supplies" | "maintenance" | "utilities" | "marketing" | "transport" | "other"
/** De dónde salió la plata. `"cash_drawer"` exige `cash_movement_id` de un
 * movimiento YA registrado por `shifts` — esta pantalla no ofrece esa
 * opción (necesitaría un selector de movimientos de caja, fuera de este
 * territorio) y siempre manda `"other"`. Ver gaps del entregable. */
export type ExpenseSource = "cash_drawer" | "bank" | "other"

export interface ExpenseOut {
  id: number
  store_id?: number
  business_date?: string
  category: ExpenseCategory | string
  description?: string | null
  amount?: number
  source?: ExpenseSource | string
  created_by_employee_name?: string | null
  created_at?: string
  voided_at?: string | null
  voided_reason?: string | null
}

export interface ExpenseIn {
  business_date: string
  category: ExpenseCategory
  description: string
  amount: number
  source?: ExpenseSource
}

export interface PeriodQuery {
  storeId: number
  from: string
  to: string
}

export function getExpenses(params: PeriodQuery): Promise<ExpenseOut[]> {
  return api<ExpenseOut[]>("/admin/expenses", {
    query: { store_id: params.storeId, from: params.from, to: params.to },
  })
}

export function createExpense(storeId: number, data: ExpenseIn): Promise<ExpenseOut> {
  return api<ExpenseOut>("/admin/expenses", { method: "POST", query: { store_id: storeId }, body: data })
}

// ---------------------------------------------------------------------------
// GET/POST /admin/obligations — obligaciones agendadas (arriendo, servicios,
// impuestos), con `due_date` y `status`. `status` es `"pending" | "paid"`
// (`ObligationStatusLiteral`) — no existe un tercer valor `"cancelled"`: una
// obligación cancelada sigue `status="pending"` y lleva `cancelled_at` +
// `cancelled_reason` propios (mismo patrón que "anulado" en pagos).
// ---------------------------------------------------------------------------

export type ObligationCategory = "rent" | "utilities" | "taxes" | "other"
export type ObligationStatus = "pending" | "paid"

export interface ObligationOut {
  id: number
  store_id?: number
  description?: string
  category: ObligationCategory | string
  due_date: string
  amount?: number
  status: ObligationStatus | string
  overdue?: boolean
  settled_at?: string | null
  settled_by_employee_name?: string | null
  cancelled_at?: string | null
  cancelled_reason?: string | null
}

export interface ObligationIn {
  description: string
  category: ObligationCategory
  due_date: string
  amount: number
}

export interface ObligationsQuery {
  storeId: number
  status?: ObligationStatus
  from?: string
  to?: string
}

export function getObligations(params: ObligationsQuery): Promise<ObligationOut[]> {
  return api<ObligationOut[]>("/admin/obligations", {
    query: { store_id: params.storeId, status: params.status, from: params.from, to: params.to },
  })
}

export function createObligation(storeId: number, data: ObligationIn): Promise<ObligationOut> {
  return api<ObligationOut>("/admin/obligations", { method: "POST", query: { store_id: storeId }, body: data })
}

export interface ObligationSettleIn {
  /** Mismo criterio que `ExpenseIn.source`: siempre `"other"` desde esta
   * pantalla, nunca `"cash_drawer"` (necesitaría un `cash_movement_id` que
   * esta pantalla no puede elegir). */
  source?: ExpenseSource
  note?: string | null
}

export function settleObligation(
  id: number,
  data: ObligationSettleIn,
  idempotencyKey: string,
): Promise<ObligationOut> {
  return api<ObligationOut>(`/admin/obligations/${id}/settle`, { method: "POST", body: data, idempotencyKey })
}

// ---------------------------------------------------------------------------
// GET/PATCH /admin/expenses/settings — los costos fijos de la sede.
//
// Es la PUERTA DE ENTRADA del punto de equilibrio: sin esto cargado,
// `GET /admin/break-even` responde `available: false` para siempre y el motivo
// que devuelve le nombra al dueño una ruta de API que no puede abrir. Las dos
// rutas existían desde la construcción de la fase; lo que faltaba era la
// pantalla (hallazgo A-1 de la ENTREGA).
// ---------------------------------------------------------------------------

export interface ExpensesSettingsOut {
  store_id: number
  /** @deprecated Ya no entra al punto de equilibrio: los costos fijos se
   * calculan solos (obligaciones + nómina + gastos del período). Se guarda
   * y se lee, pero nada lo suma. */
  fixed_costs: number | null
  updated_at: string | null
}

export function getExpensesSettings(storeId: number): Promise<ExpensesSettingsOut> {
  return api<ExpensesSettingsOut>("/admin/expenses/settings", { query: { store_id: storeId } })
}

export function updateExpensesSettings(
  storeId: number,
  data: { fixed_costs: number | null },
): Promise<ExpensesSettingsOut> {
  return api<ExpensesSettingsOut>("/admin/expenses/settings", {
    method: "PATCH",
    query: { store_id: storeId },
    body: data,
  })
}

// ---------------------------------------------------------------------------
// GET /admin/break-even — punto de equilibrio del período.
// ---------------------------------------------------------------------------

/** Un renglón de los costos fijos del período, en pesos. `source`: de qué
 * registro sale (obligaciones por vencimiento, nómina del período, gastos no
 * anulados). Sólo llegan renglones con plata. */
export interface FixedCostLine {
  label: string
  amount: number
  source: "obligations" | "payroll" | "expenses"
}

export interface BreakEvenOut {
  store_id?: number
  date_from?: string
  date_to?: string
  /** Costos fijos AUTOMÁTICOS del período (obligaciones + nómina + gastos).
   * `null` sólo si la nómina no se puede calcular (motivo en `reason`). */
  fixed_costs: number | null
  fixed_costs_source?: "automatic"
  fixed_costs_breakdown?: FixedCostLine[]
  /** Ventas netas del período (pesos, sin impuesto ni propina). */
  net_sales?: number
  /** Por ciento ENTERO (0-100) de la venta neta con costo teórico; `null` sin venta. */
  costed_pct?: number | null
  /** Mínimo de `costed_pct` para confiar en el margen (95). Por debajo, margen y equilibrio son `null` con motivo. */
  costed_pct_min?: number
  contribution_margin_pct_bp: number | null
  break_even_amount: number | null
  /** Ventas netas / equilibrio, en puntos básicos (puede pasar de 10.000). */
  progress_bp?: number | null
  /** Lo que falta vender para el equilibrio, en pesos; 0 si ya se pasó, nunca negativo. */
  gap_amount?: number | null
  /** Días que faltan al ritmo diario de lo transcurrido del período (hacia
   * arriba). 0 si ya se pasó; `null` sin equilibrio, sin ventas, o si el
   * período ya terminó o no empezó. */
  days_to_break_even_at_current_pace?: number | null
  /** Días transcurridos del período (hoy incluido); `null` fuera del período. */
  days_elapsed?: number | null
  days_in_period?: number
  available: boolean
  reason: string | null
}

export function getBreakEven(params: PeriodQuery): Promise<BreakEvenOut> {
  return api<BreakEvenOut>("/admin/break-even", {
    query: { store_id: params.storeId, from: params.from, to: params.to },
  })
}

// ---------------------------------------------------------------------------
// GET /admin/profit — resultado del período (ventas netas, costo, gastos,
// obligaciones, nómina, `profit`).
// ---------------------------------------------------------------------------

/** Un renglón del estado de resultados. `pct_of_sales_bp` = `amount / net_sales`
 * en puntos básicos, con signo; `null` sin venta neta o sin `amount`. */
export interface ProfitLine {
  key: "net_sales" | "cost" | "expenses" | "obligations" | "payroll" | "profit"
  label: string
  amount: number | null
  pct_of_sales_bp: number | null
}

/** Un período de la utilidad. Usa EXACTAMENTE los mismos costos fijos que
 * `BreakEvenOut` (mismo `fixed_costs`/`fixed_costs_breakdown`). */
export interface ProfitPeriodOut {
  date_from?: string
  date_to?: string
  net_sales: number | null
  cost: number | null
  expenses: number | null
  obligations: number | null
  payroll: number | null
  payroll_reason?: string | null
  fixed_costs?: number | null
  fixed_costs_breakdown?: FixedCostLine[]
  /** Por ciento ENTERO (0-100) de la venta neta con costo teórico. */
  costed_pct?: number | null
  profit: number | null
  /** En orden: ventas, costo, nómina, obligaciones, gastos, utilidad. */
  lines?: ProfitLine[]
  available: boolean
  reason: string | null
}

export interface ProfitOut extends ProfitPeriodOut {
  store_id?: number
  costed_pct_min?: number
  /** El período inmediatamente anterior, de la misma cantidad de días. */
  previous_period?: ProfitPeriodOut | null
}

export function getProfit(params: PeriodQuery): Promise<ProfitOut> {
  return api<ProfitOut>("/admin/profit", {
    query: { store_id: params.storeId, from: params.from, to: params.to },
  })
}

// ---------------------------------------------------------------------------
// D-2 — GET /admin/payables/{id} y POST /admin/payables/{id}/approve.
// El mismo patrón de `confirm_price` en recepciones (`ReceptionForm.tsx`,
// territorio de `features/purchases`, sólo copiado acá, no importado): sin
// `confirm_discrepancy` y con diferencia, el servidor corta con
// `409 INVOICE_DISCREPANCY`.
// ---------------------------------------------------------------------------

export type PayableStatus = "pending_review" | "approved" | "cancelled"

export interface PayableDetailOut {
  id: number
  store_id?: number
  supplier_id?: number
  reception_id?: number
  /** Cifra calculada (línea por línea) — nunca cambia de significado por D-2. */
  amount: number
  balance?: number
  status: PayableStatus | string
  due_date?: string
  overdue?: boolean
  approved_at?: string | null
  approved_by_employee_name?: string | null
  business_date?: string
  /** D-2: lo que dice el papel. `null` si la recepción fue `no_invoice`. */
  invoice_total: number | null
  /** D-2: `invoice_total − amount`, derivado por el servidor. `null` si no hay `invoice_total`. */
  invoice_discrepancy: number | null
}

export function getPayableDetail(payableId: number): Promise<PayableDetailOut> {
  return api<PayableDetailOut>(`/admin/payables/${payableId}`)
}

export interface PayableApproveIn {
  authorizer_pin: string
  /** Explícito y nunca `true` de entrada — sólo tras mostrar las dos cifras al administrador. */
  confirm_discrepancy?: boolean
}

export function approvePayable(payableId: number, data: PayableApproveIn): Promise<PayableDetailOut> {
  return api<PayableDetailOut>(`/admin/payables/${payableId}/approve`, { method: "POST", body: data })
}
