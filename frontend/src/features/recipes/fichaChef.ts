import type { Station } from "@/api/recipes"

/** Los alérgenos en palabras (la lista cerrada de `app.inventory.allergens`). */
export const ALLERGEN_LABEL: Record<string, string> = {
  gluten: "Gluten",
  crustaceos: "Crustáceos",
  huevo: "Huevo",
  pescado: "Pescado",
  mani: "Maní",
  soya: "Soya",
  lacteos: "Lácteos",
  frutos_secos: "Frutos secos",
  apio: "Apio",
  mostaza: "Mostaza",
  sesamo: "Sésamo",
  sulfitos: "Sulfitos",
  altramuces: "Altramuces",
  moluscos: "Moluscos",
}

export const ALLERGEN_CODES = Object.keys(ALLERGEN_LABEL)

export const STATION_LABEL: Record<Station, string> = {
  caliente: "Cocina caliente",
  fria: "Cocina fría",
  parrilla: "Parrilla",
  pasteleria: "Pastelería",
  bar: "Bar",
  otra: "Otra",
}

/** La dirección de la ficha imprimible: abre en otra pestaña. */
export function fichaImprimibleHref(kind: "product" | "preparation", id: number, costos: boolean): string {
  const q = new URLSearchParams({ [kind === "product" ? "producto" : "preparacion"]: String(id) })
  if (costos) q.set("costos", "1")
  return `/imprimir/ficha?${q.toString()}`
}
