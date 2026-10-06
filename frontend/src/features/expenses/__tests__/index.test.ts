import { describe, expect, it } from "vitest"

import { expensesFeature } from "../index"

describe("expensesFeature", () => {
  it("expone Gastos (admin) detrás de money.obligations, sin rutas de POS", () => {
    expect(expensesFeature.adminRoutes.map((r) => r.path)).toEqual(["gastos"])
    expect(expensesFeature.posRoutes).toEqual([])
    expect(expensesFeature.adminNav).toEqual([
      { to: "/admin/gastos", label: "Gastos", feature: "money.obligations" },
      { to: "/admin/gastos?tab=obligaciones", label: "Obligaciones", feature: "money.obligations" },
      { to: "/admin/gastos?tab=cuentas-por-pagar", label: "Cuentas por pagar", feature: "money.obligations" },
    ])
    expect(expensesFeature.posNav).toEqual([])
  })
})
