/**
 * Utilidades puras y compartidas de "Nómina y propinas": etiquetas y fechas
 * de filtro por defecto — nunca plata ni horas derivadas (AGENTS.md § "una
 * sola matemática, en el backend"). `todayLocal`/`daysAgoLocal` reexportan
 * `todayInBogota`/`daysAgoInBogota` de `features/reports/lib.ts` (mismo
 * patrón que `features/inventory/lib.ts`).
 */
import type { TipDistributionMethod } from "@/api/payroll"
import { daysAgoInBogota, todayInBogota } from "@/features/reports/lib"

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
