import { describe, expect, it } from "vitest"

import { reportsFeature } from "../index"

describe("reportsFeature", () => {
  it("expone adminRoutes/adminNav de Hoy, Ventas e Informes, sin flag (núcleo del admin)", () => {
    const adminPaths = reportsFeature.adminRoutes.map((r) => r.path)
    expect(adminPaths).toEqual(["hoy", "ventas", "informes"])

    expect(reportsFeature.adminNav).toEqual([
      { to: "/admin/hoy", label: "Hoy" },
      { to: "/admin/ventas", label: "Ventas" },
      { to: "/admin/informes", label: "Informes" },
    ])
    for (const item of reportsFeature.adminNav) {
      expect(item.feature).toBeUndefined()
    }
  })
})
