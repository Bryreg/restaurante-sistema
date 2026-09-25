/**
 * Utilidades puras y compartidas de "Hoy"/"Ventas": SOLO etiquetas, rutas y
 * formato de texto — nunca plata ni un KPI recalculado (AGENTS.md § "una
 * sola matemática, en el backend"). Los porcentajes se escriben con
 * `formatPct` (`@/lib/format`): cambiar de unidad para escribir no es una
 * cuenta nueva, igual que `formatCOP`/`elapsedFromSeconds` en el resto del POS.
 */
import type { AlertLevel, SalesGroupBy, SalesLineGroupBy } from "@/api/reports"
import { formatFechaCorta, formatPct } from "@/lib/format"

/** Todo lo que la pestaña «Ventas» sabe agrupar: los cortes del comprobante y los de sus líneas. */
export type SalesGrouping = SalesGroupBy | SalesLineGroupBy

export const GROUP_BY_LABEL: Record<SalesGrouping, string> = {
  business_date: "Día operativo",
  shift: "Turno",
  method: "Medio de pago",
  channel: "Canal",
  employee: "Persona",
  zone: "Zona",
  product: "Plato",
  category: "Categoría",
  hour: "Hora",
}

/** Lo que va en el selector «Agrupar por»: «Por plato», no «Plato». */
export const GROUP_BY_OPTION: Record<SalesGrouping, string> = {
  business_date: "Por día",
  shift: "Por turno",
  hour: "Por hora",
  method: "Por medio de pago",
  channel: "Por canal",
  employee: "Por persona",
  zone: "Por zona",
  product: "Por plato",
  category: "Por categoría",
}

/** `product`/`category` agrupan las LÍNEAS del comprobante: cuentan unidades y no tienen propina. */
export function isLineGroupBy(groupBy: SalesGrouping): groupBy is SalesLineGroupBy {
  return groupBy === "product" || groupBy === "category"
}

export const METHOD_LABEL: Record<string, string> = {
  cash: "Efectivo",
  card: "Tarjeta",
  transfer: "Transferencia",
  nequi: "Nequi",
  daviplata: "Daviplata",
  platform: "Plataforma",
  voucher: "Bono",
  other: "Otro",
}

/**
 * El medio de pago en palabras. La sede puede tener medios propios que este
 * mapa no conoce: esos se escriben con mayúscula inicial («nequi» →
 * «Nequi»), nunca con la llave cruda en minúscula.
 */
export function methodLabel(method: string): string {
  const conocido = METHOD_LABEL[method]
  if (conocido) return conocido
  const limpio = method.replace(/_/g, " ").trim()
  return limpio ? limpio.charAt(0).toLocaleUpperCase("es-CO") + limpio.slice(1) : method
}

/** Una proporción `[0, 1]` que YA mandó el backend, escrita «12 %»; "—" si no hay dato. */
export function formatPercent(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return "—"
  // De proporción a puntos básicos: cambio de unidad para `formatPct`.
  return formatPct(ratio * 10_000, 0)
}

/** `costed_pct` (pedido 2a) YA llega como entero 0–100 desde el
 * servidor (`backend/app/reports/service.py _to_out`, `round_half_up`):
 * se escribe «40 %» con `formatPct` (el ×100 sólo pasa de por ciento a
 * puntos básicos, la unidad de `formatPct`). `null` es "sin ventas netas en
 * el período", nunca "0 %". */
export function formatPercentInt(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return "—"
  return formatPct(pct * 100, 0)
}

/**
 * Una variación que manda el backend en puntos básicos con signo
 * (`delta_bp`), escrita con flecha y palabra además del signo: «▲ 12,3 %»,
 * «▼ 5,2 %». El color nunca es la única señal. `null` → `null` (quien llama
 * dice por qué no hay comparación).
 */
export function formatDelta(bp: number | null | undefined): string | null {
  if (bp === null || bp === undefined || Number.isNaN(bp)) return null
  if (bp > 0) return `▲ ${formatPct(bp)}`
  if (bp < 0) return `▼ ${formatPct(-bp)}`
  return `= ${formatPct(0)}`
}

