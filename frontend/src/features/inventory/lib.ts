/**
 * Utilidades puras y compartidas de "Inventario": SOLO etiquetas y fechas de
 * filtro por defecto — nunca plata ni cantidades derivadas (AGENTS.md § "una
 * sola matemática, en el backend"). `todayLocal`/`daysAgoLocal` reexportan
 * `todayInBogota`/`daysAgoInBogota` de `features/reports/lib.ts` (mismo
 * territorio de este agente) en vez de duplicarlas — el hallazgo O-4 de
 * 1b-2 fue justo esto: cada dominio copiando su propio filtro de fechas.
 */
import type { MovementCause, WasteType } from "@/api/inventory"
import { daysAgoInBogota, todayInBogota } from "@/features/reports/lib"

export const todayLocal = todayInBogota
export const daysAgoLocal = daysAgoInBogota

/** `app.inventory.models.MovementCause` en español. Enum cerrado — el
 * filtro de causa es SIEMPRE una lista, nunca un campo de texto libre
 * (AGENTS.md § "la causa no se infiere de un texto"). */
export const CAUSE_LABEL: Record<MovementCause, string> = {
  sale: "Venta",
  production_in: "Entrada por producción",
  production_out: "Salida por producción",
  void_after_send: "Anulación tras envío",
  waste: "Merma",
  note_return: "Nota — vuelve",
  manual_adjustment: "Ajuste manual",
  purchase: "Compra (2b)",
  count_adjustment: "Ajuste por conteo (2b)",
  transfer_in: "Traslado — entrada (2b)",
  transfer_out: "Traslado — salida (2b)",
}

/** `app.inventory.models.WasteType`. No incluye "consumo de personal": eso
 * es un canal de comanda (`staff_meal`), nunca un tipo de merma. */
export const WASTE_TYPE_LABEL: Record<WasteType, string> = {
  expired: "Vencido",
  overproduction: "Sobreproducción",
  kitchen_error: "Error de cocina",
  breakage: "Rotura",
  customer_return: "Devolución de cliente",
  tasting: "Degustación",
  courtesy_no_dish: "Cortesía sin plato",
  unidentified: "Sin identificar",
}
