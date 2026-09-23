/**
 * Los titulares que CONCLUYEN de Punto de equilibrio y Utilidad (informe de
 * visualización #2), armados sólo con cifras del servidor. Van aparte de
 * los componentes para poder probarlos con números concretos.
 */
import type { BreakEvenOut, ProfitLine, ProfitOut, ProfitPeriodOut } from "@/api/expenses"
import { formatPct } from "@/lib/format"
import { formatCOP } from "@/lib/money"

function dias(n: number): string {
  return `${n} ${n === 1 ? "día" : "días"}`
}

/**
 * La conclusión del período, armada sólo con cifras del servidor. Los días
 * que le quedan al período son una cuenta de días del calendario (contar,
 * no plata): sirve para no prometer «lo pasás en 2 días» cuando el período
 * termina hoy.
 */
export function breakEvenHeadline(d: BreakEvenOut): string {
  const gap = d.gap_amount ?? null
  if (!d.available || d.break_even_amount === null || gap === null) return "Punto de equilibrio no disponible"
  if (gap === 0) {
    return `Ya pasaste el punto de equilibrio: el período ya cubre sus ${formatCOP(d.fixed_costs)} de costos fijos`
  }
  const faltan = `Te faltan ${formatCOP(gap)} para el punto de equilibrio`
  const ritmo = d.days_to_break_even_at_current_pace ?? null
  const transcurridos = d.days_elapsed ?? null
  if (ritmo === null || transcurridos === null || d.days_in_period === undefined) {
    return `${faltan}: el período cerró por debajo, en pérdida`
  }
  const quedan = d.days_in_period - transcurridos
  if (ritmo <= quedan) return `${faltan}; a este ritmo lo pasás en ${dias(ritmo)}`
  return quedan === 0
    ? `${faltan}; a este ritmo harían falta ${dias(ritmo)} más y el período termina hoy`
    : `${faltan}; a este ritmo harían falta ${dias(ritmo)} y al período le quedan ${dias(quedan)}`
}

export type LineKey = ProfitLine["key"]

/** Cómo se nombra cada costo en el titular, con su verbo en número. */
const SUJETO: Partial<Record<LineKey, { quien: string; verbo: string }>> = {
  cost: { quien: "el costo de lo vendido", verbo: "se come" },
  payroll: { quien: "la nómina", verbo: "se come" },
  obligations: { quien: "las obligaciones", verbo: "se comen" },
  expenses: { quien: "los gastos", verbo: "se comen" },
}

const COSTOS: LineKey[] = ["cost", "payroll", "obligations", "expenses"]

/** La cifra sin el signo, para decirla con palabras («Perdiste $ 973.428»): se quita el «-» del texto, no se hace ninguna cuenta. */
function sinSigno(texto: string): string {
  return texto.replace(/^[-−]/, "")
}

export function lineOf(p: ProfitPeriodOut | null | undefined, key: LineKey): ProfitLine | null {
  return p?.lines?.find((l) => l.key === key) ?? null
}

/** El renglón de costo que más pesa sobre la venta (seleccionar, no calcular). */
function costoMayor(p: ProfitPeriodOut): ProfitLine | null {
  let mayor: ProfitLine | null = null
  for (const key of COSTOS) {
    const l = lineOf(p, key)
    if (l?.pct_of_sales_bp === null || l?.pct_of_sales_bp === undefined) continue
    if (mayor === null || l.pct_of_sales_bp > (mayor.pct_of_sales_bp as number)) mayor = l
  }
  return mayor
}

/** El titular que concluye, con las cifras tal como las manda el servidor. */
export function profitHeadline(d: ProfitOut): string {
  if (!d.available || d.profit === null) return "Utilidad no disponible"
  const utilidad = lineOf(d, "profit")
  const mayor = costoMayor(d)
  const peso = mayor && SUJETO[mayor.key] ? `${SUJETO[mayor.key]!.quien} ${SUJETO[mayor.key]!.verbo} el ${formatPct(mayor.pct_of_sales_bp)} de la venta` : null
  if (d.profit < 0) {
    return `Perdiste ${sinSigno(formatCOP(d.profit))}${peso ? `: ${peso}` : ""}`
  }
  if (d.profit === 0) return `El período empató: ni ganó ni perdió${peso ? `; ${peso}` : ""}`
  const queda = utilidad?.pct_of_sales_bp
  return `Ganaste ${formatCOP(d.profit)}${queda === null || queda === undefined ? "" : `: te queda el ${formatPct(queda)} de la venta`}`
}

