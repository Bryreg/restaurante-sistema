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
}
