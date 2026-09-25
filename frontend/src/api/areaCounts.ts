/**
 * Conteo corto por área (`app/inventory/area_counts.py` del backend, detrás
 * de `inventory.shift_counts`). Cada área (bar, cocina) cuenta sus artículos
 * clave al abrir y al cerrar; el administrador puede pedir un recuento
 * sorpresa.
 *
 * Este archivo no calcula nada: las cantidades viajan como texto decimal y
 * la conversión de «2 botellas y 3/10» a mililitros la hace el servidor, una
 * sola vez. Los tipos de dispositivo no tienen stock, ni conteo anterior, ni
 * costo: el conteo es a ciegas.
 */
import { api } from "./client"

import type { BaseUnit } from "./inventory"

export type AreaCountMoment = "opening" | "closing" | "spot"
export type AreaCountRegularMoment = "opening" | "closing"
export type AreaCountEntryMode = "weight" | "bottle" | "volume" | "unit"
export type AreaCountWindow = "night" | "shift" | "spot"
export type AreaRecountStatus = "pending" | "answered"

export interface AreaCountItemOut {
  ingredient_id: number
  name: string
  base_unit: BaseUnit
  entry_mode: AreaCountEntryMode
  entry_unit: string
}

export interface AreaCountDoneOut {
  count_id: number
  counted_at: string
  employee_name: string
}

export interface DeviceAreaRecountOut {
  id: number
  requested_at: string
  requested_by_employee_name: string
  note: string | null
  items: AreaCountItemOut[]
}

export interface DeviceAreaCountBoardOut {
  area_id: number | null
  area_name: string | null
  reason: string | null
  business_date: string
  items: AreaCountItemOut[]
  suggested_moment: AreaCountRegularMoment
  opening_done: AreaCountDoneOut | null
  closing_done: AreaCountDoneOut | null
  recounts: DeviceAreaRecountOut[]
}

export interface AreaCountLineIn {
  ingredient_id: number
  qty: string
}

export interface AreaCountReceiptOut {
  id: number
  area_name: string
  moment: AreaCountMoment
  counted_at: string
  employee_name: string
  lines_count: number
}

export function getDeviceAreaCount(): Promise<DeviceAreaCountBoardOut> {
  return api<DeviceAreaCountBoardOut>("/device/area-count")
}

export function postAreaCount(
  body: { moment: AreaCountRegularMoment; lines: AreaCountLineIn[] },
  idempotencyKey: string,
): Promise<AreaCountReceiptOut> {
  return api<AreaCountReceiptOut>("/device/area-counts", { method: "POST", body, idempotencyKey })
}

export function answerAreaRecount(
  requestId: number,
  lines: AreaCountLineIn[],
  idempotencyKey: string,
): Promise<AreaCountReceiptOut> {
  return api<AreaCountReceiptOut>(`/device/area-recounts/${requestId}/answer`, {
    method: "POST",
    body: { lines },
    idempotencyKey,
  })
}

// ---------------------------------------------------------------------------
// Administrador.
// ---------------------------------------------------------------------------

export interface CountAreaMemberOut {
  employee_id: number
  employee_name: string
}

export interface CountAreaOut {
  id: number
  name: string
  active: boolean
  members: CountAreaMemberOut[]
  items: AreaCountItemOut[]
}

export function listCountAreas(storeId: number): Promise<CountAreaOut[]> {
  return api<CountAreaOut[]>("/admin/count-areas", { query: { store_id: storeId } })
}

export function createCountArea(storeId: number, name: string): Promise<CountAreaOut> {
  return api<CountAreaOut>("/admin/count-areas", { method: "POST", query: { store_id: storeId }, body: { name } })
}

export function updateCountArea(
  storeId: number,
  areaId: number,
  body: { name?: string; active?: boolean },
): Promise<CountAreaOut> {
  return api<CountAreaOut>(`/admin/count-areas/${areaId}`, { method: "PATCH", query: { store_id: storeId }, body })
}

export function setCountAreaItems(storeId: number, areaId: number, ingredientIds: number[]): Promise<CountAreaOut> {
  return api<CountAreaOut>(`/admin/count-areas/${areaId}/items`, {
    method: "PUT",
    query: { store_id: storeId },
    body: { ingredient_ids: ingredientIds },
  })
}

