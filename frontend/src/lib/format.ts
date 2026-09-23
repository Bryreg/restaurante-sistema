/**
 * Formatos de presentación en español de Colombia que no son plata (la
 * plata vive en `./money`). Un solo lugar para el porcentaje, la duración,
 * la cantidad y la fecha corta: antes convivían «12%», «12,5 %» y «12.34 %»
 * (informe de visualización, hallazgo 14).
 *
 * Nada de acá calcula una cifra: recibe lo que mandó el backend y lo
 * escribe. `null`/`undefined` es «—», nunca «0».
 */

const SIN_DATO = "—"

/** Espacio fino que no corta: «12,3 %» sin que el «%» quede solo en otro renglón. */
const ESPACIO_FINO = " "

function esNumero(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n)
}

const PCT_CACHE = new Map<number, Intl.NumberFormat>()

/**
 * Un porcentaje que llega en **puntos básicos** (10.000 = 100 %), como lo
 * manda el backend (`*_bp`), escrito «12,3 %». Pasar de puntos básicos a
 * por ciento es cambiar de unidad para escribirlo, no una cuenta nueva.
 */
export function formatPct(bp: number | null | undefined, decimales = 1): string {
  if (!esNumero(bp)) return SIN_DATO
  let formato = PCT_CACHE.get(decimales)
  if (!formato) {
    formato = new Intl.NumberFormat("es-CO", {
      minimumFractionDigits: decimales,
      maximumFractionDigits: decimales,
      useGrouping: "always",
    })
    PCT_CACHE.set(decimales, formato)
  }
  return `${formato.format(bp / 100)}${ESPACIO_FINO}%`
}

/**
 * Una duración en minutos: «16 h 8 min», «45 min», «< 1 min». Nunca
 * «968 min» ni «0 min» para algo que duró 29 segundos.
 */
export function formatDuracion(minutos: number | null | undefined): string {
  if (!esNumero(minutos)) return SIN_DATO
  if (minutos < 0) return `−${formatDuracion(-minutos)}`
  if (minutos === 0) return "0 min"
  if (minutos < 1) return "< 1 min"
  const total = Math.round(minutos)
  const horas = Math.floor(total / 60)
  const resto = total % 60
  if (horas === 0) return `${resto} min`
  return resto === 0 ? `${horas} h` : `${horas} h ${resto} min`
}

const CANTIDAD = new Intl.NumberFormat("es-CO", {
  maximumFractionDigits: 3,
  useGrouping: "always",
})

/**
 * Una cantidad con su unidad: «0,024 unidad», «10.000 g». Acepta el texto
 * decimal que manda el backend para cantidades («"0.024"»). Hasta tres
 * decimales, que es la precisión con la que se cuenta inventario.
 */
export function formatCantidad(
  n: number | string | null | undefined,
  unidad: string,
): string {
  if (n === null || n === undefined) return SIN_DATO
  const numero = typeof n === "string" ? Number(n.trim()) : n
  if (typeof n === "string" && n.trim() === "") return SIN_DATO
  if (!esNumero(numero)) return SIN_DATO
  const cifra = CANTIDAD.format(numero)
  return unidad ? `${cifra} ${unidad}` : cifra
}

const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"] as const
const MESES = [
  "ene", "feb", "mar", "abr", "may", "jun",
  "jul", "ago", "sep", "oct", "nov", "dic",
] as const

/**
 * «vie 18 sep» a partir de una fecha ISO («2026-09-18»). Si llega un
 * instante completo se toma la fecha tal como viene escrita (los días
 * operativos del backend ya son fechas, no instantes): no se corre de zona
 * horaria en el navegador.
 */
export function formatFechaCorta(iso: string | null | undefined): string {
  if (!iso) return SIN_DATO
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim())
  if (!m) return SIN_DATO
  const anio = Number(m[1])
  const mes = Number(m[2])
  const dia = Number(m[3])
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return SIN_DATO
  const semana = new Date(Date.UTC(anio, mes - 1, dia)).getUTCDay()
  return `${DIAS[semana]} ${dia} ${MESES[mes - 1]}`
}
