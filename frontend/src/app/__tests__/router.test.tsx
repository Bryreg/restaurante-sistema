import { describe, expect, it, vi } from "vitest";

import type { NavItem } from "../nav";

vi.mock("@/features/shifts", () => ({
  shiftsFeature: {
    posRoutes: [{ path: "turno", element: null }],
    adminRoutes: [{ path: "dinero", element: null }],
    adminNav: [] as NavItem[],
    posNav: [] as NavItem[],
    ShiftStatusStrip: () => null,
  },
}));

vi.mock("@/features/catalog", () => ({
  catalogFeature: {
    posRoutes: [],
    adminRoutes: [{ path: "carta", element: null }],
    adminNav: [] as NavItem[],
    posNav: [] as NavItem[],
  },
}));

vi.mock("@/features/orders", () => ({
  ordersFeature: {
    posRoutes: [
      { path: "mesas", element: null },
      { path: "comanda/nueva", element: null },
      { path: "comanda/:orderId", element: null },
      { path: "cocina", element: null },
    ],
    adminRoutes: [{ path: "pedidos", element: null }],
    adminNav: [] as NavItem[],
    posNav: [] as NavItem[],
  },
}));

// `paymentsFeature` es este mismo territorio — se deja real: es la
// verificación de que `router.tsx` lo integra tal como lo exporta
// `src/features/payments/index.ts`.

const { router } = await import("../router");

function findChild(children: { path?: string; index?: boolean }[] | undefined, path: string) {
  return children?.find((r) => r.path === path);
}

describe("router — integra shiftsFeature, catalogFeature, ordersFeature y paymentsFeature", () => {
  it("/pos monta el índice (PosHome) más las rutas de shifts, orders y payments", () => {
    const posRoute = router.routes.find((r) => r.path === "/pos");
    expect(posRoute).toBeDefined();
    const children = posRoute?.children ?? [];

    expect(children.some((r) => r.index === true)).toBe(true);
    expect(findChild(children, "turno")).toBeDefined();
    expect(findChild(children, "mesas")).toBeDefined();
    expect(findChild(children, "comanda/nueva")).toBeDefined();
    expect(findChild(children, "comanda/:orderId")).toBeDefined();
    expect(findChild(children, "cocina")).toBeDefined();
    expect(findChild(children, "cobro/:orderId")).toBeDefined();
    expect(findChild(children, "documento/:documentId")).toBeDefined();
  });

  it("/admin monta dinero, carta y pedidos (ordersFeature.adminRoutes)", () => {
    const adminRoute = router.routes.find((r) => r.path === "/admin");
    expect(adminRoute).toBeDefined();
    const children = adminRoute?.children ?? [];

    expect(findChild(children, "dinero")).toBeDefined();
    expect(findChild(children, "carta")).toBeDefined();
    expect(findChild(children, "pedidos")).toBeDefined();
  });
});
