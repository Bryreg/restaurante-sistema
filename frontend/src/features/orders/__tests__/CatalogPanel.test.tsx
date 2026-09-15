import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders } from "@/test/utils"

import { CatalogPanel } from "../CatalogPanel"
import { buildCatalog, buildCatalogCombo, buildCatalogProduct, deviceMe } from "./fixtures"

const { useCatalogMock, useFavoritesMock } = vi.hoisted(() => ({
  useCatalogMock: vi.fn(),
  useFavoritesMock: vi.fn(),
}))

vi.mock("../hooks", async () => {
  const actual = await vi.importActual<typeof import("../hooks")>("../hooks")
  return { ...actual, useCatalog: useCatalogMock, useFavorites: useFavoritesMock }
})

describe("CatalogPanel", () => {
  it("muestra la pestaña Menú del día PRIMERO y activa cuando hay un combo active_now y la flag está encendida", () => {
    useCatalogMock.mockReturnValue({
      data: buildCatalog({ combos: [buildCatalogCombo({ active_now: true })] }),
      isLoading: false,
    })
    useFavoritesMock.mockReturnValue({ data: [], isLoading: false })

    renderWithProviders(<CatalogPanel channel="dine_in" onSelectProduct={vi.fn()} onSelectCombo={vi.fn()} />, {
      me: deviceMe({ "pos.daily_menu": true }),
    })

    const tabs = screen.getAllByRole("tab")
    expect(tabs[0]).toHaveTextContent("Menú del día")
    // El contenido del combo activo está visible sin tocar nada: es la pestaña activa por defecto.
    expect(screen.getByText("Menú ejecutivo")).toBeInTheDocument()
  })

  it("sin combos active_now o con la flag apagada no muestra la pestaña Menú del día", () => {
    useCatalogMock.mockReturnValue({ data: buildCatalog({ combos: [] }), isLoading: false })
    useFavoritesMock.mockReturnValue({ data: [], isLoading: false })

    renderWithProviders(<CatalogPanel channel="dine_in" onSelectProduct={vi.fn()} onSelectCombo={vi.fn()} />, {
      me: deviceMe({ "pos.daily_menu": true }),
    })

    expect(screen.queryByRole("tab", { name: "Menú del día" })).not.toBeInTheDocument()
  })

  it("un producto agotado se muestra deshabilitado", () => {
    useCatalogMock.mockReturnValue({
      data: buildCatalog({ products: [buildCatalogProduct({ id: 10, available: false })] }),
      isLoading: false,
    })
    // Favoritos es la pestaña activa por defecto acá (sin menú del día): se
    // pone el producto agotado entre los favoritos para verlo sin más clics.
    useFavoritesMock.mockReturnValue({ data: [{ product_id: 10, qty: 5 }], isLoading: false })

    renderWithProviders(<CatalogPanel channel="dine_in" onSelectProduct={vi.fn()} onSelectCombo={vi.fn()} />, {
      me: deviceMe({}),
    })

    const button = screen.getByRole("button", { name: /limonada de coco/i })
    expect(button).toBeDisabled()
    expect(screen.getByText("Agotado")).toBeInTheDocument()
  })
})
