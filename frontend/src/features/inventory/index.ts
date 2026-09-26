/**
 * Punto de entrada del dominio "inventario" (pedidos 2a y 2b, mismo patrón
 * que `src/features/orders/index.ts` y `src/features/recipes/index.ts`):
 * `src/app/router.tsx` importa `inventoryFeature` para montar sus rutas y
 * `AdminLayout.tsx`/`PosLayout.tsx` para armar su navegación — es la única
 * forma en que el resto del frontend conoce estas pantallas.
 *
 * Las dos entradas de navegación llevan su propia `feature`
 * (AGENTS.md § "las pantallas se arman a partir de los flags de la
 * sesión"): "Inventario" exige `inventory.perpetual` (sin ella, ninguna
 * pestaña se ofrece — aunque `Ingredient` en sí sea dato maestro sin flag
 * propia, la SECCIÓN completa vive detrás de esta función; las pestañas de
 * 2b llevan además su propio gate interno, ver `InventoryAdminPage.tsx`);
 * "Merma" del POS exige `inventory.waste`.
 *
 * **Ruta nueva de 2b, declarada acá** (mandato del reparto: "declará tus
 * rutas nuevas dentro de `features/inventory/index.ts`, que es tuyo, y
 * quedan montadas solas" — nunca tocando `src/app/router.tsx`, prohibido
 * para este agente): `inventario/conteos/:countId` monta
 * `CountCapturePage.tsx`, la captura a ciegas de un conteo. Vive bajo
 * `/admin/inventario/...` (no una pestaña más de `InventoryAdminPage`)
 * porque necesita su URL propia — "Aplicar conteo" es una acción con
 * consecuencias que hay que poder enlazar y recargar sin perder el conteo
 * en curso.
 */

import { ClipboardList, Trash2 } from "lucide-react"
import { createElement } from "react"
import type { RouteObject } from "react-router-dom"

import type { NavItem } from "@/app/nav"

import { AreaCountPage } from "./AreaCountPage"
import { CountCapturePage } from "./CountCapturePage"
import { InventoryAdminPage } from "./InventoryAdminPage"
import { OpeningCountGate } from "./OpeningCountGate"
import { WastePage } from "./WastePage"

const adminRoutes: RouteObject[] = [
  { path: "inventario", element: createElement(InventoryAdminPage) },
  { path: "inventario/conteos/:countId", element: createElement(CountCapturePage) },
]

// `conteo` (0030): la pantalla de conteo por área como ruta propia del POS,
// sin caja abierta de por medio (antes vivía sólo dentro de Turno).
const posRoutes: RouteObject[] = [
  { path: "merma", element: createElement(WastePage) },
  { path: "conteo", element: createElement(AreaCountPage) },
]

const adminNav: NavItem[] = [{ to: "/admin/inventario", label: "Inventario", feature: "inventory.perpetual" }]

const posNav: NavItem[] = [
  { to: "/pos/merma", label: "Merma", icon: Trash2, feature: "inventory.waste", posGroup: "cocina" },
  { to: "/pos/conteo", label: "Conteo", icon: ClipboardList, feature: "inventory.shift_counts", posGroup: "cocina" },
]

/**
 * `withOpeningGate`: la apertura del área es obligatoria (decisión 5).
 * `router.tsx` envuelve con esto las pantallas del POS, sin cambiar sus
 * rutas (los `path` quedan iguales); el KDS y la vista de cocina no se
 * frenan, sólo avisan en rojo (`OpeningCountGate.tsx`).
 */
function withOpeningGate(routes: RouteObject[]): RouteObject[] {
  return routes.map((route) =>
    route.element === undefined || route.element === null
      ? route
      : { ...route, element: createElement(OpeningCountGate, null, route.element) },
  )
}

export const inventoryFeature = { adminRoutes, posRoutes, adminNav, posNav, withOpeningGate }
