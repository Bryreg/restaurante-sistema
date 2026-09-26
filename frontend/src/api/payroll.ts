/**
 * Jornada, tablas de recargos, liquidación de nómina y reparto de propinas
 * (`features/fase-3-dinero-control/spec.md` § T3 `backend-nomina-propinas`,
 * contrato de API mínimo, y D-3). Dominio `app.payroll` del backend.
 *
 * El contrato mínimo (spec.md § 2) sólo fija RUTAS; el resto de los campos
 * de este archivo se verificó por lectura directa de
 * `backend/app/payroll/schemas.py` ya escrito — no adivinado (`night_start_
 * hour`/`night_end_hour`/`night_surcharge_bp`/`sunday_holiday_surcharge_bp`/
 * `overtime_surcharge_bp`/`weekly_ordinary_hours` en vez de los cuatro
 * `*_pct_bp` que este archivo asumía en su primera versión). Los campos que
 * ese archivo no fija con un tipo cerrado quedan opcionales/`| null`.
 *
 * **Las horas no son pesos.** Igual que las cantidades de insumo
 * (`api/inventory.ts`), viajan como texto decimal ya formateado por el
 * servidor — este archivo nunca las multiplica, divide ni redondea.
 *
 * `POST /admin/tips/payouts` **ya existe** desde 1b-2
 * (`app/shifts/tips.py::register_tip_payout`, `app/shifts/router.py`): es el
 * "confirmar" del reparto de propinas (D-3), y este archivo lo tipa contra
 * ese contrato ya publicado (`TipPayoutIn`/`TipPayoutOut` de
 * `app/shifts/schemas.py`), no contra uno nuevo.
 */

import { api } from "@/api/client"

export interface PeriodQuery {
  storeId: number
  from: string
  to: string
}

// ---------------------------------------------------------------------------
// GET /admin/payroll/hours — jornada por persona del período.
// ---------------------------------------------------------------------------

export interface PayrollHoursRowOut {
  employee_id: number
  employee_name?: string | null
  /** Texto decimal de horas (mismo criterio que `qty_base`), nunca un número que este cliente reescale. */
  ordinary_hours?: string | null
  night_hours?: string | null
  sunday_hours?: string | null
  holiday_hours?: string | null
  /** `app/payroll/schemas.py::HoursRowOut.overtime_hours` — no "extra_hours". */
  overtime_hours?: string | null
}

export interface PayrollHoursOut {
  store_id?: number
  date_from?: string
  date_to?: string
  available: boolean
  reason: string | null
  rows?: PayrollHoursRowOut[]
  /** Salidas olvidadas del período: sus horas NO están en `rows` hasta que se corrijan. */
  pending_review?: PayrollPendingExitOut[]
}

export interface PayrollPendingExitOut {
  attendance_id: number
  employee_id: number
  employee_name: string
  business_date: string
  in_at: string
}

export function getPayrollHours(params: PeriodQuery): Promise<PayrollHoursOut> {
  return api<PayrollHoursOut>("/admin/payroll/hours", {
    query: { store_id: params.storeId, from: params.from, to: params.to },
  })
}

// ---------------------------------------------------------------------------
// GET/POST /admin/payroll/surcharge-tables — tablas de recargos con vigencia.
// Nunca quemadas en código (§7): una tabla vieja tiene que poder recalcular
// un período viejo con las tablas que regían ese mes.
// ---------------------------------------------------------------------------

export interface SurchargeTableOut {
  id: number
  valid_from: string
  night_start_hour: number
  night_end_hour: number
  /** Puntos básicos (100 = 1 %). */
  night_surcharge_bp: number
  /** Un solo recargo para dominical Y festivo (Ley 2466 de 2025: 80/90/100 % según el año). */
  sunday_holiday_surcharge_bp: number
  overtime_surcharge_bp: number
  /** Jornada semanal ordinaria en horas enteras (42 h desde jul-2026, Ley 2101 de 2021). */
  weekly_ordinary_hours: number
  /** A-4: `false` = la sembró la migración y **nadie con la norma adelante la
   * revisó**. Los valores son editables sin tocar código, pero hasta que
   * alguien los confirme son un supuesto, y eso tiene que verse. */
  confirmed_by_person?: boolean
  confirmed_by_name?: string | null
  created_at?: string
}

