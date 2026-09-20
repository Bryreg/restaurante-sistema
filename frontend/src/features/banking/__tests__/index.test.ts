import { describe, expect, it } from "vitest"

import { bankingFeature } from "../index"

describe("bankingFeature", () => {
  it("expone Banco (admin) detrás de money.deposits, sin rutas de POS", () => {
    expect(bankingFeature.adminRoutes.map((r) => r.path)).toEqual(["banco"])
    expect(bankingFeature.posRoutes).toEqual([])
    expect(bankingFeature.adminNav).toEqual([{ to: "/admin/banco", label: "Banco", feature: "money.deposits" }])
    expect(bankingFeature.posNav).toEqual([])
  })
})
