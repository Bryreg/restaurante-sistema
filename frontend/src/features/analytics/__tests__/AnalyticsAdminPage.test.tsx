import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

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

function renderEn(route: string) {
  return renderWithProviders(<AnalyticsAdminPage />, { me: buildMe({ features: TODO }), route })
}

describe("AnalyticsAdminPage — sólo las pestañas de la sección del armazón por la que se entró", () => {
  it("en Varianza y salud: Varianza por plato · Salud sostenida, y nada de Ingeniería ni Reposición", () => {
    renderEn("/admin/analitica?tab=salud-sostenida")

    expect(screen.getByRole("heading", { level: 1, name: "Varianza y salud" })).toBeInTheDocument()
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Varianza por plato", "Salud sostenida"])
    expect(screen.getByRole("tab", { name: "Salud sostenida" })).toHaveAttribute("aria-selected", "true")
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
