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

const WEEKDAY_ABBR = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MONTH_ABBR = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/**
 * "2026-09-14" → "lun 14 sep 2026". Ancla el día calendario con
 * `Date.UTC(y, m-1, d)` (no `new Date(string)`) y lee el día de la semana
 * con `getUTCDay()` — cálculo de calendario puro, sin pasar por `Intl` ni
 * por la zona del navegador — para que el resultado no dependa de dónde
 * corre el código ni de qué datos de ICU tenga instalados.
 */
export function formatBusinessDate(value: string | null | undefined): string {
  if (!value) return "—";
  const { y, m, d } = parseBusinessDate(value);
  const anchor = new Date(Date.UTC(y, m - 1, d));
  const weekday = WEEKDAY_ABBR[anchor.getUTCDay()];
  const month = MONTH_ABBR[anchor.getUTCMonth()];
  return `${weekday} ${String(d).padStart(2, "0")} ${month} ${y}`;
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

const CLOCK_FORMATTER = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  hour: "numeric",
  minute: "2-digit",
});

/**
 * `en-CA` da «2026-09-22», que se compara como texto sin pasar por ninguna
 * aritmética de fechas. La zona es **Bogotá**, no la del navegador: un
 * administrador mirando desde Madrid no cambia qué día es acá.
 */
const DAY_KEY_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Bogota",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * ¿Ese instante cayó hoy, en Bogotá? Es la pregunta de «¿hace falta escribir
 * la fecha o basta la hora?» — no la del DÍA OPERATIVO, que depende de la
 * hora de corte de la sede y lo decide el servidor. Para elegir formato
 * alcanza el día de calendario: una comanda de anoche que cruzó la medianoche
 * muestra la fecha, que es exactamente lo que hay que ver.
 */

/**
 * Sólo la hora de reloj, en Bogotá: «7:48 p. m.».
 *
 * Para cuando la fecha ya está dicha en otro lado y repetirla es ruido — la
 * cabecera de una comanda abierta hace veinte minutos no necesita decir el
 * año (`m2b`: «Abierta 7:48 p. m. · lleva 52 min»). Cuando la fecha SÍ
 * importa —una comanda de ayer— se usa `formatInstant`, que la trae.
 */
export function isTodayInBogota(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return false;
  return DAY_KEY_FORMATTER.format(instant) === DAY_KEY_FORMATTER.format(new Date());
}

export function formatClock(iso: string | null | undefined): string {
  if (!iso) return "—";
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return "—";
  return CLOCK_FORMATTER.format(instant).replace(/\u202f/g, " ");
}
