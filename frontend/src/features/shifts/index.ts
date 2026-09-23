/**
 * Punto de entrada del dominio "turno de caja" (CONTRATO-INTERNO.md § 5):
 * sobreescribe el stub vacío que dejó `frontend-core` en este mismo archivo.
 * `src/app/router.tsx`, `AdminLayout.tsx` y `PosLayout.tsx` sólo conocen este
 * dominio a través de `shiftsFeature` — nada más de `src/app/**` se toca
 * desde este territorio.
 */
import { Wallet } from "lucide-react";
import { createElement } from "react";
import type { RouteObject } from "react-router-dom";

import type { NavItem } from "@/app/nav";

import { MoneyAdminPage } from "./admin/MoneyAdminPage";
import { PeopleAdminPage } from "./admin/PeopleAdminPage";
import ShiftPage from "./ShiftPage";
import { ShiftStatusStrip } from "./ShiftStatusStrip";

// "turno" (no "cierre" ni ninguna otra pantalla): la spec agrupa todo el
// turno de caja bajo una sola vista con pestañas (SPEC-NEGOCIO § 9.1
// "Turno"). Ya NO lleva `index: true` (CONTRATO-INTERNO-1b-1.md §6.2): la
// ruta índice de `/pos` es `PosHome` (frontend-cobro), que decide entre
// Mesas y Comanda nueva según `pos.tables`.
const posRoutes: RouteObject[] = [{ path: "turno", element: createElement(ShiftPage) }];

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

// Turno es de quien maneja la caja (`needsCharge`): el mesero no lo ve en la
// barra; abrir turno sigue a mano para todos desde `ShiftStatusStrip`.
const posNav: NavItem[] = [{ to: "/pos/turno", label: "Turno", icon: Wallet, posGroup: "caja", needsCharge: true }];

export const shiftsFeature = {
  posRoutes,
  adminRoutes,
  adminNav,
  posNav,
  ShiftStatusStrip,
};
