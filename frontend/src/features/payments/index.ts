/**
 * Punto de entrada del dominio "cobro" (CONTRATO-INTERNO-1b-1.md §7.1):
 * `src/app/router.tsx` sólo conoce Cuenta y cobro y el Comprobante a través
 * de `paymentsFeature` — nada más de `src/app/**` se toca desde este
 * territorio salvo lo que el contrato ya le asigna a `frontend-cobro`.
 */
import { createElement } from "react";
import type { RouteObject } from "react-router-dom";

import type { NavItem } from "@/app/nav";

import CheckoutPage from "./CheckoutPage";
import DocumentPage from "./DocumentPage";

const posRoutes: RouteObject[] = [
  { path: "cobro/:orderId", element: createElement(CheckoutPage) },
  { path: "documento/:documentId", element: createElement(DocumentPage) },
];

// Sin entrada de navegación propia: se llega acá desde "Cuenta / Cobrar" en
// la comanda (frontend-comanda), nunca desde la barra del POS.
const posNav: NavItem[] = [];

export const paymentsFeature = { posRoutes, posNav };
