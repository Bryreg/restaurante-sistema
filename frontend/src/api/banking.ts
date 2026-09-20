/**
 * Banco, mano del dueño y conciliación (`features/fase-3-dinero-control/spec.md`
 * § T1 `backend-banco`, contrato de API mínimo). Dominio `app.banking` del
 * backend.
 *
 * El contrato mínimo (spec.md § 2) sólo fija RUTAS; el resto de los campos
 * de este archivo se verificó por lectura directa de
 * `backend/app/banking/schemas.py` ya escrito — no adivinado (una
 * consignación reparte su monto en `allocations: [{shift_id, amount}]`, no
 * un `shift_ids: number[]` plano; el libro del banco publica `entries`, no
 * `rows`). Los campos que ese archivo no fija con un tipo cerrado quedan
 * opcionales/`| null`, igual que `api/reports.ts`.
 *
 * Ni una resta ni un porcentaje acá: `to_deposit`, `outstanding`, `balance`,
 * `expected`/`settled`/`difference` llegan calculados del servidor y se
 * pintan tal cual (AGENTS.md § "una sola matemática, en el backend").
 */

import { api } from "@/api/client"

// ---------------------------------------------------------------------------
// GET/POST /admin/deposits — consignaciones con comprobante. El monto se
// reparte en `allocations`: cada una imputa parte de la consignación a un
// turno cerrado concreto — es la llave anti doble conteo de este territorio
// (spec.md § T1: "un mismo peso no puede estar «en la mano» y «en el
// banco» a la vez").
// ---------------------------------------------------------------------------

export interface DepositAllocationIn {
  shift_id: number
  amount: number
}

export interface DepositAllocationOut {
  shift_id: number
  amount: number
}

export interface DepositOut {
  id: number
  store_id?: number
  business_date?: string
  deposited_at?: string
  amount?: number
  allocated_amount?: number
  unallocated_amount?: number
  bank_name?: string | null
  bank_reference?: string | null
  /** Comprobante, *data URL* — OBLIGATORIO en `DepositIn` (mismo patrón que `PhotoCaptureField`). */
  receipt_photo?: string
  note?: string | null
  status?: "live" | "reversed" | string
  employee_name?: string | null
  allocations?: DepositAllocationOut[]
  reversed_at?: string | null
  reversed_reason?: string | null
}

export interface DepositIn {
  amount: number
  /** `undefined` → hoy de negocio de la sede en el servidor; esta pantalla siempre lo manda explícito. */
  business_date?: string | null
  /** `<input type="datetime-local">` tal cual, sin zona — la pone el servidor. `undefined` → ahora. */
  deposited_at?: string | null
  bank_name?: string | null
  bank_reference?: string | null
  /** Obligatorio (`min_length=1`) — el servidor rechaza una consignación sin comprobante. */
  receipt_photo: string
  note?: string | null
  allocations: DepositAllocationIn[]
}

export interface PeriodQuery {
  storeId: number
  from: string
  to: string
}

export function getDeposits(params: PeriodQuery): Promise<DepositOut[]> {
  return api<DepositOut[]>("/admin/deposits", {
    query: { store_id: params.storeId, from: params.from, to: params.to },
  })
}

export function createDeposit(storeId: number, data: DepositIn, idempotencyKey: string): Promise<DepositOut> {
  return api<DepositOut>("/admin/deposits", {
    method: "POST",
    query: { store_id: storeId },
    body: data,
    idempotencyKey,
  })
}

// ---------------------------------------------------------------------------
// GET /admin/deposits/pending — saldo por consignar por turno cerrado.
// `to_deposit` se LEE de `Shift.to_deposit` (snapshot de cierre, ya
// calculado por `app/shifts/service.py`); esta pantalla nunca lo recalcula.
// ---------------------------------------------------------------------------

export interface PendingDepositOut {
  shift_id: number
  business_date?: string
  /** `null` cuando el turno cerró sin conteo — viene con `reason`, nunca `0`. */
  to_deposit: number | null
  reason?: string | null
  deposited?: number | null
  outstanding?: number | null
}

export function getPendingDeposits(params: PeriodQuery): Promise<PendingDepositOut[]> {
  return api<PendingDepositOut[]>("/admin/deposits/pending", {
    query: { store_id: params.storeId, from: params.from, to: params.to },
  })
}

