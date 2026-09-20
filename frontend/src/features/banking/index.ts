/**
 * Punto de entrada del dominio "banco" (fase 3, T5 `frontend-fase3`, mismo
 * patrón que `src/features/inventory/index.ts`): `src/app/router.tsx`
 * importa `bankingFeature` para montar su ruta y `AdminLayout.tsx` para
 * armar su navegación.
 *
 * Sólo Admin: consignar, ver el libro del banco y conciliar es tarea del
 * administrador, nunca del operador — por eso `posRoutes`/`posNav` quedan
 * vacíos a propósito.
 */

import { createElement } from "react"
import type { RouteObject } from "react-router-dom"

import type { NavItem } from "@/app/nav"

import { BankingAdminPage } from "./BankingAdminPage"

const adminRoutes: RouteObject[] = [{ path: "banco", element: createElement(BankingAdminPage) }]

const adminNav: NavItem[] = [{ to: "/admin/banco", label: "Banco", feature: "money.deposits" }]

export const bankingFeature = {
  adminRoutes,
  posRoutes: [] as RouteObject[],
  adminNav,
  posNav: [] as NavItem[],
}