/** «arriba»/«abajo»/«igual» para un titular armado con `delta_bp`. */
export function deltaWord(bp: number): "arriba" | "abajo" | "igual" {
  return bp > 0 ? "arriba" : bp < 0 ? "abajo" : "igual"
}

const DIA_LARGO = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"] as const

/**
 * «martes» a partir de una fecha operativa ISO (`2026-09-16`). Calendario
 * puro con `Date.UTC` (nunca `new Date(string)`), como `formatBusinessDate`.
 */
export function weekdayName(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return ""
  return DIA_LARGO[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()] ?? ""
}

/** «vie 18» (sin el mes) para los ejes: `formatFechaCorta` sin su tercer palabra. */
export function shortDay(fechaCorta: string): string {
  return fechaCorta.split(" ").slice(0, 2).join(" ")
}

/**
 * El día operativo al que pertenece un instante (`opened_at`), en la zona de
 * la sede y con su hora de corte: lo de las 2 a. m. con corte a las 3 es del
 * día anterior. Sólo calendario —marca «viene de ayer» en una comanda—,
 * nunca la fecha operativa de un registro (ésa la pone el servidor).
 */
export function businessDateOfInstant(iso: string, cutoffHour: number): string | null {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date(t - cutoffHour * 3_600_000))
}

/** Umbral puramente de presentación (no es un cálculo nuevo: sólo clasifica
 * un número que YA manda el servidor, igual que `foodCostInBand` en
 * `features/recipes/costDisplay.tsx`, territorio ajeno, con el mismo
 * patrón). Por debajo de 50 % la mitad de la venta neta no tuvo ficha de
 * verdad: el margen bruto de al lado deja de ser representativo. Declarado
 * acá porque no hay un umbral de negocio para esto en la spec — es una
 * decisión de UI, no una regla que el backend imponga. */
export function recipeCoverageTone(pct: number | null | undefined): "default" | "warning" | "critical" {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return "default"
  if (pct < 50) return "critical"
  if (pct < 80) return "warning"
  return "default"
}

export const ALERT_LEVEL_LABEL: Record<AlertLevel, string> = {
  info: "Información",
  warning: "Atención",
  critical: "Crítico",
}

/** Variantes tokenizadas de `Badge`/`StatTile` — nunca un color crudo. */
export const ALERT_LEVEL_TONE: Record<AlertLevel, "default" | "warning" | "critical"> = {
  info: "default",
  warning: "warning",
  critical: "critical",
}

export interface AlertRoute {
  to: string
  /** Texto del enlace: nombra la pantalla donde se resuelve (SPEC-NEGOCIO §9.1: "nombra la acción correctiva"). */
  label: string
  /**
   * La pantalla **en palabras** para `FilterLink` (`docs/PATRONES-ADMIN.md`
   * § 6): «Inventario», «Dinero», «Documentos». Nunca la ruta cruda — quien
   * lee esto es el dueño de un restaurante, no un programador.
   */
  screen: string
  /** La pestaña en palabras, si el destino tiene pestañas: «Stock», «Rangos». */
  tab?: string
  /** El filtro en palabras, si el enlace lleva uno puesto: «negativos». */
  filter?: string
}

/**
 * Adónde lleva cada tarjeta de "Requiere tu atención" (SPEC-NEGOCIO §9.3:
 * "cada tarjeta lleva a la pantalla donde se resuelve"). `app.notifications
 * .service.NOTIFICATION_TYPES` es la fuente de los tipos; un tipo nuevo que
 * este mapa no conozca cae al valor por defecto de `alertRoute` en vez de
 * romper la pantalla.
 */
