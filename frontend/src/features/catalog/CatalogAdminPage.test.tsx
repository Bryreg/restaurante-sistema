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

// La pestaña "Recetas" (pedido 2a) puede quedar montada aunque no esté
// activa (los `Tabs` de base-ui no desmontan el contenido inactivo): se
// mockea acá también para que ningún test de este archivo dispare una
// llamada real a la red.
vi.mock("@/api/recipes", async () => {
  const actual = await vi.importActual<typeof import("@/api/recipes")>("@/api/recipes")
  return {
    ...actual,
    listIngredientOptions: vi.fn().mockResolvedValue([]),
    listPreparations: vi.fn().mockResolvedValue([]),
    getRecipeCoverage: vi.fn().mockResolvedValue([]),
    getSuspiciousUnits: vi.fn().mockResolvedValue([]),
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

  it("sin catalog.recipes no ofrece la pestaña Recetas: vende exactamente como hoy", () => {
    renderWithProviders(<CatalogAdminPage />, {
      me: {
        kind: "admin",
        organization: { id: 1, name: "Org" },
        features: { "catalog.recipes": false },
      },
    })

    expect(screen.queryByRole("tab", { name: "Recetas" })).not.toBeInTheDocument()
  })

  it("con catalog.recipes ofrece la pestaña Recetas (fichas técnicas, cobertura, unidades sospechosas)", async () => {
    renderWithProviders(<CatalogAdminPage />, {
      me: {
        kind: "admin",
        organization: { id: 1, name: "Org" },
        features: { "catalog.recipes": true },
      },
    })

    expect(screen.getByRole("tab", { name: "Recetas" })).toBeInTheDocument()
  })
})
