/**
 * Punto de entrada del dominio «reservas»: es la única forma en que
 * `src/app/router.tsx` y `PosLayout.tsx` conocen `/pos/reservas`.
 */

import { createElement } from "react";
import type { RouteObject } from "react-router-dom";

import type { NavItem } from "@/app/nav";

import { ReservationsPage } from "./ReservationsPage";

const posRoutes: RouteObject[] = [{ path: "reservas", element: createElement(ReservationsPage) }];

const posNav: NavItem[] = [{ to: "/pos/reservas", label: "Reservas", feature: "pos.reservations" }];

export const reservationsFeature = { posRoutes, posNav, adminRoutes: [], adminNav: [] };
