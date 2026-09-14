/**
 * Punto de entrada del dominio "carta" para el shell del admin
 * (`CONTRATO-INTERNO.md §5`). Sobreescribe el stub vacío que deja
 * `frontend-core` en este mismo archivo — es la única forma en la que
 * `src/app/router.tsx` y `AdminLayout` conocen esta pantalla.
 */

import { createElement } from "react"
import type { RouteObject } from "react-router-dom"

import type { NavItem } from "@/app/nav"

import { CatalogAdminPage } from "./CatalogAdminPage"

// `index.ts` (no `.tsx`, CONTRATO-INTERNO.md §5): sin JSX, por eso
// `createElement` en vez de `<CatalogAdminPage />`.
const adminRoutes: RouteObject[] = [{ path: "carta", element: createElement(CatalogAdminPage) }]

const adminNav: NavItem[] = [{ to: "/admin/carta", label: "Carta" }]

export const catalogFeature = { adminRoutes, adminNav }
