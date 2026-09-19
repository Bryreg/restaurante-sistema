import { describe, expect, it } from "vitest"

import { purchasesFeature } from "../index"

describe("purchasesFeature", () => {
  it("expone Compras (admin) detrás de purchases, y nada bajo /pos", () => {
    expect(purchasesFeature.adminRoutes.map((r) => r.path)).toEqual(["compras"])
    expect(purchasesFeature.adminNav).toEqual([{ to: "/admin/compras", label: "Compras", feature: "purchases" }])

    // Regla dura: la recepción lleva precios, el PIN de quien recibe es
    // atribución, no una sesión de dispositivo — nunca una ruta bajo /pos.
    expect(purchasesFeature.posRoutes).toEqual([])
    expect(purchasesFeature.posNav).toEqual([])
  })
})
