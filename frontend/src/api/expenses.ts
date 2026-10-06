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
 * movimiento YA registrado por `shifts` (ver `getDrawerExpenseMovements`). */
export type ExpenseSource = "cash_drawer" | "bank" | "owner_hand" | "other"

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
// impuestos), con `due_date` y `status`. `status` es `"pending" | "partial" |
// "paid"` (`ObligationStatusLiteral`), DERIVADO de los abonos vivos — no
// existe `"cancelled"`: una cancelada lleva `cancelled_at` + `cancelled_reason`
// propios. `paid_amount`/`pending_amount` los calcula el servidor (c5).
// ---------------------------------------------------------------------------

/** Las que se cargan a mano y en plantillas (`ObligationCategoryLiteral`). */
export type ObligationCategory = "rent" | "utilities" | "taxes" | "other"
/** Las que puede traer la salida (`ObligationCategoryOutLiteral`): nómina e
 * INC sólo nacen por sus puertas propias y no son costo fijo. */
export type ObligationCategoryOut = "rent" | "utilities" | "taxes" | "other" | "payroll" | "consumption_tax"
export type ObligationStatus = "pending" | "partial" | "paid"

export interface ObligationOut {
  id: number
  store_id?: number
  description?: string
  category: ObligationCategoryOut | string
  due_date: string
  amount?: number
  status: ObligationStatus | string
  /** Suma de los abonos vivos y lo que falta, calculados por el servidor. */
  paid_amount?: number
  pending_amount?: number
  overdue?: boolean
  settled_at?: string | null
  settled_by_employee_name?: string | null
  settled_source?: ExpenseSource | string | null
  cash_movement_id?: number | null
  cancelled_at?: string | null
  cancelled_reason?: string | null
  template_id?: number | null
  period_month?: string | null
  payroll_run_id?: number | null
  tax_year?: number | null
  tax_bimester?: number | null
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
  /** De dónde salió la plata (`app/expenses/schemas.py::ObligationSettleIn`).
   * `"cash_drawer"` exige `cash_movement_id`: el egreso del cajón que el
   * turno YA registró (se elige de `getDrawerExpenseMovements`). Igual que
   * un gasto: el backend sólo lo referencia, nunca saca la plata otra vez. */
  source: ExpenseSource
  cash_movement_id?: number | null
  note?: string | null
}

/** `GET /admin/expenses/drawer-movements` — los egresos del cajón (gasto
 * menor, compra de emergencia, otro egreso) de los últimos 30 días que
 * todavía no respaldan ningún gasto ni obligación. */
export interface DrawerExpenseMovementOut {
  id: number
  shift_id: number
  cause: "petty_expense" | "emergency_purchase" | "other_expense" | string
  amount: number
  note: string | null
  employee_name: string
  at: string
}

export function getDrawerExpenseMovements(storeId: number): Promise<DrawerExpenseMovementOut[]> {
  return api<DrawerExpenseMovementOut[]>("/admin/expenses/drawer-movements", { query: { store_id: storeId } })
}

export function settleObligation(
  id: number,
  data: ObligationSettleIn,
  idempotencyKey: string,
): Promise<ObligationOut> {
  return api<ObligationOut>(`/admin/obligations/${id}/settle`, { method: "POST", body: data, idempotencyKey })
}

// ---------------------------------------------------------------------------
// c5 · Abonos: varios pagos por obligación, cada uno con su fuente. Nunca más
// de lo que falta (`400 OBLIGATION_OVERPAYMENT`). Se anulan con motivo.
// ---------------------------------------------------------------------------

export interface ObligationPaymentIn {
  amount: number
  paid_on?: string | null
  source: ExpenseSource
  cash_movement_id?: number | null
  note?: string | null
}

export interface ObligationPaymentOut {
  id: number
  obligation_id: number
  amount: number
  paid_on: string
  source: ExpenseSource | string
  cash_movement_id: number | null
  note: string | null
  created_by_employee_name: string
  created_at: string
  voided_at: string | null
  voided_reason: string | null
  voided_by_employee_name: string | null
}

export function getObligationPayments(id: number): Promise<ObligationPaymentOut[]> {
  return api<ObligationPaymentOut[]>(`/admin/obligations/${id}/payments`)
}

export function addObligationPayment(
  id: number,
  data: ObligationPaymentIn,
  idempotencyKey: string,
): Promise<ObligationOut> {
  return api<ObligationOut>(`/admin/obligations/${id}/payments`, { method: "POST", body: data, idempotencyKey })
}

export function voidObligationPayment(
  id: number,
  paymentId: number,
  reason: string,
  idempotencyKey: string,
): Promise<ObligationOut> {
  return api<ObligationOut>(`/admin/obligations/${id}/payments/${paymentId}/void`, {
    method: "POST",
    body: { reason },
    idempotencyKey,
  })
}

