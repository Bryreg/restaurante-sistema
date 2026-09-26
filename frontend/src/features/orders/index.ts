/**
 * Punto de entrada del dominio "comanda" (CONTRATO-INTERNO-1b-1.md §6.2):
 * sobreescribe el stub vacío de `frontend-cobro` en este mismo archivo (o lo
 * crea, si `frontend-cobro` no llegó a escribirlo todavía — §7.1). Es la
 * única forma en la que `src/app/router.tsx`, `PosLayout.tsx` y
 * `AdminLayout.tsx` conocen Mesas, Comanda, Cocina y Admin → Pedidos.
 */

import { ChefHat, LayoutGrid, ShoppingBag } from "lucide-react"
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

// «Mostrador» y no «Comanda»: la barra nombra el lugar donde se atiende
// (propuesta § navegación), igual que «Mesas». La vista mínima de cocina va
// en el tramo de cocina, después de lo de caja (`buildPosNav`).
const posNav: NavItem[] = [
  { to: "/pos/mesas", label: "Mesas", icon: LayoutGrid, feature: "pos.tables" },
  { to: "/pos/comanda/nueva", label: "Mostrador", icon: ShoppingBag },
  // Con el KDS encendido, la vista mínima se va de la barra (y su ruta
  // redirige al KDS, `KitchenPage`): eran dos pantallas de cocina, una con
  // los códigos de estación crudos.
  {
    to: "/pos/cocina",
    label: "Cocina",
    icon: ChefHat,
    feature: "kitchen.view",
    hiddenWithFeature: "kitchen.kds",
    posGroup: "cocina",
  },
]

export const ordersFeature = { posRoutes, adminRoutes, adminNav, posNav }
