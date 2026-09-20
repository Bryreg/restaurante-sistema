import { describe, expect, it } from "vitest"

import { payrollFeature } from "../index"

describe("payrollFeature", () => {
  it("expone Nómina (admin), con dos entradas de nav detrás de payroll y pos.tips por separado", () => {
    expect(payrollFeature.adminRoutes.map((r) => r.path)).toEqual(["nomina"])
    expect(payrollFeature.posRoutes).toEqual([])
    expect(payrollFeature.adminNav).toEqual([
      { to: "/admin/nomina", label: "Nómina", feature: "payroll" },
      { to: "/admin/nomina?tab=propinas", label: "Propinas", feature: "pos.tips" },
    ])
    expect(payrollFeature.posNav).toEqual([])
  })
})
