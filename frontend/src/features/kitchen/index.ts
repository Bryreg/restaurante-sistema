/**
 * Punto de entrada del dominio cocina: este manifiesto es la única forma en la
 * que `router.tsx` y `PosLayout.tsx` conocen la pantalla de cocina — mismo
 * patrón que `features/orders/index.ts`/`features/shifts/index.ts` (no hay
 * `adminRoutes`/`adminNav`: la cocina es puramente de dispositivo, §9.2).
 *
 * Hay UNA pantalla de cocina (`KdsPage`), gateada por `kitchen.view`; con
 * `kitchen.kds` suma deshacer listo, expedir e impresión por estación. La
 * vieja vista mínima (`/pos/cocina`) se borró: su ruta redirige acá para que
 * un enlace guardado no termine en una página en blanco.
 */
import { ChefHat } from "lucide-react"
import { createElement } from "react"
import { Navigate, type RouteObject } from "react-router-dom"

import type { NavItem } from "@/app/nav"

import { KdsPage } from "./KdsPage"

const posRoutes: RouteObject[] = [
  { path: "kds", element: createElement(KdsPage) },
  { path: "cocina", element: createElement(Navigate, { to: "/pos/kds", replace: true }) },
]

const posNav: NavItem[] = [
  { to: "/pos/kds", label: "Cocina", icon: ChefHat, feature: "kitchen.view", posGroup: "cocina" },
]

export const kitchenFeature = { posRoutes, posNav }
