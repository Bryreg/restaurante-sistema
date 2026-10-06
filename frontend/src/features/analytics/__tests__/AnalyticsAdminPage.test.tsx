import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { Route, Routes, useLocation } from "react-router-dom"

import { buildMe, renderWithProviders } from "@/test/utils"

import { AnalyticsAdminPage } from "../AnalyticsAdminPage"

vi.mock("@/app/storeContext", () => ({
  useStoreSelection: () => ({
    stores: [{ id: 1, name: "Sede Centro" }],
    loading: false,
    activeStoreId: 1,
    setActiveStoreId: vi.fn(),
  }),
}))

// Las pestañas montan su contenido aunque no estén activas: ninguna llega a la red.
vi.mock("@/api/analytics", async () => {
  const actual = await vi.importActual<typeof import("@/api/analytics")>("@/api/analytics")
  const pendiente = () => new Promise(() => {})
  return {
    ...actual,
    getMenuEngineering: vi.fn(pendiente),
    getVarianceByDish: vi.fn(pendiente),
    getControlHealthSustained: vi.fn(pendiente),
    getReplenishment: vi.fn(pendiente),
  }
})

const TODO = {
  "analytics.menu_engineering": true,
  "inventory.variance": true,
  "inventory.replenishment": true,
}

function UbicacionActual() {
  const { pathname, search } = useLocation()
  return <p data-testid="ubicacion">{`${pathname}${search}`}</p>
}

function renderEn(route: string) {
  return renderWithProviders(<AnalyticsAdminPage />, { me: buildMe({ features: TODO }), route })
}

describe("AnalyticsAdminPage — sólo las pestañas de la sección del armazón por la que se entró", () => {
  it("los `?tab=` viejos de la varianza redirigen a Inventario, su único lugar", async () => {
    // Cambio intencional (limpieza 2026-10): Varianza por plato y Salud
    // sostenida se mudaron a Inventario › Varianza y › Salud del control.
    for (const [viejo, nuevo] of [
      ["varianza", "/admin/inventario?tab=varianza"],
      ["salud-sostenida", "/admin/inventario?tab=salud"],
    ] as const) {
      const { unmount } = renderWithProviders(
        <Routes>
          <Route path="/admin/analitica" element={<AnalyticsAdminPage />} />
          <Route path="/admin/inventario" element={<UbicacionActual />} />
        </Routes>,
        { me: buildMe({ features: TODO }), route: `/admin/analitica?tab=${viejo}` },
      )
      expect(await screen.findByTestId("ubicacion")).toHaveTextContent(nuevo)
      unmount()
    }
  })

  it("en Ingeniería de menú y en Reposición no hay fila de pestañas: las pone el armazón", () => {
    const { unmount } = renderEn("/admin/analitica")
    expect(screen.getByRole("heading", { level: 1, name: "Ingeniería de menú" })).toBeInTheDocument()
    expect(screen.queryByRole("tab")).not.toBeInTheDocument()
    unmount()

    renderEn("/admin/analitica?tab=reposicion")
    expect(screen.getByRole("heading", { level: 1, name: "Reposición sugerida" })).toBeInTheDocument()
    expect(screen.queryByRole("tab")).not.toBeInTheDocument()
  })
})