export interface SurchargeTableIn {
  valid_from: string
  night_start_hour: number
  night_end_hour: number
  night_surcharge_bp: number
  sunday_holiday_surcharge_bp: number
  overtime_surcharge_bp: number
  weekly_ordinary_hours: number
}

export function getSurchargeTables(storeId: number): Promise<SurchargeTableOut[]> {
  return api<SurchargeTableOut[]>("/admin/payroll/surcharge-tables", { query: { store_id: storeId } })
}

export function createSurchargeTable(storeId: number, data: SurchargeTableIn): Promise<SurchargeTableOut> {
  return api<SurchargeTableOut>("/admin/payroll/surcharge-tables", {
    method: "POST",
    query: { store_id: storeId },
    body: data,
  })
}

// ---------------------------------------------------------------------------
// GET/POST /admin/payroll/runs — liquidación del período. La respuesta
// nombra qué tabla(s) vigente(s) usó (pantalla obligada a mostrarlo).
// ---------------------------------------------------------------------------

/** `app/payroll/schemas.py::SurchargeTableUsedOut` — la tabla vigente que
 * una liquidación usó, con sus valores (no sólo un id o una fecha). Una
 * liquidación puede cruzar más de una vigencia si el período abarca un
 * cambio de tabla — por eso `PayrollRunOut.tables_used` es una LISTA. */
export interface SurchargeTableUsedOut {
  /** A-4: si la liquidación se calculó con una tabla sin confirmar, lo dice. */
  confirmed_by_person?: boolean
  valid_from: string
  night_start_hour: number
  night_end_hour: number
  night_surcharge_bp: number
  sunday_holiday_surcharge_bp: number
  overtime_surcharge_bp: number
  weekly_ordinary_hours: number
}

export interface PayrollRunLineOut {
  employee_id: number
  employee_name?: string | null
  ordinary_minutes?: number | null
  night_minutes?: number | null
  sunday_minutes?: number | null
  holiday_minutes?: number | null
  overtime_minutes?: number | null
  base_pay: number | null
  night_surcharge: number | null
  sunday_holiday_surcharge: number | null
  overtime_pay: number | null
  total: number | null
  /** `null` con este motivo cuando la línea no se pudo liquidar (p. ej. sin tarifa por hora cargada). */
  pay_reason: string | null
}

/** A-5: cómo se calculó una liquidación. Espejo de
 * `app/payroll/schemas.py::PayrollCalculationMethodLiteral`. */
export type PayrollCalculationMethod = "additive_surcharges"

/** Informe de visualización #14: la liquidación en contexto. Todo lo calcula
 * el backend; `null` va con su motivo en `payroll_pct_reason` /
 * `previous_reason`. */
export interface PayrollRunComparison {
  /** Ventas netas del MISMO período (pesos, sin impuesto ni propina). */
  net_sales?: number | null
  /** `total_amount / net_sales`, en puntos básicos (10.000 = 100 %). */
  payroll_pct_of_sales_bp?: number | null
  payroll_pct_reason?: string | null
  /** La liquidación más reciente cuyo período termina antes de éste. */
  previous_run_id?: number | null
  previous_date_from?: string | null
  previous_date_to?: string | null
  previous_total?: number | null
  /** (total − anterior) / anterior, en puntos básicos, con signo. */
  delta_bp?: number | null
  previous_reason?: string | null
}

export interface PayrollRunOut extends PayrollRunComparison {
  id: number
  /** A-5: `additive_surcharges` paga base + recargos de forma aditiva e
   * independiente. Es auditable recargo por recargo y sirve para control
   * interno, pero **no es la liquidación legal** (el CST los combina en ocho
   * categorías). La pantalla lo dice; nadie debería pagar con esta cifra
   * creyendo que es la legal. */
  calculation_method?: PayrollCalculationMethod
  store_id?: number
  date_from?: string
  date_to?: string
  /** Las tablas de recargos vigentes que usó esta liquidación — obligatorio mostrarlo en pantalla (spec.md § T3). */
  tables_used?: SurchargeTableUsedOut[]
  lines?: PayrollRunLineOut[]
  total_amount: number | null
  available: boolean
  reason: string | null
  computed_at?: string
  computed_by_employee_name?: string | null
}

