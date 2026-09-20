/**
 * Utilidades puras del KDS: sólo tiempo y texto, nunca plata (AGENTS.md,
 * "una sola matemática, en el backend"). El semáforo, el orden de los
 * ítems y `elapsed_seconds` los calcula el servidor (`app/kitchen/router.py
 * ::_semaphore`, `enrich_round_for_kds`) — este archivo sólo los FORMATEA
 * o los pinta tal cual llegan; nunca los recalcula.
 *
 * `territorio propio` a propósito: este dominio es nuevo
 * (`features/kitchen/**`) y no importa de `features/orders/**` (territorio
 * ajeno, en construcción en paralelo). Los cuatro mapas de abajo declaran
 * de dónde sale el conjunto que enumeran, como pide el CRUCE de la misión.
 */

/** `backend/app/orders/models.py::OrderChannel` — el conjunto completo de canales que puede traer `KitchenRoundOut.channel` (una ronda de cualquier canal puede llegar a cocina). */
export const CHANNEL_LABEL: Record<string, string> = {
  counter: "Mostrador",
  dine_in: "Mesa",
  takeout: "Para llevar",
  delivery: "Domicilio",
  platform: "Plataforma",
  staff_meal: "Consumo de personal",
}

export function channelLabel(channel: string | null | undefined): string {
  if (!channel) return "—"
  return CHANNEL_LABEL[channel] ?? channel
}

/**
 * Defaults de SPEC-NEGOCIO §3.3 (`beverage`/`starter`/`main`/`dessert`).
 * `StoreSalesSettings.courses` (Admin → Configuración → Ventas) es en
 * realidad una lista LIBRE por sede: un curso que no está acá se pinta tal
 * cual el texto que mandó el servidor, nunca como "—" ni como un curso
 * inventado.
 */
export const COURSE_LABEL: Record<string, string> = {
  beverage: "Bebida",
  starter: "Entrada",
  main: "Fuerte",
  dessert: "Postre",
}

export function courseLabel(course: string | null | undefined): string {
  if (!course) return "—"
  return COURSE_LABEL[course] ?? course
}

export function elapsedFromSeconds(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return `${hours} h ${rest} min`
}

export type KitchenSemaphoreValue = "green" | "amber" | "red"

export const SEMAPHORE_LABEL: Record<KitchenSemaphoreValue, string> = {
  green: "A tiempo",
  amber: "Por vencer",
  red: "Demorado",
}

// Única excepción tokenizada permitida por CONTRATO-INTERNO §6.1 (mismo
// criterio que `features/orders/KitchenPage.tsx`): el semáforo de cocina
// usa clases crudas de Tailwind con texto que mantiene contraste AA, nunca
// un token de color de marca — es información de urgencia universal
// (rojo/ámbar/verde), no una decisión de diseño de marca.
export const SEMAPHORE_CLASS: Record<KitchenSemaphoreValue, string> = {
  green: "bg-emerald-600 text-white",
  amber: "bg-amber-600 text-white",
  red: "bg-red-600 text-white",
}
