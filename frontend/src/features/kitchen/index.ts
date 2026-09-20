/**
 * Punto de entrada del dominio KDS (`kitchen.kds`, pedido 2c, CONTRATO C8 de
 * la spec de este pedido): sólo `frontend-kds-config` toca `src/app/**` en
 * este pedido, y este manifiesto es la única forma en la que `router.tsx` y
 * `PosLayout.tsx` conocen la pantalla de KDS — mismo patrón que
 * `features/orders/index.ts`/`features/shifts/index.ts` (no hay
 * `adminRoutes`/`adminNav`: el KDS es puramente de dispositivo, §9.2).
 */
import { createElement } from "react"
import type { RouteObject } from "react-router-dom"

import type { NavItem } from "@/app/nav"

import { KdsPage } from "./KdsPage"

const posRoutes: RouteObject[] = [{ path: "kds", element: createElement(KdsPage) }]

const posNav: NavItem[] = [{ to: "/pos/kds", label: "KDS", feature: "kitchen.kds" }]

export const kitchenFeature = { posRoutes, posNav }