// ---------------------------------------------------------------------------
// GET /admin/bank/ledger — libro del banco del período: `entries` (no
// `rows`) más `totals`, verificado contra `LedgerEntryOut`/`BankLedgerOut`.
// ---------------------------------------------------------------------------

export type BankLedgerEntryKind = "deposit" | "card_settlement" | "transfer"

export interface BankLedgerEntryOut {
  kind?: BankLedgerEntryKind | string
  /** `null` para "transfer": renglón derivado de `Payment`, sin fila propia en este dominio. */
  id?: number | null
  business_date?: string
  amount?: number
  gross_amount?: number | null
  commission_amount?: number | null
  retention_amount?: number | null
  settled_business_date?: string | null
  lag_days?: number | null
  reference?: string | null
  note?: string | null
  status?: string | null
}

export interface BankLedgerTotalsOut {
  deposits: number
  card_settlements_net: number
  transfers: number
  total: number
}

export interface BankLedgerOut {
  date_from?: string
  date_to?: string
  entries?: BankLedgerEntryOut[]
  totals?: BankLedgerTotalsOut
}

export function getBankLedger(params: PeriodQuery): Promise<BankLedgerOut> {
  return api<BankLedgerOut>("/admin/bank/ledger", {
    query: { store_id: params.storeId, from: params.from, to: params.to },
  })
}

// ---------------------------------------------------------------------------
// GET /admin/bank/owner-hand — mano del dueño.
// ---------------------------------------------------------------------------

export interface OwnerHandOut {
  date_from?: string
  date_to?: string
  withdrawn: number | null
  deposited: number | null
  spent: number | null
  balance: number | null
  /** Desglose informativo de `withdrawn`/`spent` (nunca una cifra nueva: siempre las mismas sumas de arriba, partidas). */
  withdrawn_from_pickups?: number | null
  withdrawn_from_shift_close?: number | null
  spent_on_tips?: number | null
  spent_on_refunds?: number | null
  reason?: string | null
}

export function getOwnerHand(params: PeriodQuery): Promise<OwnerHandOut> {
  return api<OwnerHandOut>("/admin/bank/owner-hand", {
    query: { store_id: params.storeId, from: params.from, to: params.to },
  })
}

// ---------------------------------------------------------------------------
// GET /admin/reconciliation/card · /admin/reconciliation/platform
// ---------------------------------------------------------------------------

export interface ReconciliationRowOut {
  /** No fijado por el contrato mínimo (spec.md § 2 sólo fija la RUTA de
   * `settle`, `.../reconciliation/card/{id}/settle`) — optativo a propósito:
   * la pantalla oculta "Conciliar" cuando no llega, en vez de ofrecer un
   * botón que apunta a un id que no existe. Ver gaps del entregable. */
  id?: number
  business_date?: string
  /** Nombre del datáfono o de la plataforma, sólo en `.../platform`. */
  platform?: string | null
  expected: number | null
  settled: number | null
  difference: number | null
  matched?: boolean
  reference?: string | null
}

export interface ReconciliationOut {
  store_id?: number
  date_from?: string
  date_to?: string
  rows?: ReconciliationRowOut[]
}

export function getCardReconciliation(params: PeriodQuery): Promise<ReconciliationOut> {
  return api<ReconciliationOut>("/admin/reconciliation/card", {
    query: { store_id: params.storeId, from: params.from, to: params.to },
  })
}

export function getPlatformReconciliation(params: PeriodQuery): Promise<ReconciliationOut> {
  return api<ReconciliationOut>("/admin/reconciliation/platform", {
    query: { store_id: params.storeId, from: params.from, to: params.to },
  })
}

/** Espejo de `app/banking/schemas.py::SettleIn` — conciliar una liquidación
 * YA registrada (`POST /admin/reconciliation/card`, fuera del contrato
 * mínimo) contra lo esperado; no vuelve a pedir un monto, sólo confirma el
 * match con una nota opcional. */
export interface SettleReconciliationIn {
  note?: string | null
}

