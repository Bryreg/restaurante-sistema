/**
 * Punto de entrada del dominio "nómina y propinas" (fase 3, T5
 * `frontend-fase3`, mismo patrón que `src/features/inventory/index.ts`):
 * `src/app/router.tsx` importa `payrollFeature` para montar su ruta y
 * `AdminLayout.tsx` para armar su navegación.
 *
 * D-3 pone el reparto de propinas bajo `pos.tips` (ya existía) y no bajo
 * `payroll` — así que esta única pantalla lleva DOS entradas de navegación,
 * cada una detrás de su propia función (AGENTS.md § "toda función opcional
 * se construye detrás de su flag" / CONTEXTO-AGENTES.md § 10: "la entrada de
 * navegación se esconde si su función está apagada" — `NavItem.feature` sólo
 * admite una clave, nunca un "o"). Con las dos encendidas, las dos entradas
 * llevan a la misma pantalla; `PayrollAdminPage.tsx` decide qué pestañas
 * mostrar según cuál de las dos funciones esté prendida.
 *
 * Sólo Admin: `posRoutes`/`posNav` quedan vacíos.
 */

import { createElement } from "react"
import type { RouteObject } from "react-router-dom"

import type { NavItem } from "@/app/nav"

import { PayrollAdminPage } from "./PayrollAdminPage"

const adminRoutes: RouteObject[] = [{ path: "nomina", element: createElement(PayrollAdminPage) }]

const adminNav: NavItem[] = [
  { to: "/admin/nomina", label: "Nómina", feature: "payroll" },
  { to: "/admin/nomina?tab=propinas", label: "Propinas", feature: "pos.tips" },
]

export const payrollFeature = {
  adminRoutes,
  posRoutes: [] as RouteObject[],
  adminNav,
  posNav: [] as NavItem[],
}
