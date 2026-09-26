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
import { CashRibbon } from "./CashRibbon";
import ShiftPage from "./ShiftPage";
import { ShiftStatusStrip } from "./ShiftStatusStrip";

// "turno" (no "cierre" ni ninguna otra pantalla): la spec agrupa todo el
// turno de caja bajo una sola vista —un panel con botones grandes desde
// 2026-09-25, antes pestañas— (SPEC-NEGOCIO § 9.1
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

// Turno lo ve todo el que se identifica, no sólo la caja: ahí está el panel
// donde cada persona marca su entrada, salida y pausa con su propio PIN.
const posNav: NavItem[] = [{ to: "/pos/turno", label: "Turno", icon: Wallet, posGroup: "caja" }];

/**
 * La base de respaldo (2026-09-26), para colgar de cualquier hoja (la cinta
 * de acciones de Mesas los usa). Props `{ shiftId: number; onDone?: () =>
 * void }`: `onDone` se llama después de guardar, para cerrar la hoja. Si
 * hay que devolver lo dice el servidor en `ShiftCurrent.reserve_loan`
 * (`GET /shifts/current`: monto > 0 = hay préstamo abierto; `null` = la
 * función `cash.reserve` está apagada). Nunca se resta en el frontend.
 */
export {
  ReturnToReservePanel,
  TakeFromReservePanel,
  VerifyReservePanel,
  type ReservePanelProps,
} from "./ReservePanels";

/**
 * La cinta de caja (2026-09-26): las acciones del turno a un toque desde
 * Mesas, en hojas encima del mapa. La monta `TablesPage` (dominio de
 * comandas); se exporta con nombre porque no es una ruta ni una entrada de
 * la barra.
 */
export { CashRibbon };

export const shiftsFeature = {
  posRoutes,
  adminRoutes,
  adminNav,
  posNav,
  ShiftStatusStrip,
  CashRibbon,
};