export function settleCardReconciliation(
  id: number,
  data: SettleReconciliationIn,
  idempotencyKey: string,
): Promise<ReconciliationRowOut> {
  return api<ReconciliationRowOut>(`/admin/reconciliation/card/${id}/settle`, {
    method: "POST",
    body: data,
    idempotencyKey,
  })
}

// ---------------------------------------------------------------------------
// Liquidaciones del datáfono y de plataformas — REGISTRAR y CONCILIAR.
//
// Hallazgo A-1 del cierre de la fase 3: `POST /admin/reconciliation/card`,
// `POST .../platform`, `GET .../settlements` y `POST .../{id}/settle`
// estaban construidos y probados, y ninguna pantalla los consumía. Sin
// registrar una liquidación, `settled` es siempre 0 y TODO aparece como no
// conciliado — la capacidad 3 de la fase no se podía completar.
//
// El flujo es de DOS PASOS a propósito: primero se registra lo que liquidó el
// datáfono (bruto, comisión, retención, fecha de venta y fecha de abono), y
// después se concilia esa liquidación contra lo esperado. La fila de
// `GET /admin/reconciliation/card` agrupa POR DÍA y trae `settlement_ids`, no
// un `id`: el botón «Conciliar» va sobre la liquidación concreta de esta
// lista, no sobre la fila agrupada.
// ---------------------------------------------------------------------------

export type SettlementStatus = "pending" | "matched" | "reversed"

export interface CardSettlementIn {
  sales_business_date: string
  settled_business_date: string
  gross_amount: number
  commission_amount: number
  retention_amount: number
  reference?: string | null
  note?: string | null
}

export interface CardSettlementOut {
  id: number
  store_id: number
  sales_business_date: string
  settled_business_date: string
  lag_days: number
  gross_amount: number
  commission_amount: number
  retention_amount: number
  net_amount: number
  reference: string | null
  note: string | null
  status: SettlementStatus
  employee_name: string
  created_at: string
  matched_at?: string | null
  matched_by_employee_name?: string | null
  reversed_at?: string | null
  reversed_reason?: string | null
}

export function createCardSettlement(
  storeId: number,
  data: CardSettlementIn,
  idempotencyKey: string,
): Promise<CardSettlementOut> {
  return api<CardSettlementOut>("/admin/reconciliation/card", {
    method: "POST",
    query: { store_id: storeId },
    body: data,
    idempotencyKey,
  })
}

export function listCardSettlements(params: PeriodQuery & { status?: string }): Promise<CardSettlementOut[]> {
  return api<CardSettlementOut[]>("/admin/reconciliation/card/settlements", {
    query: { store_id: params.storeId, from: params.from, to: params.to, status: params.status },
  })
}

export interface PlatformSettlementIn {
  platform_id: number
  period_from: string
  period_to: string
  gross_amount: number
  commission_amount: number
  reference?: string | null
  note?: string | null
}

export interface PlatformSettlementOut {
  id: number
  store_id: number
  platform_id: number
  period_from: string
  period_to: string
  gross_amount: number
  commission_amount: number
  net_amount: number
  reference: string | null
  note: string | null
  status: SettlementStatus
  employee_name: string
  created_at: string
  matched_at?: string | null
  matched_by_employee_name?: string | null
}

export function createPlatformSettlement(
  storeId: number,
  data: PlatformSettlementIn,
  idempotencyKey: string,
): Promise<PlatformSettlementOut> {
  return api<PlatformSettlementOut>("/admin/reconciliation/platform", {
    method: "POST",
    query: { store_id: storeId },
    body: data,
    idempotencyKey,
  })
}

export function listPlatformSettlements(
  params: PeriodQuery & { status?: string },
): Promise<PlatformSettlementOut[]> {
  return api<PlatformSettlementOut[]>("/admin/reconciliation/platform/settlements", {
    query: { store_id: params.storeId, from: params.from, to: params.to, status: params.status },
  })
}

export function settlePlatformSettlement(
  id: number,
  data: SettleReconciliationIn,
  idempotencyKey: string,
): Promise<PlatformSettlementOut> {
  return api<PlatformSettlementOut>(`/admin/reconciliation/platform/${id}/settle`, {
    method: "POST",
    body: data,
    idempotencyKey,
  })
}
