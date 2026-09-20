import { describe, expect, it } from "vitest"

import { expensesFeature } from "../index"

describe("expensesFeature", () => {
  it("expone Gastos (admin) detrás de money.obligations, sin rutas de POS", () => {
    expect(expensesFeature.adminRoutes.map((r) => r.path)).toEqual(["gastos"])
    expect(expensesFeature.posRoutes).toEqual([])
    expect(expensesFeature.adminNav).toEqual([{ to: "/admin/gastos", label: "Gastos", feature: "money.obligations" }])
    expect(expensesFeature.posNav).toEqual([])
  })
})
