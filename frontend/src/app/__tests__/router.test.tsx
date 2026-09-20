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
// `src/features/payments/index.ts`. `inventoryFeature`, `recipesFeature`
// (`frontend-recetas`, pedido 2a), `purchasesFeature` (este territorio,
// pedido 2b) y `kitchenFeature` (este territorio, pedido 2c) también se
// dejan reales por el mismo motivo — es exactamente el "contra el router
// REAL, sin mockear" que pide CONTRATO C8 de la spec de 2c.

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

  it("/admin monta hoy, ventas (reportsFeature), fiscal/* (fiscalFeature) y clientes (customersFeature) — pedido 1b-2", () => {
    const adminRoute = router.routes.find((r) => r.path === "/admin");
    const children = adminRoute?.children ?? [];

    expect(findChild(children, "hoy")).toBeDefined();
    expect(findChild(children, "ventas")).toBeDefined();
    expect(findChild(children, "fiscal/documentos")).toBeDefined();
    expect(findChild(children, "fiscal/rangos")).toBeDefined();
    expect(findChild(children, "fiscal/notas")).toBeDefined();
    expect(findChild(children, "fiscal/devoluciones-pendientes")).toBeDefined();
    expect(findChild(children, "clientes")).toBeDefined();
  });

  it("/admin monta inventario (inventoryFeature) y preparaciones (recipesFeature) — pedido 2a", () => {
    const adminRoute = router.routes.find((r) => r.path === "/admin");
    const children = adminRoute?.children ?? [];

    expect(findChild(children, "inventario")).toBeDefined();
    expect(findChild(children, "preparaciones")).toBeDefined();
  });

  it("/pos monta merma (inventoryFeature) y produccion (recipesFeature) — pedido 2a", () => {
    const posRoute = router.routes.find((r) => r.path === "/pos");
    const children = posRoute?.children ?? [];

    expect(findChild(children, "merma")).toBeDefined();
    expect(findChild(children, "produccion")).toBeDefined();
  });

  it("/admin monta compras (purchasesFeature) — pedido 2b", () => {
    const adminRoute = router.routes.find((r) => r.path === "/admin");
    const children = adminRoute?.children ?? [];

    expect(findChild(children, "compras")).toBeDefined();
  });

  it("/pos monta kds (kitchenFeature) — pedido 2c, CONTRATO C8", () => {
    const posRoute = router.routes.find((r) => r.path === "/pos");
    const children = posRoute?.children ?? [];

    expect(findChild(children, "kds")).toBeDefined();
    // La vista mínima de 1b sigue viniendo de `ordersFeature`, sin tocar.
    expect(findChild(children, "cocina")).toBeDefined();
  });

  it("/pos NO monta ninguna ruta de compras — la recepción lleva precios y es pantalla de administrador (invariante heredado #2)", () => {
    const posRoute = router.routes.find((r) => r.path === "/pos");
    const children = posRoute?.children ?? [];

    expect(findChild(children, "compras")).toBeUndefined();
    expect(children.some((r) => typeof r.path === "string" && r.path.includes("compras"))).toBe(false);
  });

  it("la ruta índice de /admin redirige a «hoy» — es la pantalla por la que el dueño abre el admin", () => {
    const adminRoute = router.routes.find((r) => r.path === "/admin");
    const children = adminRoute?.children ?? [];
    const indexRoute = children.find((r) => r.index === true) as { element?: React.ReactElement<{ to?: string }> } | undefined;

    expect(indexRoute?.element?.props?.to).toBe("hoy");
  });
});
