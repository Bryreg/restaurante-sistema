import type { NoveltyCategory, NoveltyLevel } from "@/api/novelties"

/** `NoveltyCategoryLiteral` del backend, en español. Lista cerrada: la
 * categoría nunca es texto libre. */
export const CATEGORY_LABEL: Record<NoveltyCategory, string> = {
  incident: "Incidente",
  equipment: "Equipo",
  staff: "Personal",
  customer: "Cliente",
  security: "Seguridad",
  other: "Otro",
}

export const LEVEL_LABEL: Record<NoveltyLevel, string> = {
  info: "Informativa",
  important: "Importante",
  urgent: "Urgente",
}

export function levelVariant(level: NoveltyLevel): "destructive" | "default" | "secondary" {
  if (level === "urgent") return "destructive"
  if (level === "important") return "default"
  return "secondary"
}

export const NOVELTIES_QUERY_KEYS = {
  board: ["novelties", "board"] as const,
  adminOpen: (storeId: number) => ["novelties", "admin", "open", storeId] as const,
  adminHistory: (storeId: number, status: string, from: string, to: string) =>
    ["novelties", "admin", "history", storeId, status, from, to] as const,
}
