import { screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { buildMe, renderWithProviders } from "@/test/utils"

import { InventoryAdminPage } from "../InventoryAdminPage"

vi.mock("@/app/storeContext", () => ({
  useStoreSelection: () => ({ stores: [{ id: 1, name: "Sede Centro" }], loading: false, activeStoreId: 1, setActiveStoreId: vi.fn() }),
}))

const { listIngredientsMock, getInventoryStockMock } = vi.hoisted(() => ({
  listIngredientsMock: vi.fn().mockResolvedValue([]),
  getInventoryStockMock: vi.fn().mockResolvedValue([]),
}))

vi.mock("@/api/inventory", async () => {
  const actual = await vi.importActual<typeof import("@/api/inventory")>("@/api/inventory")
  return { ...actual, listIngredients: listIngredientsMock, getInventoryStock: getInventoryStockMock }
})

describe("InventoryAdminPage", () => {
  it("con inventory.perpetual apagada explica qué la prende, no una pantalla rota", () => {
    renderWithProviders(<InventoryAdminPage />, { me: buildMe({ features: { "inventory.perpetual": false } }), route: "/admin/inventario" })
    expect(screen.getByText(/no está encendida/i)).toBeInTheDocument()
    expect(screen.getByText("inventory.perpetual")).toBeInTheDocument()
    expect(listIngredientsMock).not.toHaveBeenCalled()
  })

  it("?tab=stock&negative=1 abre directo en Stock con el filtro de negativos puesto (enlace desde «Hoy»)", async () => {
    renderWithProviders(<InventoryAdminPage />, {
      me: buildMe({ features: { "inventory.perpetual": true } }),
      route: "/admin/inventario?tab=stock&negative=1",
    })

    await waitFor(() =>
      expect(getInventoryStockMock).toHaveBeenCalledWith(expect.objectContaining({ storeId: 1, negative: true, belowMin: false, criticalOnly: false })),
    )
    expect(screen.getByRole("tab", { name: "Stock", selected: true })).toBeInTheDocument()
  })

  it("sin query param abre en Insumos por defecto", async () => {
    renderWithProviders(<InventoryAdminPage />, {
      me: buildMe({ features: { "inventory.perpetual": true } }),
      route: "/admin/inventario",
    })

    await waitFor(() => expect(listIngredientsMock).toHaveBeenCalled())
    expect(screen.getByRole("tab", { name: "Insumos", selected: true })).toBeInTheDocument()
  })
})
