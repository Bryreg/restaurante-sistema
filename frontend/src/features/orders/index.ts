/**
 * Punto de entrada del dominio "comanda" (CONTRATO-INTERNO-1b-1.md §6.2):
 * sobreescribe el stub vacío de `frontend-cobro` en este mismo archivo (o lo
 * crea, si `frontend-cobro` no llegó a escribirlo todavía — §7.1). Es la
 * única forma en la que `src/app/router.tsx`, `PosLayout.tsx` y
 * `AdminLayout.tsx` conocen Mesas, Comanda, Cocina y Admin → Pedidos.
 */

import { createElement } from "react"
import type { RouteObject } from "react-router-dom"

import type { NavItem } from "@/app/nav"

import { KitchenPage } from "./KitchenPage"
import { NewOrderPage } from "./NewOrderPage"
import { OrderPage } from "./OrderPage"
import { OrdersAdminPage } from "./OrdersAdminPage"
import { TablesPage } from "./TablesPage"

const posRoutes: RouteObject[] = [
  { path: "mesas", element: createElement(TablesPage) },
  { path: "comanda/nueva", element: createElement(NewOrderPage) },
  { path: "comanda/:orderId", element: createElement(OrderPage) },
  { path: "cocina", element: createElement(KitchenPage) },
]

const adminRoutes: RouteObject[] = [{ path: "pedidos", element: createElement(OrdersAdminPage) }]

const adminNav: NavItem[] = [{ to: "/admin/pedidos", label: "Pedidos" }]

const posNav: NavItem[] = [
  { to: "/pos/mesas", label: "Mesas", feature: "pos.tables" },
  { to: "/pos/comanda/nueva", label: "Comanda" },
  { to: "/pos/cocina", label: "Cocina", feature: "kitchen.view" },
]

export const ordersFeature = { posRoutes, adminRoutes, adminNav, posNav }
