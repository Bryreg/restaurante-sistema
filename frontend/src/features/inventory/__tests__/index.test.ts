import { describe, expect, it } from "vitest"

import { inventoryFeature } from "../index"

describe("inventoryFeature", () => {
  it("expone Inventario (admin) detrás de inventory.perpetual y Merma (POS) detrás de inventory.waste", () => {
    expect(inventoryFeature.adminRoutes.map((r) => r.path)).toEqual(["inventario"])
    expect(inventoryFeature.posRoutes.map((r) => r.path)).toEqual(["merma"])

    expect(inventoryFeature.adminNav).toEqual([
      { to: "/admin/inventario", label: "Inventario", feature: "inventory.perpetual" },
    ])
    expect(inventoryFeature.posNav).toEqual([{ to: "/pos/merma", label: "Merma", feature: "inventory.waste" }])
  })
})
