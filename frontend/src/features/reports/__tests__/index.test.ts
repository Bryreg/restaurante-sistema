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
      // Movida con motivo declarado (decisión del dueño 2026-09: el informe
      // del contador «igual que café-sistema», con entrada propia en
      // Informes y no sólo escondido en una pestaña de Ventas).
      "contador",
      "dinero/turno/:shiftId",
      "personal/persona/:employeeId",
      "inventario/insumo/:ingredientId",
      // Movida con motivo declarado (handoff, `MovilSecciones` variante A):
      // Caja, Equipo e Informes del celular son rutas de este dominio que
      // abre la barra inferior del celular; tampoco suman entradas al rail.
      "celular/caja",
      "celular/equipo",
      "celular/informes",
    ])

    expect(reportsFeature.adminNav).toEqual([
      { to: "/admin/hoy", label: "Hoy" },
      { to: "/admin/ventas", label: "Ventas" },
      { to: "/admin/informes", label: "Informes" },
      // Movida con el mismo motivo: la entrada visible del informe del contador.
      { to: "/admin/contador", label: "Informe del contador" },
    ])
    for (const item of reportsFeature.adminNav) {
      expect(item.feature).toBeUndefined()
    }
  })
})
