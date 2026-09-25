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

import { guardarPreferenciasCocina, leerPreferenciasCocina } from "@/app/theme"

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

const SEMAPHORE_RANK: Record<KitchenSemaphoreValue, number> = { green: 0, amber: 1, red: 2 }

/**
 * El color de la cabecera del tiquete: el PEOR semáforo de sus ítems
 * pendientes, tal cual los mandó el servidor (no se recalcula nada: se
 * elige el más urgente de los que ya llegaron). Sin pendientes, verde.
 */
export function worstSemaphore(values: (KitchenSemaphoreValue | undefined)[]): KitchenSemaphoreValue {
  let worst: KitchenSemaphoreValue = "green"
  for (const value of values) {
    if (value && SEMAPHORE_RANK[value] > SEMAPHORE_RANK[worst]) worst = value
  }
  return worst
}

// ---------------------------------------------------------------------------
// Alergias: la nota que puede mandar a alguien al hospital no puede leerse
// igual que «sin cebolla». Sólo se DETECTA en el texto que escribió el
// mesero para pintarlo en rojo; nunca se cambia ni se oculta.
// ---------------------------------------------------------------------------

const ALLERGY_WORDS = new Set([
  "alergia",
  "alergias",
  "alergico",
  "alergica",
  "alergicos",
  "mani",
  "cacahuate",
  "nuez",
  "nueces",
  "almendra",
  "almendras",
  "gluten",
  "celiaco",
  "celiaca",
  "lactosa",
  "lacteos",
  "mariscos",
  "marisco",
  "camaron",
  "camarones",
  "crustaceos",
  "intolerante",
  "intolerancia",
  "anafilaxia",
])

function normalize(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
}

/** `true` si el texto nombra una alergia o un alérgeno común (sin importar tildes ni mayúsculas). */
export function mentionsAllergy(text: string | null | undefined): boolean {
  if (!text) return false
  return normalize(text)
    .split(/[^a-z]+/)
    .some((word) => ALLERGY_WORDS.has(word))
}

// ---------------------------------------------------------------------------
// Preferencias de la PANTALLA (no de la persona): la estación que muestra,
// si va a pantalla completa, si enseña lo «de ayer» y quién la usó por
// última vez. Son del dispositivo, como el claro/oscuro del salón, y viven
// en el mismo módulo (`app/theme.tsx`); acá sólo se validan al leer — un
// valor corrupto o ajeno cae a «sin preferencia», nunca rompe la pantalla.
// ---------------------------------------------------------------------------

export interface StationPerson {
  id: number
  name: string
}

export interface KdsScreenPrefs {
  station?: string
  fullscreen?: boolean
  showStale?: boolean
  lastPerson?: StationPerson
}

export function readKdsPrefs(): KdsScreenPrefs {
  const parsed = leerPreferenciasCocina()
  if (!parsed || typeof parsed !== "object") return {}
  const value = parsed as Record<string, unknown>
  const prefs: KdsScreenPrefs = {}
  if (typeof value.station === "string") prefs.station = value.station
  if (typeof value.fullscreen === "boolean") prefs.fullscreen = value.fullscreen
  if (typeof value.showStale === "boolean") prefs.showStale = value.showStale
  const person = value.lastPerson
  if (person && typeof person === "object") {
    const { id, name } = person as Record<string, unknown>
    if (typeof id === "number" && typeof name === "string") prefs.lastPerson = { id, name }
  }
  return prefs
}

/** Mezcla `patch` con lo guardado; una clave en `undefined` se borra. */
export function writeKdsPrefs(patch: Partial<KdsScreenPrefs>): void {
  const next: KdsScreenPrefs = { ...readKdsPrefs(), ...patch }
  for (const key of Object.keys(patch) as (keyof KdsScreenPrefs)[]) {
    if (patch[key] === undefined) delete next[key]
  }
  guardarPreferenciasCocina(next)
}

/**
 * ¿Hay alguien identificado y vigente en este dispositivo? El servidor es
 * la barrera (`current_operator` responde `IDENTIFY_REQUIRED`); esto sólo
 * evita un viaje que ya se sabe que va a rebotar.
 */
export function hasActivePerson(
  employee: { id: number } | null | undefined,
  expiresAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!employee) return false
  if (!expiresAt) return true
  return new Date(expiresAt).getTime() > now
}
