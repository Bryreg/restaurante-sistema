/**
 * Utilidades puras y compartidas del dominio comanda: SOLO tiempo, texto y
 * conteo de unidades (`qty`), nunca plata (AGENTS.md, CONTRATO-INTERNO §6.1 "una sola matemática, en el
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

/**
 * El aviso de anular lo que ya salió a cocina: el servidor pide el PIN de un
 * supervisor (`AUTHORIZATION_REQUIRED`). Mismo texto en el diálogo del
 * motivo y en el del PIN.
 */
export const VOID_NEEDS_PIN_TEXT = "Anular lo ya enviado necesita PIN de supervisor"

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


/** Rótulo de curso en plural, para encabezar un grupo de líneas del pedido. */
export const COURSE_GROUP_LABEL: Record<string, string> = {
  beverage: "Bebidas",
  starter: "Entradas",
  main: "Fuertes",
  dessert: "Postres",
}

/** Orden en que sale una comida: el pedido se lee de arriba abajo igual. */
const COURSE_ORDER = ["beverage", "starter", "main", "dessert"]

export function courseGroupLabel(course: string | null | undefined): string {
  if (!course) return "Sin curso"
  return COURSE_GROUP_LABEL[course] ?? course
}

/**
 * Agrupa líneas por curso (orden de salida; un curso desconocido va al final
 * en orden de aparición). Sólo reordena: no toca cantidades ni montos.
 */
export function groupByCourse<T extends { course?: string | null }>(items: T[]): { course: string; items: T[] }[] {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = item.course ?? ""
    const bucket = groups.get(key)
    if (bucket) bucket.push(item)
    else groups.set(key, [item])
  }
  const rank = (course: string) => {
    const i = COURSE_ORDER.indexOf(course)
    return i === -1 ? COURSE_ORDER.length : i
  }
  return [...groups.entries()]
    .map(([course, list]) => ({ course, items: list }))
    .sort((a, b) => rank(a.course) - rank(b.course))
}

/**
 * Unidades de la ronda sin enviar (`pending`), por producto y por combo: el
 * número de la insignia sobre cada plato de la carta. Cuenta cantidades —
 * nunca plata—, que es lo único que el cliente puede sumar (AGENTS.md).
 */
export function unsentQtyByProduct(items: { product_id?: number | null; combo_id?: number | null; qty?: number; status?: string }[]): {
  products: Map<number, number>
  combos: Map<number, number>
} {
  const products = new Map<number, number>()
  const combos = new Map<number, number>()
  for (const item of items) {
    if (item.status !== "pending") continue
    const qty = item.qty ?? 1
    if (item.combo_id !== null && item.combo_id !== undefined) {
      combos.set(item.combo_id, (combos.get(item.combo_id) ?? 0) + qty)
    } else if (item.product_id !== null && item.product_id !== undefined) {
      products.set(item.product_id, (products.get(item.product_id) ?? 0) + qty)
    }
  }
  return { products, combos }
}

/**
 * ¿La línea es un plato (algo que cocina o el bar prepara y se «marcha»)?
 * El cargo de domicilio no: es plata, viaja sin estación y el servidor lo
 * marca `is_delivery_fee`.
 */
export function isDishLine(item: { is_delivery_fee?: boolean }): boolean {
  return item.is_delivery_fee !== true
}

/**
 * Cuántas unidades salen con «Enviar a cocina»: la suma de `qty` pendiente,
 * sin el cargo de domicilio (sale con la ronda pero no es un plato: contarlo
 * dejaba «Enviar a cocina · 1» en un domicilio vacío).
 */
export function unsentItemCount(items: { qty?: number; status?: string; is_delivery_fee?: boolean }[]): number {
  let units = 0
  for (const item of items) if (item.status === "pending" && isDishLine(item)) units += item.qty ?? 1
  return units
}

/**
 * Notas rápidas de un plato: un toque en vez del teclado. Hoy no hay dónde
 * configurarlas por sede (no hay columna para eso y no se abre una
 * migración por una lista de textos), así que viven acá: una lista por
 * curso del plato y la de siempre para el resto. El teclado queda para
 * «Otra nota».
 */
export const DEFAULT_QUICK_NOTES: readonly string[] = ["Sin cebolla", "Sin sal", "Aparte", "Para llevar"]

const QUICK_NOTES_BY_COURSE: Record<string, readonly string[]> = {
  beverage: ["Sin hielo", "Sin azúcar", "Al clima", "Para llevar"],
  dessert: ["Sin azúcar", "Aparte", "Para compartir", "Para llevar"],
}

export function quickNotesFor(course: string | null | undefined): readonly string[] {
  return (course ? QUICK_NOTES_BY_COURSE[course] : undefined) ?? DEFAULT_QUICK_NOTES
}

/** Iniciales de una persona para la tarjeta de mesa: «Ana María» → «AM». */
export function initials(name: string | null | undefined): string {
  if (!name) return ""
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return parts
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("")
}

/**
 * El número de la ronda que se está armando: una más que la última enviada.
 * Sale de `order.rounds` (el resumen del backend) y, si falta, del
 * `round_no` más alto de los ítems — sólo una etiqueta, nunca un dato.
 */
export function nextRoundNo(
  rounds: { round_no?: number }[] | null | undefined,
  items: { round_no?: number | null }[],
): number {
  let last = 0
  for (const round of rounds ?? []) last = Math.max(last, round.round_no ?? 0)
  for (const item of items) last = Math.max(last, item.round_no ?? 0)
  return last + 1
}

/**
 * ¿El plato exige preguntar algo antes de entrar al pedido? Sólo si tiene
 * un grupo de modificadores obligatorio (`required` o `min > 0`) y la
 * función está encendida; si no, un toque lo suma directo (Momento 1 de
 * `docs/diseno/propuesta.html`). El backend valida igual (`_resolve_modifiers`).
 */
export function productNeedsOptions(
  product: { modifier_groups?: { required: boolean; min: number }[] },
  modifiersEnabled: boolean,
): boolean {
  if (!modifiersEnabled) return false
  return (product.modifier_groups ?? []).some((group) => group.required || group.min > 0)
}

/**
 * La línea pendiente a la que un toque rápido le puede sumar una unidad sin
 * cambiar lo que cocina recibe: mismo producto, sin modificadores, sin nota,
 * sin asiento, en el curso por defecto, sin descuento ni cortesía. Si no hay
 * una así, el toque agrega una línea nueva.
 */
export function findMergeableLine<
  T extends {
    product_id?: number | null
    status?: string
    modifiers?: unknown[] | null
    note?: string | null
    seat?: number | null
    course?: string | null
    discount?: number | null
    courtesy?: unknown
  },
>(items: T[], product: { id: number; default_course?: string | null }): T | undefined {
  const defaultCourse = product.default_course || "main"
  return items.find(
    (item) =>
      item.status === "pending" &&
      item.product_id === product.id &&
      (item.modifiers ?? []).length === 0 &&
      !item.note &&
      (item.seat === null || item.seat === undefined) &&
      (item.course ?? defaultCourse) === defaultCourse &&
      !item.discount &&
      !item.courtesy,
  )
}
