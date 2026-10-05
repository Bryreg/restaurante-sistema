import { formatClockTime } from "@/lib/businessDate"

/**
 * Lo que comparten la barra de la vida de un insumo, la pestaña Línea de
 * tiempo y la ficha del insumo: la unidad en palabras, la regla de tiempo y
 * cómo se dice una duración. Sólo formato y posición en el dibujo: ninguna
 * cantidad ni plata se calcula acá (`app.inventory.timeline`).
 */

/** Unidad base en palabras («und» y no «unit»). */
export const UNIDAD: Record<string, string> = { g: "g", ml: "ml", unit: "und" }

function ms(iso: string): number {
  return new Date(iso).getTime()
}

export const HORA_MS = 3_600_000
export const DIA_MS = 86_400_000

const DIA_CORTO = new Intl.DateTimeFormat("es-CO", { timeZone: "UTC", weekday: "short", day: "numeric" })

export interface MarcaEje {
  u: number
  texto: string
}

/**
 * Las marcas de la regla de tiempo: sin ellas la barra dice «bajó al
 * principio» pero no «qué día». Unas diez etiquetas, sea el rango de un día
 * (cada tres horas) o de dos meses (cada semana).
 */
export function marcasEje(dateFrom: string, startAt: string, endAt: string): MarcaEje[] {
  const t0 = ms(startAt)
  const span = ms(endAt) - t0
  if (!(span > 0)) return []
  const marcas: MarcaEje[] = []
  if (span <= DIA_MS * 1.5) {
    for (let k = 0; k * 3 * HORA_MS < span; k += 1) {
      const t = t0 + k * 3 * HORA_MS
      marcas.push({ u: (t - t0) / span, texto: formatClockTime(new Date(t).toISOString()).replace(":00", "") })
    }
    return marcas
  }
  const dias = Math.round(span / DIA_MS)
  const paso = [1, 2, 3, 7, 14].find((p) => dias / p <= 10) ?? 14
  const base = new Date(`${dateFrom}T12:00:00Z`)
  for (let i = 0; i < dias; i += paso) {
    const d = new Date(base)
    d.setUTCDate(base.getUTCDate() + i)
    marcas.push({ u: i / dias, texto: DIA_CORTO.format(d).replace(".", "") })
  }
  return marcas
}

/** «3 h», «2 d 4 h», «25 min»: cuánto tiempo, en lo que se lee rápido. */
export function duracion(segundos: number): string {
  const minutos = Math.round(segundos / 60)
  if (minutos < 60) return `${Math.max(1, minutos)} min`
  const horas = Math.round(minutos / 60)
  if (horas < 24) return `${horas} h`
  const dias = Math.floor(horas / 24)
  const resto = horas % 24
  return resto ? `${dias} d ${resto} h` : `${dias} d`
}

const CORTA = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 0, useGrouping: "always" })
const FINA = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 2, useGrouping: "always" })

/**
 * Una cantidad para LEER de un vistazo: «19.287 g» y no «19.287,349 g»; los
 * decimales sólo cuando el número es chico («0,5 und»). La cifra exacta
 * sigue en la ficha y en el libro de movimientos.
 */
export function cantidadCorta(texto: string, unidad: string): string {
  const n = Number(texto)
  if (!Number.isFinite(n)) return "—"
  const cifra = Math.abs(n) >= 100 ? CORTA.format(n) : FINA.format(n)
  return `${cifra} ${unidad}`
}
