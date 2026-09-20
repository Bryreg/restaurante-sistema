import { describe, expect, it } from "vitest"

import { kitchenFeature } from "../index"

describe("kitchenFeature — manifiesto (CONTRATO C8, pedido 2c)", () => {
  it("expone posRoutes y posNav con la ruta del KDS, gateada por kitchen.kds", () => {
    const posPaths = kitchenFeature.posRoutes.map((r) => r.path)
    expect(posPaths).toEqual(["kds"])

    expect(kitchenFeature.posNav).toEqual([{ to: "/pos/kds", label: "KDS", feature: "kitchen.kds" }])
  })

  it("no declara adminRoutes ni adminNav: el KDS es puramente de dispositivo", () => {
    expect("adminRoutes" in kitchenFeature).toBe(false)
    expect("adminNav" in kitchenFeature).toBe(false)
  })
})
