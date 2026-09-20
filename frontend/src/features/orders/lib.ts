/**
 * Utilidades puras y compartidas del dominio comanda: SOLO tiempo y texto,
 * nunca plata (AGENTS.md, CONTRATO-INTERNO §6.1 "una sola matemática, en el
 * backend"). El tiempo transcurrido de una mesa u orden se deriva acá porque
 * el backend no lo manda para `tables/status` (sólo `opened_at`); para cocina
 * el backend ya manda `elapsed_seconds` calculado y este archivo sólo lo
 * formatea.
 */

export function elapsedLabel(fromIso: string | null | undefined, now: Date = new Date()): string {
  if (!fromIso) return "—"
  const from = new Date(fromIso)
  if (Number.isNaN(from.getTime())) return "—"
  const totalSeconds = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 1000))
  return elapsedFromSeconds(totalSeconds)
}

export function elapsedFromSeconds(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return `${hours} h ${rest} min`
}

export const VOID_REASON_LABEL: Record<string, string> = {
  customer_changed_mind: "El cliente cambió de opinión",
  server_error: "Error del mesero",
  kitchen_error: "Error de cocina",
  long_wait: "Espera muy larga",
  walkout: "Se fue sin pagar",
  duplicate: "Duplicado",
  other: "Otro motivo",
}

export const COURTESY_REASON_LABEL: Record<string, string> = {
  complaint: "Queja del cliente",
  promo_owner: "Promoción del dueño",
  guest_of_owner: "Invitado del dueño",
  other: "Otro motivo",
}

export const DISCOUNT_REASON_LABEL: Record<string, string> = {
  promo: "Promoción",
  complaint: "Queja",
  owner: "Cortesía del dueño",
  employee: "Empleado",
  other: "Otro motivo",
}

export const CHANNEL_LABEL: Record<string, string> = {
  counter: "Mostrador",
  dine_in: "Mesa",
  takeout: "Para llevar",
  delivery: "Domicilio",
  platform: "Plataforma",
  staff_meal: "Consumo de personal",
}

export const ORDER_STATUS_LABEL: Record<string, string> = {
  open: "Abierta",
  to_pay: "Por cobrar",
  paid: "Pagada",
  merged: "Fusionada",
  voided: "Anulada",
  // Venta de plataforma cancelada DESPUÉS de preparar (pedido 2c): compensa
  // la venta, nunca genera merma — el insumo se queda descontado. No es
  // "Anulada" a propósito: confundirlas falsearía el reporte de anulaciones.
  compensated: "Venta compensada",
}

export const ITEM_STATUS_LABEL: Record<string, string> = {
  pending: "Pendiente",
  sent: "Enviado",
  ready: "Listo",
  served: "Entregado",
  voided: "Anulado",
}

/** Variantes tokenizadas de `Badge` — nunca un color crudo (AGENTS.md § UI). */
export const ITEM_STATUS_BADGE_VARIANT: Record<string, "outline" | "secondary" | "default" | "destructive"> = {
  pending: "outline",
  sent: "secondary",
  ready: "default",
  served: "secondary",
  voided: "destructive",
}

export const COURSE_LABEL: Record<string, string> = {
  beverage: "Bebida",
  starter: "Entrada",
  main: "Fuerte",
  dessert: "Postre",
}

export const COURSE_BADGE_VARIANT: Record<string, "outline" | "secondary" | "default" | "ghost"> = {
  beverage: "secondary",
  starter: "outline",
  main: "default",
  dessert: "ghost",
}

export function courseLabel(course: string | null | undefined): string {
  if (!course) return "—"
  return COURSE_LABEL[course] ?? course
}

/**
 * Qué precio ya resuelto de `CatalogProductOut.prices` mostrar según el
 * canal de la comanda — sólo elige cuál campo leer, nunca deriva un valor
 * nuevo (el backend ya resolvió el precio del canal en `GET /catalog`; acá
 * se elige el mismo campo que `list_price` usará al agregar el ítem,
 * `app/orders/service.py::_channel_list_price`: counter/dine_in/staff_meal
 * → dine_in, takeout → takeout, delivery → delivery, platform → platform).
 * Los tres opcionales ya vienen resueltos por el servidor (nunca `null`):
 * un producto sin precio de domicilio o de plataforma trae ahí el mismo
 * valor que `dine_in`, así que este helper no necesita — ni podría —
 * decidir la caída al precio de mesa.
 */
export function channelPriceKey(
  channel: string | null | undefined,
): "dine_in" | "takeout" | "delivery" | "platform" {
  if (channel === "takeout") return "takeout"
  if (channel === "delivery") return "delivery"
  if (channel === "platform") return "platform"
  return "dine_in"
}

