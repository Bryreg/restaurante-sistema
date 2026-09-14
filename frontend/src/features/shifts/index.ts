/**
 * STUB de handoff — lo sobreescribe `frontend-caja` con el turno de caja
 * real (contrato interno § 5). `frontend-core` sólo crea este archivo si no
 * existe todavía, para que `router.tsx`, `AdminLayout.tsx` y `PosLayout.tsx`
 * puedan importar `shiftsFeature` desde el primer commit sin esperar a que
 * el otro agente termine.
 */
import type { ComponentType } from "react";
import type { RouteObject } from "react-router-dom";

import type { NavItem } from "@/app/nav";

function ShiftStatusStrip(): null {
  return null;
}

export const shiftsFeature: {
  posRoutes: RouteObject[];
  adminRoutes: RouteObject[];
  adminNav: NavItem[];
  posNav: NavItem[];
  ShiftStatusStrip: ComponentType;
} = {
  posRoutes: [],
  adminRoutes: [],
  adminNav: [],
  posNav: [],
  ShiftStatusStrip,
};
