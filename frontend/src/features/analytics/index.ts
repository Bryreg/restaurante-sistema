/**
 * Punto de entrada del dominio "analítica" (fase 3, T5 `frontend-fase3`,
 * mismo patrón que `src/features/inventory/index.ts`): `src/app/router.tsx`
 * importa `analyticsFeature` para montar su ruta y `AdminLayout.tsx` para
 * armar su navegación.
 *
 * Tres entradas de navegación, cada una detrás de su propia función
 * (`NavItem.feature` sólo admite una clave — mismo criterio que
 * `features/payroll/index.ts` con `payroll`/`pos.tips`): "Ingeniería de
 * menú" exige `analytics.menu_engineering`; "Varianza y salud" exige
 * `inventory.variance` (verificado por lectura directa de
 * `app/analytics/router.py` — NO comparte flag con ingeniería de menú, a
 * pesar de que spec.md § 2 da a entender que sí; ver
 * `AnalyticsAdminPage.tsx` y los gaps del entregable); "Reposición" exige
 * `inventory.replenishment`. Con más de una encendida llevan a la misma
 * pantalla.
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
  { to: "/admin/analitica?tab=varianza", label: "Varianza y salud", feature: "inventory.variance" },
  { to: "/admin/analitica?tab=reposicion", label: "Reposición", feature: "inventory.replenishment" },
]

export const analyticsFeature = {
  adminRoutes,
  posRoutes: [] as RouteObject[],
  adminNav,
  posNav: [] as NavItem[],
}
