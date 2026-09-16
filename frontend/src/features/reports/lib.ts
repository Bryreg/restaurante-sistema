/**
 * Utilidades puras y compartidas de "Hoy"/"Ventas": SOLO etiquetas, rutas y
 * formato de texto — nunca plata ni un KPI recalculado (AGENTS.md § "una
 * sola matemática, en el backend"). `formatPercent` sólo convierte una
 * proporción que YA manda el backend (`sent_at_payment_ratio`, por ejemplo)
 * a texto; no deriva ningún número nuevo, igual que `formatCOP`/
 * `elapsedFromSeconds` en el resto del POS.
 */
import type { AlertLevel } from "@/api/reports"
import type { SalesGroupBy } from "@/api/reports"

export const GROUP_BY_LABEL: Record<SalesGroupBy, string> = {
  business_date: "Día operativo",
  shift: "Turno",
  method: "Medio de pago",
  channel: "Canal",
  employee: "Persona",
  hour: "Hora",
  zone: "Zona",
}

/** `business_date`/`shift` son una secuencia en el tiempo → línea de tendencia;
 * el resto son categorías para comparar entre sí → barras. */
export function isSequentialGroupBy(groupBy: SalesGroupBy): boolean {
  return groupBy === "business_date" || groupBy === "shift"
}

export const METHOD_LABEL: Record<string, string> = {
  cash: "Efectivo",
  card: "Tarjeta",
  transfer: "Transferencia",
  platform: "Plataforma",
  voucher: "Bono",
  other: "Otro",
}

export function methodLabel(method: string): string {
  return METHOD_LABEL[method] ?? method
}

/** Redondea una proporción `[0, 1]` a un porcentaje entero para mostrar; "—" si no hay dato. */
export function formatPercent(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return "—"
  return `${Math.round(ratio * 100)}%`
}

/** `recipe_coverage_pct` (pedido 2a) YA llega como entero 0–100 desde el
 * servidor (`backend/app/reports/service.py _to_out`, `round_half_up`) — a
 * diferencia de `formatPercent`, esto NUNCA multiplica por 100: sólo agrega
 * el signo. `null` es "sin ventas netas en el período", nunca "0 %". */
export function formatPercentInt(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return "—"
  return `${pct}%`
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
}

/**
 * Adónde lleva cada tarjeta de "Requiere tu atención" (SPEC-NEGOCIO §9.3:
 * "cada tarjeta lleva a la pantalla donde se resuelve"). `app.notifications
 * .service.NOTIFICATION_TYPES` es la fuente de los tipos; un tipo nuevo que
 * este mapa no conozca cae al valor por defecto de `alertRoute` en vez de
 * romper la pantalla.
 */
const ALERT_ROUTES: Record<string, AlertRoute> = {
  shift_stale: { to: "/admin/dinero", label: "Ver turno" },
  cash_difference: { to: "/admin/dinero", label: "Ver caja" },
  cash_difference_critical: { to: "/admin/dinero", label: "Ver caja" },
  difference_streak: { to: "/admin/personal", label: "Ver racha por persona" },
  cash_over_threshold: { to: "/admin/dinero", label: "Ver caja" },
  pin_locked: { to: "/admin/personal", label: "Ver personal" },
  product_unavailable: { to: "/admin/carta", label: "Ver carta" },
  discount_rate_high: { to: "/admin/personal", label: "Ver descuentos por persona" },
  courtesy_limit: { to: "/admin/personal", label: "Ver cortesías por persona" },
  void_rate_high: { to: "/admin/personal", label: "Ver anulaciones por persona" },
  order_unsent_too_long: { to: "/admin/pedidos", label: "Ver comanda" },
  order_unpaid_too_long: { to: "/admin/pedidos", label: "Ver comanda" },
  fiscal_rejected: { to: "/admin/fiscal/documentos", label: "Ver documento" },
  fiscal_contingency_overdue: { to: "/admin/fiscal/documentos", label: "Ver documento" },
  fiscal_range_low: { to: "/admin/fiscal/rangos", label: "Ver rango" },
  pending_refund: { to: "/admin/fiscal/devoluciones-pendientes", label: "Ver devolución" },
}

export function alertRoute(type: string): AlertRoute {
  return ALERT_ROUTES[type] ?? { to: "/admin/notifications", label: "Ver notificaciones" }
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
