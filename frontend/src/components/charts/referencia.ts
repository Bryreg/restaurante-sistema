/**
 * Lo que `BarrasConReferencia` y `HorarioGantt` comparten y no es un
 * componente: de qué lado de la raya quedó un punto (comparar, no calcular)
 * y ubicar un instante en la hora de reloj de Bogotá para dibujarlo.
 */

export type LadoMalo = "encima" | "debajo"

/** ¿Quedó del lado malo de su raya? Lo del backend manda. */
export function estaFuera(
  valor: number | null,
  referencia: number | null | undefined,
  malo: LadoMalo,
  fuera?: boolean,
): boolean {
  if (fuera !== undefined) return fuera
  if (valor === null || referencia === null || referencia === undefined) return false
  return malo === "encima" ? valor > referencia : valor < referencia
}

const HORA_BOGOTA = new Intl.DateTimeFormat("en-GB", {
  timeZone: "America/Bogota",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})

/** Minutos de reloj en Bogotá (0–1439) de un instante ISO; `null` si no se lee. */
export function minutosBogota(iso: string): number | null {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const partes = HORA_BOGOTA.formatToParts(new Date(t))
  const h = Number(partes.find((p) => p.type === "hour")?.value)
  const m = Number(partes.find((p) => p.type === "minute")?.value)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  return h * 60 + m
}

/** «6 a. m.», «12 p. m.», «12 a. m.» para las marcas del eje. */
export function etiquetaHora(h: number): string {
  const hh = ((h % 24) + 24) % 24
  if (hh === 0) return "12 a. m."
  if (hh < 12) return `${hh} a. m.`
  if (hh === 12) return "12 p. m."
  return `${hh - 12} p. m.`
}