export interface PayrollRunIn {
  date_from: string
  date_to: string
}

/**
 * Fila del LISTADO. `GET /admin/payroll/runs` devuelve `PayrollRunSummaryOut`,
 * que **no trae `lines` ni `tables_used`** (su docstring en
 * `app/payroll/schemas.py` lo dice). Tiparlo como el detalle fue el hallazgo
 * A-1: la pantalla pintaba el detalle desde la fila del listado y afirmaba
 * «esta liquidación no informó qué tabla de recargos usó» cuando el backend
 * sí las informa — en `GET /admin/payroll/runs/{id}`.
 */
export interface PayrollRunSummaryOut extends PayrollRunComparison {
  id: number
  store_id?: number
  date_from?: string
  date_to?: string
  total_amount: number | null
  available: boolean
  reason: string | null
  computed_at?: string
}

export function getPayrollRuns(params: PeriodQuery): Promise<PayrollRunSummaryOut[]> {
  return api<PayrollRunSummaryOut[]>("/admin/payroll/runs", {
    query: { store_id: params.storeId, from: params.from, to: params.to },
  })
}

/** El detalle: acá sí viven `lines` y `tables_used`. */
export function getPayrollRun(runId: number): Promise<PayrollRunOut> {
  return api<PayrollRunOut>(`/admin/payroll/runs/${runId}`)
}

export function createPayrollRun(storeId: number, data: PayrollRunIn): Promise<PayrollRunOut> {
  return api<PayrollRunOut>("/admin/payroll/runs", { method: "POST", query: { store_id: storeId }, body: data })
}

// ---------------------------------------------------------------------------
// Tarifas, festivos y áreas — las tres PUERTAS DE ENTRADA que la fase
// construyó y que ninguna pantalla consumía (hallazgo A-1).
//
// Sin tarifa por hora, `POST /admin/payroll/runs` liquida con
// `total_amount: null`; sin festivos, la columna «festivas» es siempre cero;
// sin áreas, el reparto de propinas `by_area` no tiene con qué agrupar. Y la
// tarifa arrastra además a `GET /admin/profit`, que es el objetivo textual de
// la fase.
// ---------------------------------------------------------------------------

export interface WageRateOut {
  id: number
  store_id: number
  employee_id: number
  employee_name: string
  hourly_wage_pesos: number
  valid_from: string
  created_at: string
}

export interface WageRateIn {
  employee_id: number
  hourly_wage_pesos: number
  valid_from: string
}

export function getWages(storeId: number): Promise<WageRateOut[]> {
  return api<WageRateOut[]>("/admin/payroll/wages", { query: { store_id: storeId } })
}

export function createWage(
  storeId: number,
  data: WageRateIn,
  idempotencyKey: string,
): Promise<WageRateOut> {
  // Las escrituras de `payroll` pasan por `run_idempotent`: sin el encabezado
  // responden `400 IDEMPOTENCY_KEY_REQUIRED`. Lo encontró el recorrido en
  // navegador — ningún test lo vio porque los tests llaman al cliente con el
  // mock puesto, no al backend real.
  return api<WageRateOut>("/admin/payroll/wages", {
    method: "POST",
    query: { store_id: storeId },
    body: data,
    idempotencyKey,
  })
}

export interface HolidayOut {
  id: number
  store_id: number
  holiday_date: string
  name: string
}

export interface HolidayIn {
  holiday_date: string
  name: string
}

export function getHolidays(storeId: number): Promise<HolidayOut[]> {
  return api<HolidayOut[]>("/admin/payroll/holidays", { query: { store_id: storeId } })
}

export function createHoliday(
  storeId: number,
  data: HolidayIn,
  idempotencyKey: string,
): Promise<HolidayOut> {
  return api<HolidayOut>("/admin/payroll/holidays", {
    method: "POST",
    query: { store_id: storeId },
    body: data,
    idempotencyKey,
  })
}

export interface AreaAssignmentOut {
  employee_id: number
  employee_name: string
  area: string
  updated_at: string
}

export interface AreaAssignmentIn {
  employee_id: number
  area: string
}

