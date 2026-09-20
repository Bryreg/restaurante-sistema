/**
 * Cliente de `app/channels/**` (pedido 2c, territorio `backend-dinero-canales`
 * — contrato en `features/fase-2c-canales-cocina/outputs/backend-dinero-canales.md`).
 *
 * CONTRATO C7 (spec de este pedido): este archivo lo publica
 * `frontend-kds-config` (Configuración → Plataformas) y lo CONSUME
 * `frontend-pos-canales` (`features/orders/NewOrderPage.tsx`, el selector
 * de plataforma del canal `platform`) — no se duplica `DevicePlatformOut`
 * ni `listDevicePlatforms` en ningún otro archivo.
 *
 * `commission_bp` viaja en PUNTOS BÁSICOS ENTEROS (100 = 1 %), nunca
 * `float` — mismo precedente que `WasteKpiOut.ratio` (2b). La ÚNICA
 * función que sabe que 100 = 1 % es `formatBasisPoints`
 * (`@/features/inventory/lib`): este archivo no formatea nada, sólo
 * transporta el entero tal cual lo manda el backend.
 *
 * Sólo `/admin/**` recibe `commission_bp`: `GET /device/platforms` (POS) lo
 * omite a propósito — la comisión es plata del negocio, no algo que el
 * operador necesite para cargar un pedido (`DevicePlatformOut`, sin ese
 * campo, mismo criterio que "el operador no ve costos ni márgenes").
 */

import { api } from "@/api/client"

// ---------------------------------------------------------------------------
// Dispositivo (POS): plataformas activas, sin comisión.
// ---------------------------------------------------------------------------

export interface DevicePlatformOut {
  id: number
  name: string
  code: string
}

/** `GET /device/platforms`, detrás de `pos.platforms`. */
export function listDevicePlatforms(): Promise<DevicePlatformOut[]> {
  return api<DevicePlatformOut[]>("/device/platforms")
}

// ---------------------------------------------------------------------------
// Admin: CRUD de plataformas y su comisión (§9.3 "plataformas y comisiones").
// ---------------------------------------------------------------------------

export interface PlatformOut {
  id: number
  store_id: number
  name: string
  code: string
  commission_bp: number
  active: boolean
  created_at: string
  updated_at: string
}

export interface PlatformIn {
  name: string
  code: string
  commission_bp: number
}

export interface PlatformUpdateIn {
  name?: string
  commission_bp?: number
  active?: boolean
}

/** `GET /admin/platforms?store_id=&active=`, detrás de `pos.platforms`. Sin `active`, trae activas e inactivas (baja lógica: nunca se borran). */
export function listPlatforms(storeId: number, params: { active?: boolean } = {}): Promise<PlatformOut[]> {
  return api<PlatformOut[]>("/admin/platforms", { query: { store_id: storeId, active: params.active } })
}

/** `POST /admin/platforms?store_id=`. `409 PLATFORM_CODE_TAKEN` si ya hay una plataforma ACTIVA con ese código en la sede (el backend lo redacta; se muestra tal cual). */
export function createPlatform(storeId: number, data: PlatformIn): Promise<PlatformOut> {
  return api<PlatformOut>("/admin/platforms", { method: "POST", query: { store_id: storeId }, body: data })
}

/** `PATCH /admin/platforms/{id}?store_id=`. `active: true` reactiva (mismo `409 PLATFORM_CODE_TAKEN` si el código choca con otra activa). El `code` no se edita: nace con la plataforma. */
export function updatePlatform(storeId: number, platformId: number, data: PlatformUpdateIn): Promise<PlatformOut> {
  return api<PlatformOut>(`/admin/platforms/${platformId}`, { method: "PATCH", query: { store_id: storeId }, body: data })
}

/** `DELETE /admin/platforms/{id}?store_id=` — baja LÓGICA: la plataforma queda `active: false`, nunca se borra (sus comisiones y cuentas por cobrar siguen legibles). */
export function deactivatePlatform(storeId: number, platformId: number): Promise<PlatformOut> {
  return api<PlatformOut>(`/admin/platforms/${platformId}`, { method: "DELETE", query: { store_id: storeId } })
}
