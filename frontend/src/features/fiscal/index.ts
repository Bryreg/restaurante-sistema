/**
 * Punto de entrada del dominio "documento fiscal" para el shell del admin
 * (mismo patrón que `src/features/orders/index.ts`): `src/app/router.tsx`
 * y `AdminLayout.tsx` sólo conocen estas pantallas a través de
 * `fiscalFeature`. Este agente NO edita `src/app/**` — el dueño de
 * `router.tsx` registra `fiscalFeature.adminRoutes`/`adminNav`.
 *
 * Documento fiscal, rangos de numeración, notas y devoluciones pendientes
 * son ley (consecutivo, inmutabilidad, corrección por nota — AGENTS.md:
 * "lo que es ley... no es un flag"), así que estas cuatro secciones quedan
 * SIEMPRE visibles en el admin, sin `feature` que las apague (a diferencia
 * de, por ejemplo, `fiscal.invoice`, que gatea una FUNCIÓN puntual dentro
 * del cobro, no la existencia de esta pantalla).
 */
import { createElement } from "react";
import type { RouteObject } from "react-router-dom";

import type { NavItem } from "@/app/nav";

import { DocumentsPage } from "./DocumentsPage";
import { NotesPage } from "./NotesPage";
import { PendingRefundsPage } from "./PendingRefundsPage";
import { RangesPage } from "./RangesPage";

const adminRoutes: RouteObject[] = [
  { path: "fiscal/documentos", element: createElement(DocumentsPage) },
  { path: "fiscal/rangos", element: createElement(RangesPage) },
  { path: "fiscal/notas", element: createElement(NotesPage) },
  { path: "fiscal/devoluciones-pendientes", element: createElement(PendingRefundsPage) },
];

const adminNav: NavItem[] = [
  { to: "/admin/fiscal/documentos", label: "Documentos fiscales" },
  { to: "/admin/fiscal/rangos", label: "Rangos de numeración" },
  { to: "/admin/fiscal/notas", label: "Notas" },
  { to: "/admin/fiscal/devoluciones-pendientes", label: "Devoluciones pendientes" },
];

export const fiscalFeature = { adminRoutes, adminNav };
