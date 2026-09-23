/**
 * Los titulares que CONCLUYEN de Analítica (analista #5, #6 y #11;
 * científico #7, #8 y #15), armados sólo con cifras del servidor. Van
 * aparte de los componentes para probarlos con números concretos. Acá se
 * eligen filas, se cuentan y se escribe: nunca se suma, resta ni divide
 * plata ni porcentajes.
 */
import type { MenuClassCountsOut, SustainedHealthOut, VarianceByDishOut } from "@/api/analytics"
import { formatPuntos } from "@/features/inventory/lib"
import { formatCOP } from "@/lib/money"

function sinSigno(texto: string): string {
  return texto.replace(/^[-−]/, "")
}

function enumerar(partes: string[]): string {
  if (partes.length <= 1) return partes.join("")
  return `${partes.slice(0, -1).join(", ")} y ${partes[partes.length - 1]}`
}

/**
 * Qué hacer con cada clase, en el orden en que conviene leerlo: primero lo
 * que hay que sacar. Es la MISMA frase que manda el backend en
 * `recommended_action` por fila; acá sólo se usa para nombrar el resumen
 * de `counts_by_class`.
 */
const ACCION_POR_CLASE: { clase: keyof MenuClassCountsOut; accion: string }[] = [
  { clase: "dog", accion: "para sacar o rediseñar" },
  { clase: "plowhorse", accion: "para revisar precio" },
  { clase: "puzzle", accion: "para promocionar" },
  { clase: "star", accion: "para mantener" },
]

/**
 * «3 para sacar o rediseñar, 7 para revisar precio, 4 para promocionar y 5
 * para mantener». Después, lo que no se clasificó y por qué.
 */
export function menuResumen(c: MenuClassCountsOut): { titular: string; aparte: string | null } {
  const partes = ACCION_POR_CLASE.filter(({ clase }) => c[clase] > 0).map(({ clase, accion }) => `${c[clase]} ${accion}`)
  const titular = partes.length ? enumerar(partes) : "Ningún plato alcanzó a clasificarse"
  const fuera: string[] = []
  if (c.insufficient_sample > 0) {
    fuera.push(`${c.insufficient_sample} con muestra chica`)
  }
  if (c.unclassified > 0) {
    fuera.push(`${c.unclassified} sin costo suficiente`)
  }
  return { titular, aparte: fuera.length ? `Sin clasificar: ${enumerar(fuera)}.` : null }
}

/**
 * «Sobran $ 146.772 netos en la ventana; el faltante más grande es Pechuga
 * a la plancha, $ 33.021». El neto es `total_variance_value` (positivo =
 * faltante); el faltante más grande es la primera fila de faltante, porque
 * el servidor las manda primero y por tamaño.
 */
export function varianceByDishTitular(d: VarianceByDishOut): string {
  const total = d.total_variance_value
  let base: string
  if (total === null || total === undefined) base = "Varianza por plato sin total valorizado"
  else if (total > 0) base = `Faltan ${formatCOP(total)} netos en la ventana`
  else if (total < 0) base = `Sobran ${sinSigno(formatCOP(total))} netos en la ventana`
  else base = "La ventana cuadra en neto"
  const peor = (d.rows ?? []).find((r) => r.direction === "shortage" && r.variance_value !== null && r.variance_value !== undefined)
  if (!peor) return base
  return `${base}; el faltante más grande es ${peor.product_name ?? `#${peor.product_id}`}, ${formatCOP(peor.variance_value)}`
}

/**
 * La conclusión de la salud sostenida sobre la última ventana evaluada y la
 * regla del umbral rojo: «La brecha está en 2,1 puntos, por debajo del rojo
 * (4,0 puntos)». Si está sostenida en rojo, eso manda.
 */
export function sustainedTitular(d: SustainedHealthOut): string {
  const ventanas = d.windows ?? []
  const ultima = ventanas[ventanas.length - 1]
  const rojo = d.red_threshold_bp === undefined ? null : formatPuntos(d.red_threshold_bp)
  if (d.sustained_red === true) {
    const ultimas = ventanas.slice(-3)
    const pasan = ultimas.filter((w) => w.exceeds_red).length
    return `Brecha sostenida en rojo: ${pasan} de las últimas ${ultimas.length} ventanas pasan el umbral${rojo ? ` (${rojo})` : ""}`
  }
  if (!ultima || ultima.gap_bp === undefined) {
    return d.sustained_red === false ? "La brecha no se sostiene en rojo" : "Todavía no se puede decir si la brecha se sostiene"
  }
  const regla = rojo ? ` del rojo (${rojo})` : " del umbral rojo"
  if (ultima.gap_bp < 0) {
    return `En la última ventana el real queda ${formatPuntos(ultima.gap_bp, { sinSigno: true })} por debajo del teórico: lejos${regla}`
  }
  return `La brecha está en ${formatPuntos(ultima.gap_bp)}, ${ultima.exceeds_red ? "por encima" : "por debajo"}${regla}`
}
