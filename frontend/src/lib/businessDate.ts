/**
 * Fecha operativa de negocio (`business_date`, `America/Bogota`) e instantes
 * UTC. **Prohibido** `new Date("YYYY-MM-DD")` (el motor lo interpreta como
 * medianoche UTC y, al formatear en la zona local del navegador, puede
 * mostrar el día anterior) y `toISOString().slice(0, 10)` (deriva la fecha
 * de un instante UTC en vez de usar la columna propia). Ver AGENTS.md y
 * `docs/SPEC-NEGOCIO.md § 11.8`.
 */

export interface BusinessDateParts {
  y: number;
  m: number;
  d: number;
}

const BUSINESS_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parsea "YYYY-MM-DD" a sus partes numéricas sin pasar por `new Date(string)`. */
export function parseBusinessDate(value: string): BusinessDateParts {
  const match = BUSINESS_DATE_RE.exec(value);
  if (!match) {
    throw new Error(`Fecha de negocio inválida: "${value}"`);
  }
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

const WEEKDAY_FORMATTER = new Intl.DateTimeFormat("es-CO", {
  weekday: "short",
  timeZone: "UTC",
});
const DAY_MONTH_YEAR_FORMATTER = new Intl.DateTimeFormat("es-CO", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * "2026-09-14" → "lun 14 sep 2026". Ancla el día calendario con
 * `Date.UTC(y, m-1, d)` (no `new Date(string)`) y formatea también en
 * `timeZone: "UTC"`, así el resultado no depende de la zona del navegador
 * que corre el código ni se corre un día.
 */
export function formatBusinessDate(value: string | null | undefined): string {
  if (!value) return "—";
  const { y, m, d } = parseBusinessDate(value);
  const anchor = new Date(Date.UTC(y, m - 1, d));
  const weekday = WEEKDAY_FORMATTER.format(anchor).replace(/\.$/, "");
  const rest = DAY_MONTH_YEAR_FORMATTER.format(anchor).replace(/\./g, "");
  return `${weekday} ${rest}`;
}

const INSTANT_FORMATTER = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** Instante ISO-8601 con `Z` → texto legible en hora de Bogotá. */
export function formatInstant(iso: string | null | undefined): string {
  if (!iso) return "—";
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return "—";
  return INSTANT_FORMATTER.format(instant).replace(/\./g, "");
}