// ---------------------------------------------------------------------------
// c5 · Agenda de vencimientos: lo que vence de hoy a `days` días más todo lo
// vencido con saldo. Totales de saldo, del servidor.
// ---------------------------------------------------------------------------

export interface MonthPlanLine {
  template_id: number
  description: string
  category: ObligationCategory | string
  amount: number
  due_date: string
  period_month: string
  obligation_id: number | null
  cancelled: boolean
}

export interface AgendaItem {
  obligation_id: number
  description: string
  category: ObligationCategoryOut | string
  due_date: string
  amount: number
  paid_amount: number
  pending_amount: number
  status: ObligationStatus | string
  overdue: boolean
  /** Negativo si ya venció. */
  days_until_due: number
}

export interface AgendaOut {
  store_id: number
  today: string
  days: number
  horizon: string
  items: AgendaItem[]
  overdue_count: number
  overdue_total: number
  upcoming_total: number
  total_pending: number
  /** Copias de recurrentes que vencen en la ventana y todavía no se armaron. */
  not_generated: MonthPlanLine[]
}

export function getAgenda(storeId: number, days: number): Promise<AgendaOut> {
  return api<AgendaOut>("/admin/obligations/agenda", { query: { store_id: storeId, days: days } })
}

// ---------------------------------------------------------------------------
// c5 · Obligaciones recurrentes y «armar el mes».
// ---------------------------------------------------------------------------

export interface ObligationTemplateOut {
  id: number
  store_id: number
  category: ObligationCategory | string
  description: string
  amount: number
  /** 1 = mensual, 2 = bimestral, N = cada N meses. */
  interval_months: number
  due_day: number
  start_month: string
  active: boolean
  created_by_employee_name: string
  created_at: string
  updated_at: string | null
  deactivated_at: string | null
  deactivated_reason: string | null
}

export interface ObligationTemplateIn {
  category: ObligationCategory
  description: string
  amount: number
  interval_months: number
  due_day: number
  start_month: string
}

export function getObligationTemplates(storeId: number): Promise<ObligationTemplateOut[]> {
  return api<ObligationTemplateOut[]>("/admin/obligation-templates", { query: { store_id: storeId } })
}

export function createObligationTemplate(
  storeId: number,
  data: ObligationTemplateIn,
  idempotencyKey: string,
): Promise<ObligationTemplateOut> {
  return api<ObligationTemplateOut>("/admin/obligation-templates", {
    method: "POST",
    query: { store_id: storeId },
    body: data,
    idempotencyKey,
  })
}

export function deactivateObligationTemplate(
  id: number,
  reason: string,
  idempotencyKey: string,
): Promise<ObligationTemplateOut> {
  return api<ObligationTemplateOut>(`/admin/obligation-templates/${id}/deactivate`, {
    method: "POST",
    body: { reason },
    idempotencyKey,
  })
}

export interface MonthPlanOut {
  store_id: number
  year: number
  month: number
  period_month: string
  active_templates: number
  to_create: MonthPlanLine[]
  to_create_total: number
  already_generated: MonthPlanLine[]
}

export function getMonthPlan(storeId: number, year: number, month: number): Promise<MonthPlanOut> {
  return api<MonthPlanOut>("/admin/obligations/month-plan", { query: { store_id: storeId, year: year, month: month } })
}

export interface GenerateMonthOut {
  year: number
  month: number
  created: ObligationOut[]
  already_generated: MonthPlanLine[]
}

export function generateMonth(
  storeId: number,
  year: number,
  month: number,
  idempotencyKey: string,
): Promise<GenerateMonthOut> {
  return api<GenerateMonthOut>("/admin/obligations/generate-month", {
    method: "POST",
    query: { store_id: storeId },
    body: { year, month },
    idempotencyKey,
  })
}

// ---------------------------------------------------------------------------
// c5 · INC del bimestre (leído del informe del contador) y nómina agendada.
// ---------------------------------------------------------------------------

export interface ConsumptionTaxOut {
  store_id: number
  year: number
  bimester: number
  label: string
  date_from: string
  date_to: string
  closed: boolean
  documents: number
  rates: { rate: number; base: number; tax: number }[]
  base: number | null
  /** Lo COBRADO de INC (8 %); `null` sin ventas, con `reason`. */
  tax_amount: number | null
  reason: string | null
  due_day: number
  due_day_is_default: boolean
  due_date: string
  scheduled: ObligationOut | null
}

export function getConsumptionTax(storeId: number, year?: number, bimester?: number): Promise<ConsumptionTaxOut> {
  return api<ConsumptionTaxOut>("/admin/obligations/consumption-tax", {
    query: { store_id: storeId, year: year, bimester: bimester },
  })
}

