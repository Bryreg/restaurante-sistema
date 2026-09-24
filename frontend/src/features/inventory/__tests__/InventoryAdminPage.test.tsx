import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
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

  it("tres pestañas a la vista y el resto en «Más», que respeta los mismos flags (regla 4)", async () => {
    const user = userEvent.setup()
    renderWithProviders(<InventoryAdminPage />, {
      me: buildMe({
        features: { "inventory.perpetual": true, "inventory.counts": true, "inventory.lots": true, "inventory.variance": false },
      }),
      route: "/admin/inventario",
    })

    await waitFor(() => expect(listIngredientsMock).toHaveBeenCalled())
    expect(screen.getAllByRole("tab").map((t) => t.textContent?.trim())).toEqual(["Insumos", "Stock", "Conteos"])

    await user.click(screen.getByRole("button", { name: "Más" }))
    expect(await screen.findByRole("menuitem", { name: "Movimientos y mermas" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Lotes" })).toBeInTheDocument()
    // `inventory.variance` apagada: ni Varianza ni Salud del control.
    expect(screen.queryByRole("menuitem", { name: "Varianza" })).not.toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Salud del control" })).not.toBeInTheDocument()
  })

  it("?tab=lotes (enlace de Hoy) sigue aterrizando en Lotes, y «Más» nombra dónde se está", async () => {
    renderWithProviders(<InventoryAdminPage />, {
      me: buildMe({ features: { "inventory.perpetual": true, "inventory.counts": true, "inventory.lots": true } }),
      route: "/admin/inventario?tab=lotes",
    })

    expect(await screen.findByRole("button", { name: /Más: Lotes/ })).toBeInTheDocument()
    expect(screen.getByRole("tabpanel")).toHaveTextContent(/lotes/i)
  })

  it("sin conteos, «Movimientos y mermas» ocupa el tercer lugar a la vista", async () => {
    renderWithProviders(<InventoryAdminPage />, {
      me: buildMe({ features: { "inventory.perpetual": true, "inventory.counts": false, "inventory.lots": false } }),
      route: "/admin/inventario",
    })

    await waitFor(() => expect(listIngredientsMock).toHaveBeenCalled())
    expect(screen.getAllByRole("tab").map((t) => t.textContent?.trim())).toEqual(["Insumos", "Stock", "Movimientos y mermas"])
    expect(screen.queryByRole("button", { name: "Más" })).not.toBeInTheDocument()
  })
})
