/**
 * Punto de entrada del dominio "comanda" (CONTRATO-INTERNO-1b-1.md §6.2):
 * sobreescribe el stub vacío de `frontend-cobro` en este mismo archivo (o lo
 * crea, si `frontend-cobro` no llegó a escribirlo todavía — §7.1). Es la
 * única forma en la que `src/app/router.tsx`, `PosLayout.tsx` y
 * `AdminLayout.tsx` conocen Mesas, Comanda y Admin → Pedidos (la cocina
 * vive en `features/kitchen`).
 */

import { LayoutGrid, PlusCircle, ShoppingBag } from "lucide-react"
import { createElement } from "react"
import type { RouteObject } from "react-router-dom"

import type { NavItem } from "@/app/nav"

import { CounterSalePage } from "./CounterSalePage"
import { NewOrderPage } from "./NewOrderPage"
import { OrderPage } from "./OrderPage"
import { OrdersAdminPage } from "./OrdersAdminPage"
import { TablesPage } from "./TablesPage"

const posRoutes: RouteObject[] = [
  { path: "mesas", element: createElement(TablesPage) },
  { path: "mostrador", element: createElement(CounterSalePage) },
  { path: "comanda/nueva", element: createElement(NewOrderPage) },
  { path: "comanda/:orderId", element: createElement(OrderPage) },
]

const adminRoutes: RouteObject[] = [{ path: "pedidos", element: createElement(OrdersAdminPage) }]

const adminNav: NavItem[] = [{ to: "/admin/pedidos", label: "Pedidos" }]

// «Mostrador» y no «Comanda»: la barra nombra el lugar donde se atiende
// (propuesta § navegación), igual que «Mesas». Un toque abre la venta de
// mostrador directo (`CounterSalePage`); los demás canales (para llevar,
// domicilio, plataforma, consumo de personal) viven en «Nuevo pedido».
const posNav: NavItem[] = [
  { to: "/pos/mesas", label: "Mesas", icon: LayoutGrid, feature: "pos.tables" },
  { to: "/pos/mostrador", label: "Mostrador", icon: ShoppingBag, feature: "pos.counter" },
  { to: "/pos/comanda/nueva", label: "Nuevo pedido", icon: PlusCircle },
]

export const ordersFeature = { posRoutes, adminRoutes, adminNav, posNav }
