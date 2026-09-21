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

// Semáforo de cocina (mismo criterio que `features/orders/KitchenPage.tsx`):
// sigue sólido y con tinta invertida, porque el KDS se lee cruzado por la
// cocina y la urgencia tiene que gritar. Lo que cambió es de dónde sale el
// color. La excepción de CONTRATO-INTERNO §6.1 («clases crudas de Tailwind,
// nunca un token de color de marca») existía porque NO había tokens de
// estado; ahora los hay, y no son de marca: `success`/`warning`/`destructive`
// son de estado y nada más (`docs/DISENO.md`). El contraste además mejora —
// blanco sobre `emerald-600` daba 3,77:1 y sobre `amber-600` 3,19:1, por
// debajo de 4,5:1; los de m2b dan 5,02:1, 5,02:1 y 6,47:1.
export const SEMAPHORE_CLASS: Record<KitchenSemaphoreValue, string> = {
  green: "bg-success text-success-foreground",
  amber: "bg-warning text-warning-foreground",
  red: "bg-destructive text-destructive-foreground",
}
