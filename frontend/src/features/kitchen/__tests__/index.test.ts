import { describe, expect, it } from "vitest"

import { kitchenFeature } from "../index"

describe("kitchenFeature — manifiesto (CONTRATO C8, pedido 2c)", () => {
  it("expone la pantalla de cocina y la del bar (el mismo KDS), gateadas por kitchen.view (en la barra, Cocina y Bar); /pos/cocina redirige a la de cocina", () => {
    const posPaths = kitchenFeature.posRoutes.map((r) => r.path)
    expect(posPaths).toEqual(["kds", "bar", "cocina"])

    // Cada entrada del salón lleva su ícono propio (el genérico era el mismo para todas).
    for (const item of kitchenFeature.posNav) expect(item.icon).toBeDefined()
    expect(kitchenFeature.posNav.map(({ icon: _icon, ...item }) => item)).toEqual([
      { to: "/pos/kds", label: "Cocina", feature: "kitchen.view", posGroup: "cocina" },
      { to: "/pos/bar", label: "Bar", feature: "kitchen.view", posGroup: "cocina" },
    ])
  })

  it("no declara adminRoutes ni adminNav: el KDS es puramente de dispositivo", () => {
    expect("adminRoutes" in kitchenFeature).toBe(false)
    expect("adminNav" in kitchenFeature).toBe(false)
  })
})
