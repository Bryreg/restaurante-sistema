import { describe, expect, it } from "vitest"

import { ordersFeature } from "../index"

describe("ordersFeature", () => {
  it("expone posRoutes, adminRoutes, adminNav y posNav con las rutas del contrato", () => {
    const posPaths = ordersFeature.posRoutes.map((r) => r.path)
    expect(posPaths).toEqual(["mesas", "comanda/nueva", "comanda/:orderId", "cocina"])

    const adminPaths = ordersFeature.adminRoutes.map((r) => r.path)
    expect(adminPaths).toEqual(["pedidos"])

    expect(ordersFeature.adminNav).toEqual([{ to: "/admin/pedidos", label: "Pedidos" }])

    expect(ordersFeature.posNav).toEqual([
      { to: "/pos/mesas", label: "Mesas", feature: "pos.tables" },
      { to: "/pos/comanda/nueva", label: "Comanda" },
      { to: "/pos/cocina", label: "Cocina", feature: "kitchen.view" },
    ])
  })
})
