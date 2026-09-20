/**
 * Cocina — SPEC-NEGOCIO §9.2. `GET /kitchen/rounds` es la vista mínima de
 * 1b (CONTRATO-INTERNO-1b-1.md §2.4); marcar "listo" ahí es `markReady` de
 * `src/api/orders.ts` (vive en `app/orders/router.py`, no acá).
 *
 * El resto de este archivo es el KDS completo (`kitchen.kds`, pedido 2c,
 * territorio `backend-kds` — contrato publicado en
 * `features/fase-2c-canales-cocina/outputs/backend-kds.md`): bump/unbump
 * por ítem, expedición de la comanda completa, e impresión por estación.
 * Cinco campos NUEVOS y opcionales de `GET /kitchen/rounds` cuando
 * `kitchen.kds` está encendida (`course_fired_at`/`bumped_by`/`bumped_at`
 * por ítem, `platform` por ronda) — con la flag apagada el backend nunca
 * los manda, y acá se tratan como "puede no venir", nunca como "es 0" o
 * "es falso" (`null` ≠ 0, AGENTS.md).
 *
 * Ninguna de estas respuestas trae `cost`/`margin`/`unit_cost`: el KDS es
 * superficie de dispositivo (SPEC-NEGOCIO §11, "el operador no ve costos").
 * Si el backend alguna vez los mandara, es un defecto del backend — este
 * archivo no los declara ni los esconde, simplemente no existen en estos
 * tipos.
 */

import { api, newIdempotencyKey } from "@/api/client"

export type KitchenItemStatus = "sent" | "ready"
export type KitchenSemaphore = "green" | "amber" | "red"

/** `{id, name}` — quien bumpeó, expedió o confirmó una impresión. */
export interface EmployeeRef {
  id: number
  name: string
}

/** Canal `platform` de una ronda, cuando `kitchen.kds` está encendida. `source` es el nombre de la plataforma (Rappi, Didi…), NUNCA la comisión — el KDS no la recibe. */
export interface KitchenRoundPlatformOut {
  source: string | null
  external_id: string | null
}

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
  /** NUEVO con `kitchen.kds`: cuándo se «marchó» el curso de este ítem; `null` si no se marchó (o el restaurante no usa «marchar»). Ausente con la flag apagada. */
  course_fired_at?: string | null
  /** NUEVO con `kitchen.kds`: quién lo bumpeó; `null` si el ítem no está `ready`. Ausente con la flag apagada. */
  bumped_by?: EmployeeRef | null
  /** NUEVO con `kitchen.kds`: es literalmente `item.ready_at` (backend-kds.md §6, decisión 6) — no un timestamp propio. `null` si el ítem no está `ready`. */
  bumped_at?: string | null
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
  /** NUEVO con `kitchen.kds`: `null` si el canal no es `platform`. Ausente con la flag apagada. */
  platform?: KitchenRoundPlatformOut | null
  items?: KitchenRoundItemOut[]
}

export function listKitchenRounds(station?: string): Promise<KitchenRoundOut[]> {
  return api<KitchenRoundOut[]>("/kitchen/rounds", { query: { station } })
}

// ---------------------------------------------------------------------------
// KDS completo (`kitchen.kds`): bump / unbump / expedición.
// ---------------------------------------------------------------------------

export interface KitchenItemStateOut {
  item_id: number
  order_id: number
  status: KitchenItemStatus
  ready_at: string | null
  /** `false` = no-op idempotente (el ítem ya estaba en el estado pedido): sigue siendo un `200`, nunca un error. */
  changed: boolean
  bumped_by: EmployeeRef | null
  bumped_at: string | null
}

/** `POST /kitchen/items/{item_id}/bump` — idempotente (backend-kds.md §4): bumpear un ítem ya `ready` devuelve `changed: false`, nunca un error. */
export function bumpItem(itemId: number, idempotencyKey: string = newIdempotencyKey()): Promise<KitchenItemStateOut> {
  return api<KitchenItemStateOut>(`/kitchen/items/${itemId}/bump`, { method: "POST", idempotencyKey })
}

/** `POST /kitchen/items/{item_id}/unbump` — mismas reglas de idempotencia que `bumpItem`. */
export function unbumpItem(itemId: number, idempotencyKey: string = newIdempotencyKey()): Promise<KitchenItemStateOut> {
  return api<KitchenItemStateOut>(`/kitchen/items/${itemId}/unbump`, { method: "POST", idempotencyKey })
}

export interface KitchenExpediteItemOut {
  item_id: number
  name: string
  status: string
  station: string | null
}

export interface KitchenExpediteOut {
  order_id: number
  /** `false` = no quedaba nada `sent` en la comanda: no es un error, es información. */
  changed: boolean
  changed_item_ids: number[]
  items: KitchenExpediteItemOut[]
  expedited_by: EmployeeRef
  expedited_at: string
}

/**
 * `POST /kitchen/orders/{order_id}/expedite` — bumpea de un golpe TODOS los
 * ítems `sent` de la comanda completa (todas sus rondas, no sólo la que se
 * ve en pantalla): es la "expedición de la comanda completa" de la misión.
 */
export function expediteOrder(orderId: number, idempotencyKey: string = newIdempotencyKey()): Promise<KitchenExpediteOut> {
  return api<KitchenExpediteOut>(`/kitchen/orders/${orderId}/expedite`, { method: "POST", idempotencyKey })
}

// ---------------------------------------------------------------------------
// Impresión por estación: el TRABAJO de impresión (qué, para qué estación,
// cuándo se confirmó, quién) — NO una impresora térmica real (fase 3).
// ---------------------------------------------------------------------------

export interface KitchenPrintJobItemOut {
  item_id: number
  name: string
  qty: number
  modifiers_text: string | null
  note: string | null
}

export interface KitchenPrintJobOut {
  order_id: number
  round_id: number
  round_no: number
  station: string
  channel: string
  tables: string[]
  items: KitchenPrintJobItemOut[]
  item_count: number
  printed: boolean
  printed_at: string | null
  printed_by: EmployeeRef | null
  print_count: number
}

/** `GET /kitchen/print-jobs?station=` — un docket por (ronda, estación) con al menos un ítem `sent`/`ready`. */
export function listPrintJobs(station?: string): Promise<KitchenPrintJobOut[]> {
  return api<KitchenPrintJobOut[]>("/kitchen/print-jobs", { query: { station } })
}

/**
 * `POST /kitchen/print-jobs` — registra "esto se imprimió" para (ronda,
 * estación). Una estación sin ítems pendientes no es un error (`item_count:
 * 0`), y reimprimir (otra `Idempotency-Key`) suma al `print_count`: el
 * backend termina en el TRABAJO, esta función nunca envía nada a una
 * impresora física.
 */
export function registerPrintJob(
  body: { round_id: number; station: string },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<KitchenPrintJobOut> {
  return api<KitchenPrintJobOut>("/kitchen/print-jobs", { method: "POST", body, idempotencyKey })
}
