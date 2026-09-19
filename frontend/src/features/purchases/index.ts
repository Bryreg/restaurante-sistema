/**
 * Punto de entrada del dominio "compras" (pedido 2b, mismo patrón que
 * `src/features/inventory/index.ts`): `src/app/router.tsx` importa
 * `purchasesFeature` para montar su ruta y `AdminLayout.tsx` para armar su
 * navegación — es la única forma en que el resto del frontend conoce esta
 * pantalla.
 *
 * Sólo Admin: la recepción lleva precios unitarios y el PIN de quien
 * recibe es atribución, no una sesión de dispositivo (invariante heredado
 * #2, `features/fase-2-costo-inventario/spec.md`) — por eso `posRoutes`
 * y `posNav` quedan vacíos a propósito, nunca una ruta de Compras bajo
 * `/pos`.
 */

import { createElement } from "react"
import type { RouteObject } from "react-router-dom"

import type { NavItem } from "@/app/nav"

import { PurchasesAdminPage } from "./PurchasesAdminPage"

const adminRoutes: RouteObject[] = [{ path: "compras", element: createElement(PurchasesAdminPage) }]

const adminNav: NavItem[] = [{ to: "/admin/compras", label: "Compras", feature: "purchases" }]

export const purchasesFeature = {
  adminRoutes,
  posRoutes: [] as RouteObject[],
  adminNav,
  posNav: [] as NavItem[],
}
