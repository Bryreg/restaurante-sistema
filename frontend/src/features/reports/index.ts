/**
 * Punto de entrada del dominio "reportes del administrador" (mismo patrón
 * que `src/features/orders/index.ts`, `fiscal/index.ts`, `customers/
 * index.ts`): `src/app/router.tsx` y `AdminLayout.tsx` sólo conocen estas
 * pantallas a través de `reportsFeature`.
 *
 * "Hoy" y "Ventas" son núcleo del admin (SPEC-NEGOCIO §9.3): sin `feature`
 * que las apague, igual que Dinero/Turnos y personal/Documentos fiscales.
 * "Informes" (todo el período en un solo scroll, `GET /admin/reports/
 * overview`) también: junta lo que ya estaba en Ventas, Pedidos y Analítica.
 */
import { createElement } from "react"
import type { RouteObject } from "react-router-dom"

import type { NavItem } from "@/app/nav"

import { InformesPage } from "./InformesPage"
import { SalesPage } from "./SalesPage"
import { TodayPage } from "./TodayPage"

const adminRoutes: RouteObject[] = [
  { path: "hoy", element: createElement(TodayPage) },
  { path: "ventas", element: createElement(SalesPage) },
  { path: "informes", element: createElement(InformesPage) },
]

const adminNav: NavItem[] = [
  { to: "/admin/hoy", label: "Hoy" },
  { to: "/admin/ventas", label: "Ventas" },
  { to: "/admin/informes", label: "Informes" },
]

export const reportsFeature = { adminRoutes, adminNav }
