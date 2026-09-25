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
  /**
   * Si esta función está encendida, la entrada NO se muestra: otra pantalla
   * la reemplaza (p. ej. la vista mínima de Cocina cuando el KDS está
   * encendido — dos «Cocina» en la barra eran dos pantallas para lo mismo).
   */
  hiddenWithFeature?: string;
  icon?: LucideIcon;
  /**
   * Sólo barra del salón: en qué tramo va. La barra se ordena por tramo
   * (venta → caja → cocina) y, dentro de cada uno, en el orden de los
   * manifiestos. Sin tramo cuenta como `venta`.
   */
  posGroup?: "venta" | "caja" | "cocina";
}
