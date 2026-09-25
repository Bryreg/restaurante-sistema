/**
 * Rótulo en español de una estación de cocina. Las de fábrica
 * (`DEFAULT_STATIONS` en `backend/app/stores/service.py`) son códigos, y
 * salían crudos en pantalla («hot_kitchen»). Una estación que el dueño creó
 * con su propio nombre (Admin → Configuración → Ventas) se muestra tal cual
 * la escribió.
 */
export const STATION_LABEL: Record<string, string> = {
  hot_kitchen: "Cocina caliente",
  cold_kitchen: "Cocina fría",
  bar: "Bar",
  desserts: "Postres",
  none: "Sin estación",
}

export function stationLabel(code: string | null | undefined): string {
  if (!code) return "Sin estación"
  return STATION_LABEL[code] ?? code
}
