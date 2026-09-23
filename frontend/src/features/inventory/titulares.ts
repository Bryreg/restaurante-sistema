/**
 * Los titulares que CONCLUYEN de Salud del control y Varianza (informe del
 * analista #1 y #12; del científico #3 y #9), armados sólo con cifras del
 * servidor. Van aparte de los componentes para probarlos con números
 * concretos. Ninguna función de acá suma, resta ni divide plata o
 * porcentajes: eligen, cuentan filas y escriben.
 */
import type { FoodCostOut, VarianceOut, VarianceParetoRowOut } from "@/api/inventory"
import { formatPct } from "@/lib/format"
import { formatCOP } from "@/lib/money"

import { formatPuntos } from "./lib"

/** La cifra sin el signo, para decirla con palabras («$ 238.915 de sobrante»): se quita el «-» del texto, no se hace ninguna cuenta. */
export function sinSigno(texto: string): string {
  return texto.replace(/^[-−]/, "")
}

function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`
}

/**
 * «Real 38,0 % vs teórico 33,0 %: se pierden 5,0 puntos». La brecha es la
 * del servidor (`gap_bp` = real − teórico); si es negativa se dice «por
 * debajo», no «se pierden −15 puntos». `null` si no hay food cost real.
 */
export function foodCostTitular(fc: FoodCostOut): string | null {
  if (fc.pct_bp === null) return null
  const real = formatPct(fc.pct_bp)
  if (fc.theoretical_pct_bp === null) return `Food cost real ${real}; sin teórico con qué compararlo`
  const teo = formatPct(fc.theoretical_pct_bp)
  const gap = fc.gap_bp
  if (gap === null) return `Real ${real} vs teórico ${teo}`
  if (gap > 0) return `Real ${real} vs teórico ${teo}: se pierden ${formatPuntos(gap)}`
  if (gap < 0) return `Real ${real} vs teórico ${teo}: el real queda ${formatPuntos(gap, { sinSigno: true })} por debajo`
  return `Real ${real}, igual al teórico`
}

/**
 * Cuántos insumos (en el orden del Pareto que manda el servidor) hacen
 * falta para llegar al 80 % de la varianza: el primero cuyo acumulado del
 * servidor alcanza 8.000 bp. Es contar filas, no sumar plata.
 */
export function insumosHasta80(pareto: readonly VarianceParetoRowOut[]): number | null {
  const i = pareto.findIndex((p) => p.cumulative_bp >= 8000)
  return i < 0 ? null : i + 1
}

/**
 * «$ 331.058 de varianza entre faltantes y sobrantes: 3 insumos explican el
 * 80 %». Sin renglones valorizados, lo dice.
 */
export function varianceTitular(v: VarianceOut): string {
  if (v.total_abs_variance_value === null || v.pareto.length === 0) {
    return "Sin varianza valorizada entre estos dos conteos"
  }
  const total = `${formatCOP(v.total_abs_variance_value)} de varianza entre faltantes y sobrantes`
  const k = insumosHasta80(v.pareto)
  if (k === null) return total
  if (k === 1) return `${total}: un solo insumo explica el 80 %`
  return `${total}: ${k} insumos explican el 80 %`
}

/** «$ 92.143 de faltante y $ 238.915 de sobrante · 2 sin costo, no entran». */
export function varianceDetalle(v: VarianceOut): string {
  const partes: string[] = []
  if (v.shortage_value !== null && v.surplus_value !== null) {
    partes.push(`${formatCOP(v.shortage_value)} de faltante y ${sinSigno(formatCOP(v.surplus_value))} de sobrante`)
  }
  if (v.unvalued_rows > 0) {
    partes.push(`${plural(v.unvalued_rows, "insumo", "insumos")} sin costo, no ${v.unvalued_rows === 1 ? "entra" : "entran"}`)
  }
  return partes.join(" · ")
}
