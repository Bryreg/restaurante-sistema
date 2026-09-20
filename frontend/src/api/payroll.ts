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

export interface PayrollRunOut {
  id: number
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

export function getPayrollRuns(params: PeriodQuery): Promise<PayrollRunOut[]> {
  return api<PayrollRunOut[]>("/admin/payroll/runs", {
    query: { store_id: params.storeId, from: params.from, to: params.to },
  })
}

export function createPayrollRun(storeId: number, data: PayrollRunIn): Promise<PayrollRunOut> {
  return api<PayrollRunOut>("/admin/payroll/runs", { method: "POST", query: { store_id: storeId }, body: data })
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
export interface TipPayoutIn {
  shift_ids: number[]
  distribution: TipPayoutDistributionIn[]
  /** `<input type="datetime-local">` tal cual, sin zona — la pone el servidor. */
  paid_at: string
  method: string
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
  method: string
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
