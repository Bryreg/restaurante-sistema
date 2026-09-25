/**
 * Etiquetas del conteo corto por área. Nada de acá calcula: traduce códigos
 * del servidor a palabras y formatea el texto decimal que el servidor manda.
 */
import type { AreaCountMoment, AreaCountWindow } from "@/api/areaCounts"
import type { AreaCountFlagOut } from "@/api/reports"
import type { BaseUnit } from "@/api/inventory"
import { formatCantidad } from "@/lib/format"

/** El tablero del POS (`GET /device/area-count`). */
export const AREA_COUNT_QUERY_KEY = ["area-count", "board"] as const

export const AREA_COUNTS_QUERY_KEYS = {
  areas: (storeId: number) => ["area-counts", "areas", storeId] as const,
  settings: (storeId: number) => ["area-counts", "settings", storeId] as const,
  counts: (storeId: number, from: string, to: string, areaId: number | null) =>
    ["area-counts", "counts", storeId, from, to, areaId] as const,
  count: (storeId: number, countId: number) => ["area-counts", "count", storeId, countId] as const,
  recounts: (storeId: number) => ["area-counts", "recounts", storeId] as const,
}

export const MOMENT_LABEL: Record<AreaCountMoment, string> = {
  opening: "Apertura",
  closing: "Cierre",
  spot: "Recuento",
}

/** De dónde sale la diferencia, en palabras del dueño. */
export const WINDOW_LABEL: Record<AreaCountWindow, string> = {
  night: "de la noche",
  shift: "del turno",
  spot: "recuento sorpresa",
}

const UNIT_LABEL: Record<BaseUnit, string> = { g: "g", ml: "ml", unit: "und" }

/** «500 g», «1.725 ml» a partir del texto decimal del servidor. */
export function qtyText(qty: string | null | undefined, baseUnit: string): string {
  return formatCantidad(qty, UNIT_LABEL[baseUnit as BaseUnit] ?? baseUnit)
}

/** Un faltante positivo se lee «faltan»; uno negativo, «sobran». El signo lo pone el servidor. */
export function shortageWord(qty: string | null | undefined): "faltan" | "sobran" | null {
  if (qty === null || qty === undefined) return null
  if (qty.startsWith("-")) return "sobran"
  if (qty === "0") return null
  return "faltan"
}

/** El número sin signo, para escribirlo después de «faltan»/«sobran». */
export function withoutSign(qty: string): string {
  return qty.startsWith("-") ? qty.slice(1) : qty
}

/** El destino de un aviso del conteo por área: la pestaña con el detalle del conteo abierto. */
export function areaCountHref(countId: number): string {
  return `/admin/inventario?tab=por-area&conteo=${countId}`
}

/** «Faltan 500 g de Carne» / «Sobran 2 und de Huevos», con el signo que manda el servidor. */
export function flagPhrase(flag: AreaCountFlagOut): string {
  const word = shortageWord(flag.shortage_qty)
  if (word === null) return `${flag.ingredient_name} cuadra`
  const verb = word === "faltan" ? "Faltan" : "Sobran"
  return `${verb} ${qtyText(withoutSign(flag.shortage_qty), flag.base_unit)} de ${flag.ingredient_name}`
}
