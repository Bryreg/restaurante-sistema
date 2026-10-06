import { describe, expect, it } from "vitest"

import { bankingFeature } from "../index"

describe("bankingFeature", () => {
  it("expone Consignaciones (Caja) y el libro, la mano y las conciliaciones (Plata), sin rutas de POS", () => {
    expect(bankingFeature.adminRoutes.map((r) => r.path)).toEqual(["banco", "plata"])
    expect(bankingFeature.posRoutes).toEqual([])
    expect(bankingFeature.adminNav).toEqual([
      { to: "/admin/banco", label: "Consignaciones", feature: "money.deposits" },
      { to: "/admin/plata", label: "Libro del banco", feature: "money.bank" },
      { to: "/admin/plata?tab=mano", label: "Mano del dueño", feature: "money.bank" },
      { to: "/admin/plata?tab=datafono", label: "Conciliaciones", feature: "money.bank" },
    ])
    expect(bankingFeature.posNav).toEqual([])
  })
})
