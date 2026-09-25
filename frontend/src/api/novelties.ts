/**
 * Novedades del turno (`app.novelties` del backend, detrás de
 * `pos.novelties`): lo que pasó en el turno y alguien tiene que saber o
 * resolver. Nada de acá lleva plata. Toda escritura va con `Idempotency-Key`.
 *
 * «Abierta» la decide el servidor (`open`: requiere seguimiento y nadie la
 * resolvió); una urgente siempre requiere seguimiento — también lo fuerza el
 * servidor, la pantalla no.
 */
import { api } from "./client"

export type NoveltyCategory = "incident" | "equipment" | "staff" | "customer" | "security" | "other"
export type NoveltyLevel = "info" | "important" | "urgent"
export type NoveltyStatus = "open" | "all"

export interface NoveltyIn {
  title: string
  detail?: string | null
  category: NoveltyCategory
  level: NoveltyLevel
  requires_follow_up: boolean
  photo?: string | null
}

export interface Novelty {
  id: number
  store_id: number
  shift_id: number | null
  business_date: string
  title: string
  detail: string | null
  category: NoveltyCategory
  level: NoveltyLevel
  requires_follow_up: boolean
  photo: string | null
  employee_id: number
  employee_name: string
  created_at: string
  open: boolean
  resolved_at: string | null
  resolved_by_employee_name: string | null
  resolution_note: string | null
}

/** `GET /novelties/open`: las abiertas de cualquier turno (urgentes primero)
 * y todas las del turno abierto (o del día, si no hay turno). */
export interface NoveltyBoard {
  open: Novelty[]
  this_shift: Novelty[]
  open_count: number
}

export function getNoveltyBoard(): Promise<NoveltyBoard> {
  return api<NoveltyBoard>("/novelties/open")
}

export function createNovelty(body: NoveltyIn, idempotencyKey: string): Promise<Novelty> {
  return api<Novelty>("/novelties", { method: "POST", body, idempotencyKey })
}

export function resolveNovelty(id: number, note: string, idempotencyKey: string): Promise<Novelty> {
  return api<Novelty>(`/novelties/${id}/resolve`, { method: "POST", body: { note }, idempotencyKey })
}

export interface AdminNoveltiesQuery {
  storeId: number
  status?: NoveltyStatus
  from?: string
  to?: string
}

export function listAdminNovelties(params: AdminNoveltiesQuery): Promise<Novelty[]> {
  return api<Novelty[]>("/admin/novelties", {
    query: { store_id: params.storeId, status: params.status ?? "open", from: params.from, to: params.to },
  })
}

export function adminNoveltiesCsvUrl(params: AdminNoveltiesQuery): string {
  const query = new URLSearchParams()
  query.set("format", "csv")
  query.set("store_id", String(params.storeId))
  query.set("status", params.status ?? "all")
  if (params.from) query.set("from", params.from)
  if (params.to) query.set("to", params.to)
  return `/api/v1/admin/novelties?${query.toString()}`
}

export function resolveNoveltyAsAdmin(
  storeId: number,
  id: number,
  note: string,
  idempotencyKey: string,
): Promise<Novelty> {
  return api<Novelty>(`/admin/novelties/${id}/resolve`, {
    method: "POST",
    query: { store_id: storeId },
    body: { note },
    idempotencyKey,
  })
}
