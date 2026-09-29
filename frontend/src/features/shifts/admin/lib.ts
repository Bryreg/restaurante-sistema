/**
 * Lo que no es componente en Caja › Dinero (Cuadres, 2026-09-29): el estado
 * que pide la URL, las fechas iniciales del filtro y la cifra con signo.
 * Nada de acá suma plata: formatea lo que mandó el servidor.
 */
import type { CuadresStatus, ShiftCashSummary } from "@/api/shifts";
import { formatCOP } from "@/lib/money";

/**
 * El filtro de estado que pide la URL. Las pestañas viejas siguen llevando a
 * algún lado: `?tab=historial` —a donde enlaza el aviso de caja de Hoy— abre
 * los **cerrados**; `?tab=operacional` (o nada) abre **todos**. `?estado=`
 * elige directo (`todos`, `cerrados`, `abiertos`).
 */
export function cuadresStatusFromParams(params: URLSearchParams): CuadresStatus {
  const estado = params.get("estado");
  if (estado === "cerrados" || estado === "closed") return "closed";
  if (estado === "abiertos" || estado === "open") return "open";
  if (estado === "todos" || estado === "all") return "all";
  const tab = params.get("tab");
  if (tab === "historial" || tab === "history") return "closed";
  return "all";
}

/** La cifra con su signo tal como la manda el servidor, con el menos tipográfico. */
export function conSigno(v: number): string {
  const t = formatCOP(v).replace(/^-/, "−");
  return v > 0 ? `+${t}` : t;
}

/**
 * "Hoy" en la zona de la sede, sólo como valor inicial de un filtro de
 * pantalla (nunca como fecha operativa de un registro: esa la sella el
 * servidor con la hora de corte de la sede). Parte de "ahora", no de un
 * `business_date` ya guardado.
 */
export function todayInBogota(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date());
}

/** El primer día del mes de hoy (Bogotá): el «Desde» por defecto de Cuadres. */
export function monthStartInBogota(): string {
  return `${todayInBogota().slice(0, 8)}01`;
}

export function cierres(n: number): string {
  return `${n} ${n === 1 ? "cierre" : "cierres"}`;
}

/**
 * El titular del resumen de caja (informe de visualización #10), arriba de
 * Cuadres: «7 de 14 cierres con faltante, −$ 68.000». Cuenta y plata vienen
 * de `GET /admin/shifts/summary`; acá no se suma nada.
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
