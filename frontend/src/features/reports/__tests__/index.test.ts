import { describe, expect, it } from "vitest"

import { reportsFeature } from "../index"

describe("reportsFeature", () => {
  it("expone adminRoutes/adminNav de Hoy, Ventas e Informes, sin flag (núcleo del admin)", () => {
    const adminPaths = reportsFeature.adminRoutes.map((r) => r.path)
    // Movida con motivo declarado (panel de control, fichas relacionales):
    // las tres fichas —turno, persona, insumo— son rutas de este dominio que
    // cuelgan de la pantalla de su sección y NO suman entradas de navegación
    // (el `adminNav` de abajo sigue siendo el mismo, y lo sigue fijando).
    expect(adminPaths).toEqual([
      "hoy",
      "ventas",
      "informes",
      "dinero/turno/:shiftId",
      "personal/persona/:employeeId",
      "inventario/insumo/:ingredientId",
    ])

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
