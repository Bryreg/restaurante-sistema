import { describe, expect, it } from "vitest"

import { analyticsFeature } from "../index"

describe("analyticsFeature", () => {
  it("expone Analítica (admin), con tres entradas de nav: menu_engineering, inventory.variance y inventory.replenishment", () => {
    expect(analyticsFeature.adminRoutes.map((r) => r.path)).toEqual(["analitica"])
    expect(analyticsFeature.posRoutes).toEqual([])
    expect(analyticsFeature.adminNav).toEqual([
      { to: "/admin/analitica", label: "Ingeniería de menú", feature: "analytics.menu_engineering" },
      { to: "/admin/analitica?tab=varianza", label: "Varianza y salud", feature: "inventory.variance" },
      { to: "/admin/analitica?tab=reposicion", label: "Reposición", feature: "inventory.replenishment" },
    ])
    expect(analyticsFeature.posNav).toEqual([])
  })
})
