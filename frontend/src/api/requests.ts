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
  /** La unidad cómoda del insumo (kg, L, «unidad», o la de compra: «botella»). */
  entry_unit: string
  /** Lo pedido y lo aprobado en esa unidad, convertido por el servidor. */
  qty_requested_entry: string
  qty_approved_entry: string | null
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
  /** Redondeada hacia arriba al paso cómodo, en la unidad base. */
  suggested_qty: string
  entry_mode: EntryMode
  entry_unit: string
  /** La misma sugerencia en la unidad cómoda: la que se muestra y se manda. */
  suggested_entry_qty: string
}

export type EntryMode = "weight" | "bottle" | "volume" | "unit"

export interface SupplyItem {
  ingredient_id: number
  name: string
  entry_mode: EntryMode
  entry_unit: string
}

export interface SupplySuggestions {
  available: boolean
  reason: string | null
  /** Bajo mínimo en el área de quien pide (o en la sede, si no tiene área). */
  rows: SupplySuggestion[]
  area_name?: string | null
  area_via?: "member" | "puesto" | "none"
  other_areas_count?: number
  frequent?: SupplyItem[]
}

export interface SupplyLineIn {
  ingredient_id: number
  qty: string
  /** La unidad en que viene `qty` (`entry_unit`); el servidor convierte. */
  entry_unit?: string
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
