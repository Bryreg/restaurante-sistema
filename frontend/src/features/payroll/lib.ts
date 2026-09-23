/**
 * Utilidades puras y compartidas de "Nómina y propinas": etiquetas y fechas
 * de filtro por defecto — nunca plata ni horas derivadas (AGENTS.md § "una
 * sola matemática, en el backend"). `todayLocal`/`daysAgoLocal` reexportan
 * `todayInBogota`/`daysAgoInBogota` de `features/reports/lib.ts` (mismo
 * patrón que `features/inventory/lib.ts`).
 */
import type { PayrollRunSummaryOut, TipDistributionMethod } from "@/api/payroll"
import { daysAgoInBogota, formatRangoCorto, todayInBogota } from "@/features/reports/lib"
import { formatPct } from "@/lib/format"

export const todayLocal = todayInBogota
export const daysAgoLocal = daysAgoInBogota

/** D-3: los tres métodos de reparto de propinas, "por horas" de default. */
export const TIP_METHOD_LABEL: Record<TipDistributionMethod, string> = {
  equal_shares: "Partes iguales",
  by_hours: "Por horas trabajadas",
  by_area: "Por área",
}

export function tipMethodLabel(method: string): string {
  return TIP_METHOD_LABEL[method as TipDistributionMethod] ?? method
}

/** `now` en el navegador para `<input type="datetime-local">`, tal cual la
 * pide `paid_at` — la zona la pone el servidor, nunca este archivo. */
export function nowLocalDatetime(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`
}

/** El titular de la pestaña: la liquidación más reciente, en proporción a la venta. */
export function runsHeadline(runs: PayrollRunSummaryOut[]): string | null {
  // La más reciente por fecha de cierre del período (elegir, no calcular).
  const ultima = [...runs].sort((a, b) => (b.date_to ?? "").localeCompare(a.date_to ?? "") || b.id - a.id)[0]
  if (!ultima || !ultima.available) return null
  const pct = ultima.payroll_pct_of_sales_bp ?? null
  if (pct === null) return null
  const base = `La nómina del ${formatRangoCorto(ultima.date_from ?? "", ultima.date_to ?? "")} se lleva el ${formatPct(pct)} de la venta`
  const d = ultima.delta_bp ?? null
  if (d === null) return base
  if (d === 0) return `${base}, igual que la anterior`
  return `${base} y ${d > 0 ? "subió" : "bajó"} ${formatPct(d > 0 ? d : -d)} contra la anterior`
}

