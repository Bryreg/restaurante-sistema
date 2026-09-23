/**
 * Utilidades puras y compartidas de "Analítica": etiquetas y fechas de
 * filtro por defecto — nunca plata ni clasificación derivada (AGENTS.md §
 * "una sola matemática, en el backend"). `todayLocal`/`daysAgoLocal`
 * reexportan `todayInBogota`/`daysAgoInBogota` de `features/reports/lib.ts`
 * (mismo patrón que `features/inventory/lib.ts`).
 */
import type { MenuEngineeringClass } from "@/api/analytics"
import { daysAgoInBogota, todayInBogota } from "@/features/reports/lib"

export const todayLocal = todayInBogota
export const daysAgoLocal = daysAgoInBogota

/** Matriz clásica de ingeniería de menú (popularidad × margen). El backend
 * decide la clasificación; esto sólo la nombra en español. */
export const MENU_ENGINEERING_LABEL: Record<MenuEngineeringClass, string> = {
  star: "Estrella",
  plowhorse: "Caballo de batalla",
  puzzle: "Enigma",
  dog: "Perro",
  unclassified: "Sin clasificar",
}

export function menuEngineeringLabel(classification: string | null | undefined): string {
  if (!classification) return "Sin clasificar"
  return MENU_ENGINEERING_LABEL[classification as MenuEngineeringClass] ?? classification
}

/**
 * El tono de cada clase. «Perro» va en ÁMBAR, no en rojo: el rojo es sólo
 * para lo que falta (informe del científico #7). Ámbar dice «mirá esto»,
 * que es lo que pide un plato que ni se vende ni deja; el resto va neutro
 * y la columna «Qué hacer» dice la acción con palabras.
 */
export const MENU_ENGINEERING_TONE: Record<MenuEngineeringClass, "default" | "warning" | "critical"> = {
  star: "default",
  plowhorse: "default",
  puzzle: "default",
  dog: "warning",
  unclassified: "default",
}

/**
 * Orden de la tabla por acción: primero lo que hay que sacar, después el
 * precio, la promoción y lo que se mantiene; al final lo que no se pudo
 * clasificar (muestra chica, sin costo). Ordenar no es calcular.
 */
const ORDEN_ACCION: Record<string, number> = { dog: 0, plowhorse: 1, puzzle: 2, star: 3, unclassified: 5 }

export function ordenPorAccion(classification: string | null | undefined): number {
  if (!classification) return 4
  return ORDEN_ACCION[classification] ?? 6
}

export function menuEngineeringTone(classification: string | null | undefined): "default" | "warning" | "critical" {
  if (!classification) return "default"
  return MENU_ENGINEERING_TONE[classification as MenuEngineeringClass] ?? "default"
}