export interface ScheduledObligationOut {
  obligation: ObligationOut
  already_existed: boolean
}

export function scheduleConsumptionTax(
  storeId: number,
  data: { year: number; bimester: number; amount?: number | null; due_date?: string | null },
  idempotencyKey: string,
): Promise<ScheduledObligationOut> {
  return api<ScheduledObligationOut>("/admin/obligations/consumption-tax/schedule", {
    method: "POST",
    query: { store_id: storeId },
    body: data,
    idempotencyKey,
  })
}

export interface ObligationSettingsOut {
  store_id: number
  consumption_tax_due_day: number | null
  default_consumption_tax_due_day: number
  effective_consumption_tax_due_day: number
}

export function getObligationSettings(storeId: number): Promise<ObligationSettingsOut> {
  return api<ObligationSettingsOut>("/admin/obligations/settings", { query: { store_id: storeId } })
}

export function putObligationSettings(
  storeId: number,
  data: { consumption_tax_due_day: number | null },
  idempotencyKey: string,
): Promise<ObligationSettingsOut> {
  return api<ObligationSettingsOut>("/admin/obligations/settings", {
    method: "PUT",
    query: { store_id: storeId },
    body: data,
    idempotencyKey,
  })
}

export interface PayrollRunCandidate {
  payroll_run_id: number
  date_from: string
  date_to: string
  amount: number | null
  amount_source: "employer_total" | "total" | null
  computed_at: string
  scheduled_obligation_id: number | null
}

export function getPayrollRunCandidates(storeId: number): Promise<PayrollRunCandidate[]> {
  return api<PayrollRunCandidate[]>("/admin/obligations/payroll-runs", { query: { store_id: storeId } })
}

export function schedulePayroll(
  storeId: number,
  data: { payroll_run_id: number; due_date?: string | null; amount?: number | null },
  idempotencyKey: string,
): Promise<ScheduledObligationOut> {
  return api<ScheduledObligationOut>("/admin/obligations/payroll/schedule", {
    method: "POST",
    query: { store_id: storeId },
    body: data,
    idempotencyKey,
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
  // h12: el costo REAL (teórico + varianza de inventario) al lado del
  // teórico. La utilidad (`profit`) usa el de `profit_cost_basis`.
  cost_real?: number | null
  cost_real_reason?: string | null
  inventory_variance?: number | null
  cost_difference?: number | null
  variance_days_covered?: number
  days_in_period?: number
  profit_cost_basis?: CostBasis
  profit_with_real_cost?: number | null
}

/** Qué costo de lo vendido se usó (mismo literal que `app/expenses/schemas.py`). */
export type CostBasis = "theoretical" | "real"

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
// h7 — Estado de resultados de 12 meses con presupuesto por renglón
// (`GET /admin/profit/monthly`, `PUT /admin/profit/budget`).
// ---------------------------------------------------------------------------

export type PnlLine = "net_sales" | "cost" | "payroll" | "obligations" | "expenses" | "profit"
export type PnlBudgetLine = "net_sales" | "cost" | "payroll" | "obligations" | "expenses"

export interface PnlCellOut {
  amount: number | null
  budget: number | null
  /** Real − presupuesto. */
  variance: number | null
  variance_bp: number | null
  /** Del lado malo (vender menos, gastar más): lo decide el servidor. */
  outside: boolean | null
}

export interface PnlRowOut {
  key: PnlLine
  label: string
  budgetable: boolean
  cells: PnlCellOut[]
  total: PnlCellOut
}

export interface PnlMonthOut {
  year: number
  month: number
  label: string
  date_from: string
  date_to: string
  in_progress: boolean
  available: boolean
  reason: string | null
  cost_basis: CostBasis
  cost_real: number | null
  cost_real_reason: string | null
  profit_with_real_cost: number | null
}

export interface PnlOut {
  store_id: number
  months: PnlMonthOut[]
  rows: PnlRowOut[]
}

export function getMonthlyPnl(params: { storeId: number; year: number; month: number }): Promise<PnlOut> {
  return api<PnlOut>("/admin/profit/monthly", {
    query: { store_id: params.storeId, year: params.year, month: params.month },
  })
}

export interface PnlBudgetIn {
  year: number
  month: number
  line: PnlBudgetLine
  /** `null` borra el presupuesto de ese renglón en ese mes. */
  amount: number | null
}

export interface PnlBudgetOut extends PnlBudgetIn {
  store_id: number
}

export function putPnlBudget(storeId: number, body: PnlBudgetIn): Promise<PnlBudgetOut> {
  return api<PnlBudgetOut>("/admin/profit/budget", { method: "PUT", query: { store_id: storeId }, body })
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
