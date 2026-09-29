import type { FoodLabel, LabelWasteType, UseBySource } from "@/api/labels"
import { formatFechaCorta } from "@/lib/format"

/** Cómo se dice lo que le queda, con el estado que calculó el servidor. */
export function stateText(label: Pick<FoodLabel, "state" | "days_left" | "use_by">): string {
  switch (label.state) {
    case "expired": {
      const days = Math.abs(label.days_left ?? 0)
      return days === 1 ? "Venció ayer" : `Venció hace ${days} días`
    }
    case "today":
      return "Vence hoy"
    case "tomorrow":
      return "Vence mañana"
    case "ok":
      return `Quedan ${label.days_left} días · ${formatFechaCorta(label.use_by)}`
    default:
      return "Sin vencimiento"
  }
}

export function stateTone(state: FoodLabel["state"]): "critical" | "warning" | "neutral" {
  if (state === "expired") return "critical"
  if (state === "today" || state === "tomorrow") return "warning"
  return "neutral"
}

export const SOURCE_TEXT: Record<UseBySource, string> = {
  supplier: "vencimiento del proveedor",
  opened_shelf_life: "días que dura abierto",
  prep_shelf_life: "vida útil de la preparación",
  manual: "fecha elegida al imprimir",
}

export const LABEL_WASTE_TYPES: { value: LabelWasteType; label: string }[] = [
  { value: "expired", label: "Vencido" },
  { value: "overproduction", label: "Sobreproducción" },
  { value: "kitchen_error", label: "Error de cocina" },
  { value: "breakage", label: "Rotura" },
  { value: "unidentified", label: "Sin identificar" },
]

/** «Limón» se encuentra escribiendo «limon». */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
}
