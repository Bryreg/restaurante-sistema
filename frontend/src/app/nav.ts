import type { LucideIcon } from "lucide-react";

/**
 * Entrada de navegación de un sidebar (Admin) o de la barra del POS. `feature`
 * es la clave del catálogo de funciones: si está presente y `hasFeature(key)`
 * es `false`, la entrada no se muestra (AGENTS.md § "toda función opcional").
 */
export interface NavItem {
  to: string;
  label: string;
  feature?: string;
  icon?: LucideIcon;
  /**
   * Sólo barra del salón: en qué tramo va. La barra se ordena por tramo
   * (venta → caja → cocina) y, dentro de cada uno, en el orden de los
   * manifiestos. Sin tramo cuenta como `venta`.
   */
  posGroup?: "venta" | "caja" | "cocina";
}