export function getAreas(storeId: number): Promise<AreaAssignmentOut[]> {
  return api<AreaAssignmentOut[]>("/admin/payroll/areas", { query: { store_id: storeId } })
}

export function setArea(
  storeId: number,
  data: AreaAssignmentIn,
  idempotencyKey: string,
): Promise<AreaAssignmentOut> {
  return api<AreaAssignmentOut>("/admin/payroll/areas", {
    method: "POST",
    query: { store_id: storeId },
    body: data,
    idempotencyKey,
  })
}

// ---------------------------------------------------------------------------
// D-3 — reparto de propinas: propuesta (nueva, nunca mueve plata) + confirmar
// (ya existe, `app/shifts/tips.py`) + método por sede.
// ---------------------------------------------------------------------------

export type TipDistributionMethod = "equal_shares" | "by_hours" | "by_area"

export interface TipProposalRowOut {
  employee_id: number
  employee_name?: string | null
  /** Base del cálculo tal como la nombra el servidor (p. ej. "8.5 h") — texto, no se reinterpreta. */
  basis?: string | null
  amount: number
}

export interface TipDistributionProposalOut {
  method: TipDistributionMethod | string
  rows: TipProposalRowOut[]
  total: number
  available: boolean
  reason: string | null
  /** Los turnos que cubre esta propuesta — confirmado por lectura directa de
   * `app/payroll/schemas.py::TipProposalOut.shift_ids`, necesario para
   * llamar a `POST /admin/tips/payouts`. */
  shift_ids?: number[]
}

export function getTipsDistributionProposal(params: PeriodQuery): Promise<TipDistributionProposalOut> {
  return api<TipDistributionProposalOut>("/admin/tips/distribution/proposal", {
    query: { store_id: params.storeId, from: params.from, to: params.to },
  })
}

/** Espejo de `app/shifts/schemas.py::TipPayoutDistributionIn`. */
export interface TipPayoutDistributionIn {
  employee_id: number
  amount: number
}

/** Espejo de `app/shifts/schemas.py::TipPayoutIn` — el "confirmar" ya
 * publicado desde 1b-2, `POST /admin/tips/payouts` (`app/shifts/router.py`). */
export type TipPayoutMethod = "cash" | "card" | "transfer" | "other"

/** De dónde salió la plata de un reparto en efectivo (A-3). `unknown` sólo
 * aparece en filas anteriores a la columna: la API no lo acepta al crear. */
export type TipPayoutSource = "drawer" | "owner_hand" | "unknown"

export interface TipPayoutIn {
  shift_ids: number[]
  distribution: TipPayoutDistributionIn[]
  /** `<input type="datetime-local">` tal cual, sin zona — la pone el servidor. */
  paid_at: string
  method: TipPayoutMethod
  /** Sólo significa algo con `method: "cash"`. Un reparto pagado DEL CAJÓN ya
   * redujo el `to_deposit` de su turno; decirlo es lo que evita que la mano
   * del dueño reste la misma plata dos veces. */
  paid_from: Exclude<TipPayoutSource, "unknown">
}

export interface TipPayoutDistributionOut {
  employee_id: number
  employee_name: string
  amount: number
}

export interface TipPayoutOut {
  id: number
  shift_ids: number[]
  paid_at: string
  method: TipPayoutMethod
  paid_from: TipPayoutSource
  total_amount: number
  created_at: string
  distribution: TipPayoutDistributionOut[]
}

export function createTipPayout(storeId: number, data: TipPayoutIn, idempotencyKey: string): Promise<TipPayoutOut> {
  return api<TipPayoutOut>("/admin/tips/payouts", {
    method: "POST",
    query: { store_id: storeId },
    body: data,
    idempotencyKey,
  })
}

export interface TipsSettingsOut {
  method: TipDistributionMethod
}

export interface TipsSettingsIn {
  method: TipDistributionMethod
}

export function getTipsSettings(storeId: number): Promise<TipsSettingsOut> {
  return api<TipsSettingsOut>("/admin/tips/settings", { query: { store_id: storeId } })
}

export function updateTipsSettings(storeId: number, data: TipsSettingsIn): Promise<TipsSettingsOut> {
  return api<TipsSettingsOut>("/admin/tips/settings", { method: "PATCH", query: { store_id: storeId }, body: data })
}
