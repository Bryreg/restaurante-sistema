/**
 * Etiquetas de cocina (`app.labels` del backend, detrás de `inventory.labels`):
 * lo recibido, lo abierto y lo producido lleva una etiqueta impresa con su
 * «usar antes de» y un QR. El «usar antes de», los días que le quedan y el
 * estado (`state`) los calcula el servidor: la pantalla no cuenta días.
 * Toda escritura va con `Idempotency-Key`.
 */
import { api } from "./client"

export type LabelKind = "received" | "opened" | "produced"
export type LabelStatus = "active" | "used_up" | "discarded"
export type UseBySource = "supplier" | "opened_shelf_life" | "prep_shelf_life" | "manual"
export type LabelState = "expired" | "today" | "tomorrow" | "ok" | "no_date"
export type LabelWasteType = "expired" | "overproduction" | "kitchen_error" | "breakage" | "unidentified"
export type LabelFilter = "active" | "closed" | "all"

export interface FoodLabel {
  id: number
  code: string
  kind: LabelKind
  ingredient_id: number | null
  preparation_id: number | null
  stock_batch_id: number | null
  prep_batch_id: number | null
  reception_draft_line_id: number | null
  item_name: string
  lot_code: string | null
  qty_text: string | null
  note: string | null
  made_at: string
  business_date: string
  use_by: string | null
  use_by_source: UseBySource | null
  employee_name: string
  status: LabelStatus
  closed_at: string | null
  closed_by_employee_name: string | null
  waste_id: number | null
  print_count: number
  days_left: number | null
  state: LabelState
  /** La unidad en que se escribe cuánto se botó («kg», «botella», «ml»). */
  waste_unit: string
}

export interface LabelCreateIn {
  kind: LabelKind
  stock_batch_id?: number | null
  /** Lo recibido en la tablet que el administrador todavía no completó. */
  reception_draft_line_id?: number | null
  ingredient_id?: number | null
  prep_batch_id?: number | null
  copies?: number
  qty_text?: string | null
  /** Sólo más corta que la regla; obligatoria cuando no hay regla. */
  use_by?: string | null
  note?: string | null
}

export interface LabelFinishIn {
  outcome: "used_up" | "discarded"
  qty?: string | null
  waste_type?: LabelWasteType
  employee_pin?: string | null
  note?: string | null
}

export interface OpenableIngredient {
  ingredient_id: number
  name: string
  category: string | null
  perishable: boolean
  opened_shelf_life_days: number | null
  next_batch: { stock_batch_id: number; lot_code: string | null; expires_at: string | null } | null
  use_by_preview: string | null
  use_by_source_preview: UseBySource | null
}

export interface ReceivedSource {
  /** Uno de los dos: el lote (recepción completa) o el renglón del borrador. */
  stock_batch_id: number | null
  reception_draft_line_id: number | null
  /** El borrador espera al administrador. */
  pending: boolean
  ingredient_id: number
  name: string
  lot_code: string | null
  expires_at: string | null
  qty_received: string
  unit: string
  received_at: string
  labels_printed: number
}

export interface ProducedSource {
  prep_batch_id: number
  preparation_id: number
  name: string
  qty_real: string
  unit: string
  expiry_date: string | null
  produced_at: string
  produced_by: string
  labels_printed: number
}

export interface LabelSources {
  business_date: string
  openable: OpenableIngredient[]
  received: ReceivedSource[]
  produced: ProducedSource[]
}

export interface LabelBoard {
  business_date: string
  labels: FoodLabel[]
  expired: number
  today: number
  tomorrow: number
}

export interface LabelSettings {
  store_id: number
  width_mm: number
  height_mm: number
}

export function getLabelBoard(): Promise<LabelBoard> {
  return api<LabelBoard>("/device/labels")
}

export function getLabelSources(): Promise<LabelSources> {
  return api<LabelSources>("/device/labels/sources")
}

export function getDeviceLabelSettings(): Promise<LabelSettings> {
  return api<LabelSettings>("/device/labels/settings")
}

export function getLabelByCode(code: string): Promise<FoodLabel> {
  return api<FoodLabel>(`/device/labels/${encodeURIComponent(code)}`)
}

export function createLabels(body: LabelCreateIn, idempotencyKey: string): Promise<{ labels: FoodLabel[] }> {
  return api<{ labels: FoodLabel[] }>("/labels", { method: "POST", body, idempotencyKey })
}

export function reprintLabel(code: string, idempotencyKey: string): Promise<FoodLabel> {
  return api<FoodLabel>(`/labels/${encodeURIComponent(code)}/reprint`, { method: "POST", idempotencyKey })
}

export function finishLabel(code: string, body: LabelFinishIn, idempotencyKey: string): Promise<FoodLabel> {
  return api<FoodLabel>(`/labels/${encodeURIComponent(code)}/finish`, { method: "POST", body, idempotencyKey })
}

export interface AdminLabelsQuery {
  store_id: number
  status: LabelFilter
  from?: string | null
  to?: string | null
}

export function listAdminLabels(params: AdminLabelsQuery): Promise<FoodLabel[]> {
  return api<FoodLabel[]>("/admin/labels", { query: { ...params } })
}

export function getAdminLabelSettings(storeId: number): Promise<LabelSettings> {
  return api<LabelSettings>(`/admin/stores/${storeId}/label-settings`)
}

export function putAdminLabelSettings(
  storeId: number,
  body: { width_mm: number; height_mm: number },
): Promise<LabelSettings> {
  return api<LabelSettings>(`/admin/stores/${storeId}/label-settings`, { method: "PUT", body })
}
