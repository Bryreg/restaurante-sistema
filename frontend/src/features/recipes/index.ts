/**
 * Punto de entrada del dominio "recetas y preparaciones" (pedido 2a, mismo
 * patrón que `src/features/orders/index.ts`): `src/app/router.tsx` importa
 * `recipesFeature` para montar sus rutas y `PosLayout.tsx`/`AdminLayout.tsx`
 * para armar su navegación — es la única forma en que el resto del frontend
 * conoce estas pantallas. La ficha técnica del plato y sus vecinas (cobertura,
 * unidades sospechosas, `recipe_effect`) viven dentro de `src/features/catalog/`
 * (extienden la pantalla de Carta que ya existe) y se registran por
 * `catalogFeature`, no por acá.
 */

import { CookingPot } from "lucide-react"
import { createElement } from "react"
import type { RouteObject } from "react-router-dom"

import type { NavItem } from "@/app/nav"

import { PreparationsAdminPage } from "./PreparationsAdminPage"
import { QuickProductionPage } from "./QuickProductionPage"

const posRoutes: RouteObject[] = [{ path: "produccion", element: createElement(QuickProductionPage) }]

const adminRoutes: RouteObject[] = [{ path: "preparaciones", element: createElement(PreparationsAdminPage) }]

const posNav: NavItem[] = [
  { to: "/pos/produccion", label: "Producción", icon: CookingPot, feature: "catalog.preps", posGroup: "cocina" },
]

const adminNav: NavItem[] = [{ to: "/admin/preparaciones", label: "Preparaciones", feature: "catalog.preps" }]

export const recipesFeature = { posRoutes, adminRoutes, posNav, adminNav }
