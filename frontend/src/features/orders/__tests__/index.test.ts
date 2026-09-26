import { describe, expect, it } from "vitest"

import { ordersFeature } from "../index"

describe("ordersFeature", () => {
  it("expone posRoutes, adminRoutes, adminNav y posNav con las rutas del contrato", () => {
    const posPaths = ordersFeature.posRoutes.map((r) => r.path)
    expect(posPaths).toEqual(["mesas", "mostrador", "comanda/nueva", "comanda/:orderId", "cocina"])

    const adminPaths = ordersFeature.adminRoutes.map((r) => r.path)
    expect(adminPaths).toEqual(["pedidos"])

    expect(ordersFeature.adminNav).toEqual([{ to: "/admin/pedidos", label: "Pedidos" }])

    // Cada entrada del salón lleva su ícono propio (el genérico era el mismo para todas).
    for (const item of ordersFeature.posNav) expect(item.icon).toBeDefined()
    expect(ordersFeature.posNav.map(({ icon: _icon, ...item }) => item)).toEqual([
      { to: "/pos/mesas", label: "Mesas", feature: "pos.tables" },
      // «Mostrador» abre la venta de mostrador directo; los demás canales,
      // en «Nuevo pedido».
      { to: "/pos/mostrador", label: "Mostrador", feature: "pos.counter" },
      { to: "/pos/comanda/nueva", label: "Nuevo pedido" },
      // Con `kitchen.kds` encendida la vista mínima se va de la barra: la
      // cocina tiene UNA pantalla (el KDS), no dos.
      {
        to: "/pos/cocina",
        label: "Cocina",
        feature: "kitchen.view",
        hiddenWithFeature: "kitchen.kds",
        posGroup: "cocina",
      },
    ])
  })
})
