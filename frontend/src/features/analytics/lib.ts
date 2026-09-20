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

export const MENU_ENGINEERING_TONE: Record<MenuEngineeringClass, "default" | "warning" | "critical"> = {
  star: "default",
  plowhorse: "default",
  puzzle: "warning",
  dog: "critical",
  unclassified: "default",
}

export function menuEngineeringTone(classification: string | null | undefined): "default" | "warning" | "critical" {
  if (!classification) return "default"
  return MENU_ENGINEERING_TONE[classification as MenuEngineeringClass] ?? "default"
}
