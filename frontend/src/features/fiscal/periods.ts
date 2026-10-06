/** Atajos de período para exportar la evidencia fiscal (c7). Fechas de
 * negocio `YYYY-MM-DD`; no es plata, sólo calendario. */

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Hoy en Bogotá, `YYYY-MM-DD` (la fecha de negocio no sale del reloj UTC). */
export function todayBogota(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date());
}

/** El mes calendario anterior al de hoy: el período que se guarda cada mes. */
export function previousMonth(today: string): { from: string; to: string } {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const year = m === 1 ? y - 1 : y;
  const month = m === 1 ? 12 : m - 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(lastDay)}` };
}

/** El año calendario anterior completo. */
export function previousYear(today: string): { from: string; to: string } {
  const y = Number(today.slice(0, 4)) - 1;
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}
