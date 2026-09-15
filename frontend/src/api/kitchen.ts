/**
 * Vista de cocina mínima (`GET /kitchen/rounds`) — SPEC-NEGOCIO §9.2,
 * CONTRATO-INTERNO-1b-1.md §2.4 «Cocina». Sólo lectura; marcar "listo" es
 * `markReady` de `src/api/orders.ts` (vive en `app/orders/router.py`, no acá).
 */

import { api } from "@/api/client"

export type KitchenItemStatus = "sent" | "ready"
export type KitchenSemaphore = "green" | "amber" | "red"

export interface KitchenRoundItemOut {
  item_id: number
  name?: string
  qty?: number
  modifiers_text?: string | null
  note?: string | null
  course?: string
  station?: string | null
  status?: KitchenItemStatus
  elapsed_seconds?: number
  target_minutes?: number | null
  semaphore?: KitchenSemaphore
}

export interface KitchenRoundOut {
  order_id: number
  round_no?: number
  sent_at?: string
  elapsed_seconds?: number
  channel?: string
  tables?: string[]
  takeout_name?: string | null
  covers?: number | null
  items?: KitchenRoundItemOut[]
}

export function listKitchenRounds(station?: string): Promise<KitchenRoundOut[]> {
  return api<KitchenRoundOut[]>("/kitchen/rounds", { query: { station } })
}
