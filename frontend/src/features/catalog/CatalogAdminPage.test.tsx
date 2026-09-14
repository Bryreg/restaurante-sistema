import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders } from "@/test/utils"

import { CatalogAdminPage } from "./CatalogAdminPage"

vi.mock("@/app/storeContext", () => ({
  useStoreSelection: () => ({
    stores: [{ id: 1, name: "Sede Centro" }],
    loading: false,
    activeStoreId: 1,
    setActiveStoreId: vi.fn(),
  }),
}))

vi.mock("@/api/catalog", async () => {
  const actual = await vi.importActual<typeof import("@/api/catalog")>("@/api/catalog")
  return {
    ...actual,
    listCategories: vi.fn().mockResolvedValue([]),
    listProducts: vi.fn().mockResolvedValue([]),
    listCombos: vi.fn().mockResolvedValue([]),
  }
})

describe("CatalogAdminPage", () => {
  it("no renderiza la pestaña Combos cuando pos.combos está apagado", () => {
    renderWithProviders(<CatalogAdminPage />, {
      me: {
        kind: "admin",
        organization: { id: 1, name: "Org" },
        features: {
          "pos.modifiers": true,
          "pos.combos": false,
          "pos.daily_menu": false,
          "pos.daily_count": true,
        },
      },
    })

    expect(screen.getByRole("tab", { name: "Categorías" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Productos" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Modificadores" })).toBeInTheDocument()
    expect(screen.queryByRole("tab", { name: "Combos" })).not.toBeInTheDocument()
    expect(screen.queryByRole("tab", { name: "Menú del día" })).not.toBeInTheDocument()
  })

  it("renderiza Combos y Menú del día cuando ambos flags están encendidos", () => {
    renderWithProviders(<CatalogAdminPage />, {
      me: {
        kind: "admin",
        organization: { id: 1, name: "Org" },
        features: { "pos.combos": true, "pos.daily_menu": true },
      },
    })

    expect(screen.getByRole("tab", { name: "Combos" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Menú del día" })).toBeInTheDocument()
  })
})
