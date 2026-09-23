/**
 * Lo que no es componente en Admin → Dinero: la pestaña que pide la URL y
 * el titular del resumen de caja (informe de visualización #10). Nada de
 * acá suma plata: lee lo que manda `GET /admin/shifts/summary`.
 */
import type { ShiftCashSummary } from "@/api/shifts";
import { formatCOP } from "@/lib/money";

/**
 * La pestaña que pide la URL. `?tab=historial` es a donde enlaza el aviso de
 * caja de Hoy (`features/reports/lib.ts`, `cash_diff_summary`); antes la
 * página lo ignoraba y abría siempre Operacional. Acepta también los valores
 * internos viejos (`operational`/`history`) por si quedó algún enlace.
 */
export type MoneyTab = "operacional" | "historial";

export function moneyTabFromParam(value: string | null): MoneyTab {
  if (value === "historial" || value === "history") return "historial";
  return "operacional";
}

/** La cifra con su signo tal como la manda el servidor, con el menos tipográfico. */
export function conSigno(v: number): string {
  const t = formatCOP(v).replace(/^-/, "−");
  return v > 0 ? `+${t}` : t;
}

export function cierres(n: number): string {
  return `${n} ${n === 1 ? "cierre" : "cierres"}`;
}

/**
 * El titular de Dinero › Historial (informe de visualización #10): «7 de 14
 * cierres con faltante, −$ 68.000». Cuenta y plata vienen de
 * `GET /admin/shifts/summary`; acá no se suma nada.
 */
export function cashSummaryHeadline(s: ShiftCashSummary): string {
  if (s.counted_count === 0) {
    return s.closed_count === 0 ? "No hay cierres en el período" : "Ningún cierre del período se contó todavía";
  }
  if (s.shortage_count === 0) {
    return s.overage_count === 0
      ? `Los ${cierres(s.counted_count)} contados cuadraron`
      : `Ningún faltante en ${cierres(s.counted_count)}; ${s.overage_count} con sobrante (${conSigno(s.overage_total)})`;
  }
  return `${s.shortage_count} de ${cierres(s.counted_count)} con faltante, ${conSigno(s.shortage_total)}`;
}

