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
import { PlataAdminPage } from "./PlataAdminPage"

const adminRoutes: RouteObject[] = [
  { path: "banco", element: createElement(BankingAdminPage) },
  { path: "plata", element: createElement(PlataAdminPage) },
]

/**
 * c10 (decisión del dueño 2026-10-06): **Caja** es la plata física —cuadres,
 * consignaciones, devoluciones— y **Plata** es lo que pasa después —el libro
 * del banco, la mano del dueño, las conciliaciones—. `/admin/banco` queda
 * con Consignaciones y Por consignar; el libro, la mano y las dos
 * conciliaciones viven en `/admin/plata` con los MISMOS `?tab=`, y
 * `/admin/banco?tab=libro|mano|datafono|plataformas` redirige allá.
 */
const adminNav: NavItem[] = [
  { to: "/admin/banco", label: "Consignaciones", feature: "money.deposits" },
  { to: "/admin/plata", label: "Libro del banco", feature: "money.bank" },
  { to: "/admin/plata?tab=mano", label: "Mano del dueño", feature: "money.bank" },
  { to: "/admin/plata?tab=datafono", label: "Conciliaciones", feature: "money.bank" },
]

export const bankingFeature = {
  adminRoutes,
  posRoutes: [] as RouteObject[],
  adminNav,
  posNav: [] as NavItem[],
}
