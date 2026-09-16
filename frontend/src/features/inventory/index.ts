/**
 * Punto de entrada del dominio "inventario" (pedido 2a, mismo patrón que
 * `src/features/orders/index.ts` y `src/features/recipes/index.ts`):
 * `src/app/router.tsx` importa `inventoryFeature` para montar sus rutas y
 * `AdminLayout.tsx`/`PosLayout.tsx` para armar su navegación — es la única
 * forma en que el resto del frontend conoce estas pantallas.
 *
 * Las dos entradas de navegación llevan su propia `feature`
 * (AGENTS.md § "las pantallas se arman a partir de los flags de la
 * sesión"): "Inventario" exige `inventory.perpetual` (sin ella, Insumos,
 * Stock y Movimientos no se ofrecen — aunque `Ingredient` en sí sea dato
 * maestro sin flag propia, la SECCIÓN completa vive detrás de esta función);
 * "Merma" del POS exige `inventory.waste`.
 */

import { createElement } from "react"
import type { RouteObject } from "react-router-dom"

import type { NavItem } from "@/app/nav"

import { InventoryAdminPage } from "./InventoryAdminPage"
import { WastePage } from "./WastePage"

const adminRoutes: RouteObject[] = [{ path: "inventario", element: createElement(InventoryAdminPage) }]

const posRoutes: RouteObject[] = [{ path: "merma", element: createElement(WastePage) }]

const adminNav: NavItem[] = [{ to: "/admin/inventario", label: "Inventario", feature: "inventory.perpetual" }]

const posNav: NavItem[] = [{ to: "/pos/merma", label: "Merma", feature: "inventory.waste" }]

export const inventoryFeature = { adminRoutes, posRoutes, adminNav, posNav }
