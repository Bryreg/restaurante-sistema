/**
 * Cómo se LEE la confiabilidad de un proveedor (informe de visualización #9,
 * científico #5). Las cifras las calcula el backend por insumo
 * (`GET /admin/suppliers/reliability`); acá sólo se deciden los umbrales de
 * alerta y se escriben con signo y flecha. Comparar un `_bp` del servidor
 * contra un umbral no es calcular plata.
 *
 * Los umbrales, y por qué:
 * · Recibido ÷ facturado: debajo de 99 % ya se está pagando algo que no
 *   entró (ámbar); debajo de 95 %, uno de cada veinte pesos facturados no
 *   llegó (rojo: es faltante, el único uso del rojo).
 * · Deriva de precio: una subida de 5 % o más contra la compra anterior del
 *   mismo insumo pide mirar (ámbar); de 10 % o más, renegociar o cambiar de
 *   proveedor (rojo: es plata que sale de más). Una BAJADA nunca es alerta.
 * · Muestra chica: con menos de 5 recepciones en el rango un solo pedido
 *   raro mueve la mediana entera; la cifra se muestra, marcada.
 */
import type { RowStatus } from "@/components/admin"
import type { StatTileTone } from "@/components/StatTile"
import { formatPct } from "@/lib/format"

export const RECIBIDO_AMBAR_BP = 9900
export const RECIBIDO_ROJO_BP = 9500
export const DERIVA_AMBAR_BP = 500
export const DERIVA_ROJO_BP = 1000
export const MUESTRA_CHICA_RECEPCIONES = 5

export type Tono = "none" | "warning" | "critical"

export function tonoRecibido(bp: number | null | undefined): Tono {
  if (bp === null || bp === undefined) return "none"
  if (bp < RECIBIDO_ROJO_BP) return "critical"
  if (bp < RECIBIDO_AMBAR_BP) return "warning"
  return "none"
}

export function tonoDeriva(bp: number | null | undefined): Tono {
  if (bp === null || bp === undefined) return "none"
  if (bp >= DERIVA_ROJO_BP) return "critical"
  if (bp >= DERIVA_AMBAR_BP) return "warning"
  return "none"
}

/** El tono de `StatTile` para un `Tono` de acá. */
export function tonoTarjeta(t: Tono): StatTileTone {
  return t === "none" ? "default" : t
}

export function peorTono(...tonos: Tono[]): RowStatus {
  if (tonos.includes("critical")) return "critical"
  if (tonos.includes("warning")) return "warning"
  return "none"
}

/** «▲ +2,9 %» / «▼ −1,2 %» / «= 0,0 %», con el signo tal como llegó. */
export function formatDeriva(bp: number | null | undefined): string {
  if (bp === null || bp === undefined) return "—"
  if (bp > 0) return `▲ +${formatPct(bp)}`
  if (bp < 0) return `▼ −${formatPct(bp).replace(/^-/, "")}`
  return `= ${formatPct(0)}`
}
