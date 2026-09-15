/**
 * Punto de entrada del dominio "clientes y habeas data" para el shell del
 * admin (mismo patrón que `src/features/orders/index.ts`): `router.tsx` y
 * `AdminLayout.tsx` sólo conocen esta pantalla a través de
 * `customersFeature`. Este agente NO edita `src/app/**` — el dueño de
 * `router.tsx` registra `customersFeature.adminRoutes`/`adminNav`.
 */
import { createElement } from "react";
import type { RouteObject } from "react-router-dom";

import type { NavItem } from "@/app/nav";

import { CustomersPage } from "./CustomersPage";

const adminRoutes: RouteObject[] = [{ path: "clientes", element: createElement(CustomersPage) }];

const adminNav: NavItem[] = [{ to: "/admin/clientes", label: "Clientes", feature: "customers" }];

export const customersFeature = { adminRoutes, adminNav };