export function setCountAreaMember(storeId: number, employeeId: number, areaId: number | null): Promise<CountAreaOut[]> {
  return api<CountAreaOut[]>("/admin/count-area-members", {
    method: "PUT",
    query: { store_id: storeId },
    body: { employee_id: employeeId, area_id: areaId },
  })
}

export interface AreaCountSettingsIn {
  threshold_pct_bp: number | null
  threshold_amount: number | null
}

export interface AreaCountSettingsOut extends AreaCountSettingsIn {
  store_id: number
  /** La regla en palabras, escrita por el servidor. */
  reading: string
}

export function getAreaCountSettings(storeId: number): Promise<AreaCountSettingsOut> {
  return api<AreaCountSettingsOut>("/admin/area-count-settings", { query: { store_id: storeId } })
}

export function putAreaCountSettings(storeId: number, body: AreaCountSettingsIn): Promise<AreaCountSettingsOut> {
  return api<AreaCountSettingsOut>("/admin/area-count-settings", { method: "PUT", query: { store_id: storeId }, body })
}

/** Un renglón con su derivación: `expected = reference + inflow − outflow`,
 * `shortage = expected − counted` (positivo = faltó). Todo `null` con
 * `null_reason` cuando no hay contra qué comparar. Lo calcula el servidor. */
export interface AreaCountLineOut {
  ingredient_id: number
  ingredient_name: string
  base_unit: BaseUnit
  entered_qty: string
  entered_unit: string
  counted_qty: string
  reference_qty: string | null
  inflow_qty: string | null
  outflow_qty: string | null
  expected_qty: string | null
  shortage_qty: string | null
  shortage_value: number | null
  shortage_pct_bp: number | null
  flagged: boolean
  null_reason: string | null
}

export interface AreaCountOut {
  id: number
  area_id: number
  area_name: string
  moment: AreaCountMoment
  window: AreaCountWindow
  counted_at: string
  business_date: string
  employee_name: string
  reference_count_id: number | null
  reference_counted_at: string | null
  reference_employee_name: string | null
  reason: string | null
  superseded: boolean
  lines_count: number
  flagged_count: number
  shortage_value_total: number | null
  unvalued_lines: number
}

export interface AreaCountDetailOut extends AreaCountOut {
  lines: AreaCountLineOut[]
}

export interface AreaCountsQuery {
  storeId: number
  from?: string
  to?: string
  areaId?: number | null
}

export function listAreaCounts(params: AreaCountsQuery): Promise<AreaCountOut[]> {
  return api<AreaCountOut[]>("/admin/area-counts", {
    query: { store_id: params.storeId, from: params.from, to: params.to, area_id: params.areaId },
  })
}

export function areaCountsCsvUrl(params: AreaCountsQuery): string {
  const query = new URLSearchParams()
  query.set("format", "csv")
  query.set("store_id", String(params.storeId))
  if (params.from) query.set("from", params.from)
  if (params.to) query.set("to", params.to)
  if (params.areaId) query.set("area_id", String(params.areaId))
  return `/api/v1/admin/area-counts?${query.toString()}`
}

export function getAreaCount(storeId: number, countId: number): Promise<AreaCountDetailOut> {
  return api<AreaCountDetailOut>(`/admin/area-counts/${countId}`, { query: { store_id: storeId } })
}

export interface AreaRecountRequestOut {
  id: number
  area_id: number
  area_name: string
  items: AreaCountItemOut[]
  note: string | null
  status: AreaRecountStatus
  requested_at: string
  requested_by_employee_name: string
  answered_at: string | null
  count_id: number | null
}

export function listAreaRecounts(storeId: number, status?: AreaRecountStatus): Promise<AreaRecountRequestOut[]> {
  return api<AreaRecountRequestOut[]>("/admin/area-recounts", { query: { store_id: storeId, status } })
}

export function createAreaRecount(
  storeId: number,
  body: { area_id: number; ingredient_ids: number[]; note?: string | null },
  idempotencyKey: string,
): Promise<AreaRecountRequestOut> {
  return api<AreaRecountRequestOut>("/admin/area-recounts", {
    method: "POST",
    query: { store_id: storeId },
    body,
    idempotencyKey,
  })
}
