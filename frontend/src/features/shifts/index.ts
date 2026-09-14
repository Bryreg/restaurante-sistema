/**
 * Punto de entrada del dominio "turno de caja" (CONTRATO-INTERNO.md § 5):
 * sobreescribe el stub vacío que dejó `frontend-core` en este mismo archivo.
 * `src/app/router.tsx`, `AdminLayout.tsx` y `PosLayout.tsx` sólo conocen este
 * dominio a través de `shiftsFeature` — nada más de `src/app/**` se toca
 * desde este territorio.
 */
import { createElement } from "react";
import type { RouteObject } from "react-router-dom";

import type { NavItem } from "@/app/nav";

import { MoneyAdminPage } from "./admin/MoneyAdminPage";
import { PeopleAdminPage } from "./admin/PeopleAdminPage";
import ShiftPage from "./ShiftPage";
import { ShiftStatusStrip } from "./ShiftStatusStrip";

// "turno" (no "cierre" ni ninguna otra pantalla): la spec agrupa todo el
// turno de caja bajo una sola vista con pestañas (SPEC-NEGOCIO § 9.1
// "Turno"); `index: true` para que `navigate("/pos")` tras identificarse
// (`DeviceIdentifyPage`, frontend-core) resuelva a algo.
const posRoutes: RouteObject[] = [
  { index: true, element: createElement(ShiftPage) },
  { path: "turno", element: createElement(ShiftPage) },
];

const adminRoutes: RouteObject[] = [
  { path: "dinero", element: createElement(MoneyAdminPage) },
  { path: "personal", element: createElement(PeopleAdminPage) },
];

// Dinero y Turnos y personal son núcleo (spec § 9.3): sin `feature`, se
// muestran siempre — igual que Funciones/Configuración/Historial en
// `AdminLayout.tsx`.
const adminNav: NavItem[] = [
  { to: "/admin/dinero", label: "Dinero" },
  { to: "/admin/personal", label: "Turnos y personal" },
];

const posNav: NavItem[] = [{ to: "/pos/turno", label: "Turno" }];

export const shiftsFeature = {
  posRoutes,
  adminRoutes,
  adminNav,
  posNav,
  ShiftStatusStrip,
};
