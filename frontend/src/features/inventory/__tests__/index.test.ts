import { describe, expect, it } from "vitest"

import { inventoryFeature } from "../index"

describe("inventoryFeature", () => {
  it("expone Inventario (admin) detrás de inventory.perpetual y Merma (POS) detrás de inventory.waste", () => {
    expect(inventoryFeature.adminRoutes.map((r) => r.path)).toEqual(["inventario", "inventario/conteos/:countId"])
    expect(inventoryFeature.posRoutes.map((r) => r.path)).toEqual(["merma"])

    expect(inventoryFeature.adminNav).toEqual([
      { to: "/admin/inventario", label: "Inventario", feature: "inventory.perpetual" },
    ])
    // Cada entrada del salón lleva su ícono propio (el genérico era el mismo para todas).
    for (const item of inventoryFeature.posNav) expect(item.icon).toBeDefined()
    expect(inventoryFeature.posNav.map(({ icon: _icon, ...item }) => item)).toEqual([
      { to: "/pos/merma", label: "Merma", feature: "inventory.waste", posGroup: "cocina" },
    ])
  })
})
