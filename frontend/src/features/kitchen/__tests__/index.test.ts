import { describe, expect, it } from "vitest"

import { kitchenFeature } from "../index"

describe("kitchenFeature — manifiesto (CONTRATO C8, pedido 2c)", () => {
  it("expone posRoutes y posNav con la ruta del KDS, gateada por kitchen.kds", () => {
    const posPaths = kitchenFeature.posRoutes.map((r) => r.path)
    expect(posPaths).toEqual(["kds"])

    // Cada entrada del salón lleva su ícono propio (el genérico era el mismo para todas).
    for (const item of kitchenFeature.posNav) expect(item.icon).toBeDefined()
    expect(kitchenFeature.posNav.map(({ icon: _icon, ...item }) => item)).toEqual([
      { to: "/pos/kds", label: "Tiquetes de cocina", feature: "kitchen.kds", posGroup: "cocina" },
    ])
  })

  it("no declara adminRoutes ni adminNav: el KDS es puramente de dispositivo", () => {
    expect("adminRoutes" in kitchenFeature).toBe(false)
    expect("adminNav" in kitchenFeature).toBe(false)
  })
})
