import { describe, expect, it } from "vitest"

import { reportsFeature } from "../index"

describe("reportsFeature", () => {
  it("expone adminRoutes/adminNav de Hoy y Ventas, sin flag (núcleo del admin)", () => {
    const adminPaths = reportsFeature.adminRoutes.map((r) => r.path)
    expect(adminPaths).toEqual(["hoy", "ventas"])

    expect(reportsFeature.adminNav).toEqual([
      { to: "/admin/hoy", label: "Hoy" },
      { to: "/admin/ventas", label: "Ventas" },
    ])
    for (const item of reportsFeature.adminNav) {
      expect(item.feature).toBeUndefined()
    }
  })
})
