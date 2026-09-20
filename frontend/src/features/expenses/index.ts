/**
 * Punto de entrada del dominio "obligaciones y gastos" (fase 3, T5
 * `frontend-fase3`, mismo patrón que `src/features/inventory/index.ts`):
 * `src/app/router.tsx` importa `expensesFeature` para montar su ruta y
 * `AdminLayout.tsx` para armar su navegación.
 *
 * Sólo Admin: registrar gastos, agendar obligaciones y aprobar cuentas por
 * pagar es tarea del administrador — `posRoutes`/`posNav` quedan vacíos.
 */

import { createElement } from "react"
import type { RouteObject } from "react-router-dom"

import type { NavItem } from "@/app/nav"

import { ExpensesAdminPage } from "./ExpensesAdminPage"

const adminRoutes: RouteObject[] = [{ path: "gastos", element: createElement(ExpensesAdminPage) }]

const adminNav: NavItem[] = [{ to: "/admin/gastos", label: "Gastos", feature: "money.obligations" }]

export const expensesFeature = {
  adminRoutes,
  posRoutes: [] as RouteObject[],
  adminNav,
  posNav: [] as NavItem[],
}