const ALERT_ROUTES: Record<string, AlertRoute> = {
  shift_stale: { to: "/admin/dinero", label: "Ver turno", screen: "Dinero", tab: "Operacional" },
  cash_difference: { to: "/admin/dinero", label: "Ver caja", screen: "Dinero", tab: "Operacional" },
  cash_difference_critical: { to: "/admin/dinero", label: "Ver caja", screen: "Dinero", tab: "Operacional" },
  difference_streak: { to: "/admin/personal", label: "Ver racha por persona", screen: "Turnos y personal", tab: "Por persona" },
  cash_over_threshold: { to: "/admin/dinero", label: "Ver caja", screen: "Dinero", tab: "Operacional" },
  pin_locked: { to: "/admin/personal", label: "Ver personal", screen: "Turnos y personal" },
  product_unavailable: { to: "/admin/carta", label: "Ver carta", screen: "Carta" },
  discount_rate_high: { to: "/admin/personal", label: "Ver descuentos por persona", screen: "Turnos y personal", tab: "Por persona" },
  courtesy_limit: { to: "/admin/personal", label: "Ver cortesías por persona", screen: "Turnos y personal", tab: "Por persona" },
  void_rate_high: { to: "/admin/personal", label: "Ver anulaciones por persona", screen: "Turnos y personal", tab: "Por persona" },
  order_unsent_too_long: { to: "/admin/pedidos", label: "Ver comanda", screen: "Pedidos" },
  order_unpaid_too_long: { to: "/admin/pedidos", label: "Ver comanda", screen: "Pedidos" },
  fiscal_rejected: { to: "/admin/fiscal/documentos", label: "Ver documento", screen: "Documentos" },
  fiscal_contingency_overdue: { to: "/admin/fiscal/documentos", label: "Ver documento", screen: "Documentos" },
  fiscal_range_low: { to: "/admin/fiscal/rangos", label: "Ver rango", screen: "Rangos" },
  pending_refund: { to: "/admin/fiscal/devoluciones-pendientes", label: "Ver devolución", screen: "Devoluciones" },
  // Revisión de datos (sep. 2026): todas las diferencias de caja al cierre
  // en un solo aviso. Se resuelven mirando los cierres uno por uno, que es
  // lo que lista el historial de turnos.
  cash_diff_summary: { to: "/admin/dinero?tab=historial", label: "Ver cierres", screen: "Dinero", tab: "Historial" },
}

export function alertRoute(type: string): AlertRoute {
  return ALERT_ROUTES[type] ?? { to: "/admin/notifications", label: "Ver notificaciones", screen: "Notificaciones" }
}

/** "Hoy" en la zona de la sede, sólo como valor inicial de un filtro de pantalla
 * (nunca como fecha operativa de un registro — ver `lib/businessDate.ts`). */
export function todayInBogota(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date())
}

/** `n` días atrás de "ahora" en la zona de la sede, mismo uso acotado que `todayInBogota`. */
export function daysAgoInBogota(days: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(
    new Date(Date.now() - days * 24 * 60 * 60 * 1000),
  )
}

/**
 * «8 al 14 sep» / «28 sep al 4 oct» para nombrar un período en una línea
 * corta (la comparación de la cifra rectora, la base de un gráfico).
 */
export function formatRangoCorto(from: string, to: string): string {
  const [, d1, m1] = formatFechaCorta(from).split(" ")
  const [, d2, m2] = formatFechaCorta(to).split(" ")
  if (!d1 || !d2) return `${from} al ${to}`
  if (from === to) return `${d2} ${m2}`
  return m1 === m2 ? `${d1} al ${d2} ${m2}` : `${d1} ${m1} al ${d2} ${m2}`
}

/** El período de «Informes»: tres atajos y un rango a mano. */
export type Periodo = "hoy" | "semana" | "mes" | "rango"

/** Calendario puro sobre fechas ISO (`Date.UTC`), nunca plata. */
function isoMenosDias(iso: string, dias: number): string {
  const [y, m, d] = iso.split("-").map(Number)
  const f = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1) - dias * 86_400_000)
  const dos = (n: number): string => String(n).padStart(2, "0")
  return `${f.getUTCFullYear()}-${dos(f.getUTCMonth() + 1)}-${dos(f.getUTCDate())}`
}

/** Lunes de la semana de `iso` (la semana arranca el lunes). */
function lunesDe(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number)
  const dow = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1)).getUTCDay()
  return isoMenosDias(iso, (dow + 6) % 7)
}

export function rangoDePeriodo(periodo: Exclude<Periodo, "rango">, hoy: string): { from: string; to: string } {
  if (periodo === "hoy") return { from: hoy, to: hoy }
  if (periodo === "semana") return { from: lunesDe(hoy), to: hoy }
  return { from: `${hoy.slice(0, 8)}01`, to: hoy }
}
