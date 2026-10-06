/**
 * Punto de entrada del dominio "analítica" (fase 3, T5 `frontend-fase3`,
 * mismo patrón que `src/features/inventory/index.ts`): `src/app/router.tsx`
 * importa `analyticsFeature` para montar su ruta y `AdminLayout.tsx` para
 * armar su navegación.
 *
 * Dos entradas de navegación, cada una detrás de su propia función
 * (`NavItem.feature` sólo admite una clave — mismo criterio que
 * `features/payroll/index.ts` con `payroll`/`pos.tips`): "Ingeniería de
 * menú" exige `analytics.menu_engineering`; "Reposición" exige
 * `inventory.replenishment`. Con las dos encendidas llevan a la misma
 * pantalla. «Varianza y salud» se mudó a Inventario (limpieza 2026-10): la
 * entrada del rail la declara `features/inventory/index.ts`.
 *
 * Sólo Admin: `posRoutes`/`posNav` quedan vacíos.
 */

import { createElement } from "react"
import type { RouteObject } from "react-router-dom"

import type { NavItem } from "@/app/nav"

import { AnalyticsAdminPage } from "./AnalyticsAdminPage"

const adminRoutes: RouteObject[] = [{ path: "analitica", element: createElement(AnalyticsAdminPage) }]

const adminNav: NavItem[] = [
  { to: "/admin/analitica", label: "Ingeniería de menú", feature: "analytics.menu_engineering" },
  { to: "/admin/analitica?tab=reposicion", label: "Reposición", feature: "inventory.replenishment" },
]

export const analyticsFeature = {
  adminRoutes,
  posRoutes: [] as RouteObject[],
  adminNav,
  posNav: [] as NavItem[],
}
