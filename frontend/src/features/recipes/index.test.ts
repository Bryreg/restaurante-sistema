import { describe, expect, it } from "vitest"

import { recipesFeature } from "./index"

/**
 * `recipesFeature` es el único símbolo por el que `src/app/router.tsx` (y
 * `PosLayout`/`AdminLayout`) conocen estas pantallas — mismo contrato que
 * `ordersFeature` (`frontend/src/features/orders/index.ts`). Este test es la
 * red que evita que un refactor rompa esa forma en silencio y tumbe el
 * typecheck de todo el frontend cuando el dueño de `router.tsx` lo importe.
 */
describe("recipesFeature", () => {
  it("expone las cuatro listas que router.tsx / PosLayout / AdminLayout esperan", () => {
    expect(Array.isArray(recipesFeature.posRoutes)).toBe(true)
    expect(Array.isArray(recipesFeature.adminRoutes)).toBe(true)
    expect(Array.isArray(recipesFeature.posNav)).toBe(true)
    expect(Array.isArray(recipesFeature.adminNav)).toBe(true)
  })

  it("la producción rápida vive en /pos/produccion, detrás de catalog.preps", () => {
    expect(recipesFeature.posRoutes.some((r) => r.path === "produccion")).toBe(true)
    expect(recipesFeature.posNav).toEqual([{ to: "/pos/produccion", label: "Producir", feature: "catalog.preps" }])
  })

  it("Preparaciones vive en /admin/preparaciones, detrás de catalog.preps", () => {
    expect(recipesFeature.adminRoutes.some((r) => r.path === "preparaciones")).toBe(true)
    expect(recipesFeature.adminNav).toEqual([
      { to: "/admin/preparaciones", label: "Preparaciones", feature: "catalog.preps" },
    ])
  })
})
