/**
 * Solicitudes del salón al administrador (`app.requests` del backend, detrás
 * de `pos.requests`): pedido de insumos y pedido de sencilla.
 *
 * Mismas convenciones que `api/inventory.ts`: las cantidades de insumo viajan
 * como texto decimal en la unidad base, nunca como número JSON. Las
 * denominaciones usan la forma del turno (`DenominationCount`). Nada de acá
 * trae costos: la tablet consume estas mismas respuestas. Toda escritura va
 * con `Idempotency-Key`.
 */
import { api, newIdempotencyKey } from "./client"
import type { Denomination, DenominationCount } from "./shifts"

export type StaffRequestKind = "supply" | "change"
export type StaffRequestStatus = "pending" | "approved" | "rejected" | "bought" | "received"

export interface PersonRef {
  id: number
  name: string
}

export interface RequestLine {
  id: number
  ingredient_id: number
  ingredient_name: string
  base_unit: string
  qty_requested: string
  qty_approved: string | null
  suggested_qty: string | null
}

export interface StaffRequest {
  id: number
  kind: StaffRequestKind
  status: StaffRequestStatus
  shift_id: number
  business_date: string
  requested_by: PersonRef
  requested_at: string
  note: string | null
  reason: string | null
  lines: RequestLine[]
  requested_denominations: Denomination[] | null
  requested_total: number | null
  approved_denominations: Denomination[] | null
  approved_total: number | null
  resolved_by: PersonRef | null
  resolved_at: string | null
  resolution_note: string | null
  closed_by: PersonRef | null
  closed_at: string | null
  cash_swap_id: number | null
}

export interface SupplySuggestion {
  ingredient_id: number
  name: string
  base_unit: string
  current_stock: string
  min_stock: string
  negative: boolean
  suggested_qty: string
}

export interface SupplySuggestions {
  available: boolean
  reason: string | null
  rows: SupplySuggestion[]
}

export interface SupplyLineIn {
  ingredient_id: number
  qty: string
}

// ---------------------------------------------------------------------------
// Operador (tablet)
// ---------------------------------------------------------------------------

export function getSupplySuggestions(): Promise<SupplySuggestions> {
  return api<SupplySuggestions>("/requests/supply-suggestions")
}

export function listMyRequests(): Promise<StaffRequest[]> {
  return api<StaffRequest[]>("/requests/mine")
}

export function createSupplyRequest(body: { lines: SupplyLineIn[]; note: string | null }): Promise<StaffRequest> {
  return api<StaffRequest>("/requests/supplies", { method: "POST", body, idempotencyKey: newIdempotencyKey() })
}

export function createChangeRequest(body: { denominations: DenominationCount; reason: string }): Promise<StaffRequest> {
  return api<StaffRequest>("/requests/change", { method: "POST", body, idempotencyKey: newIdempotencyKey() })
}

export function markChangeReceived(requestId: number, cashSwapId: number | null): Promise<StaffRequest> {
  return api<StaffRequest>(`/requests/${requestId}/received`, {
    method: "POST",
    body: { cash_swap_id: cashSwapId },
    idempotencyKey: newIdempotencyKey(),
  })
}

// ---------------------------------------------------------------------------
// Administrador
// ---------------------------------------------------------------------------

export function listAdminRequests(
  storeId: number,
  params: { status?: StaffRequestStatus; kind?: StaffRequestKind } = {},
): Promise<StaffRequest[]> {
  return api<StaffRequest[]>("/admin/requests", { query: { store_id: storeId, ...params } })
}

export function listApprovedSupplyRequests(storeId: number): Promise<StaffRequest[]> {
  return api<StaffRequest[]>("/admin/requests/supplies", { query: { store_id: storeId, status: "approved" } })
}

export interface ApproveBody {
  lines?: { line_id: number; qty: string }[]
  denominations?: DenominationCount
  note?: string | null
}

export function approveRequest(requestId: number, body: ApproveBody): Promise<StaffRequest> {
  return api<StaffRequest>(`/admin/requests/${requestId}/approve`, {
    method: "POST",
    body,
    idempotencyKey: newIdempotencyKey(),
  })
}

export function rejectRequest(requestId: number, reason: string): Promise<StaffRequest> {
  return api<StaffRequest>(`/admin/requests/${requestId}/reject`, {
    method: "POST",
    body: { reason },
    idempotencyKey: newIdempotencyKey(),
  })
}

export function markRequestBought(requestId: number, note: string | null = null): Promise<StaffRequest> {
  return api<StaffRequest>(`/admin/requests/${requestId}/mark-bought`, {
    method: "POST",
    body: { note },
    idempotencyKey: newIdempotencyKey(),
  })
}
