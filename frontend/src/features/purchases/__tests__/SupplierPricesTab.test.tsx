import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { IngredientOut } from "@/api/inventory"
import type { IngredientSupplierPricesOut } from "@/api/purchases"
import { renderWithProviders } from "@/test/utils"

import { SupplierPricesTab } from "../SupplierPricesTab"

const { getPricesMock, listIngredientsMock } = vi.hoisted(() => ({
  getPricesMock: vi.fn(),
  listIngredientsMock: vi.fn(),
}))

vi.mock("@/api/purchases", async () => {
  const actual = await vi.importActual<typeof import("@/api/purchases")>("@/api/purchases")
  return { ...actual, getIngredientSupplierPrices: getPricesMock }
})
vi.mock("@/api/inventory", async () => {
  const actual = await vi.importActual<typeof import("@/api/inventory")>("@/api/inventory")
  return { ...actual, listIngredients: listIngredientsMock }
})

const POLLO = { id: 7, name: "Pechuga de pollo", base_unit: "g", purchase_unit: "kg" } as unknown as IngredientOut

const PRICES: IngredientSupplierPricesOut = {
  ingredient_id: 7,
  ingredient_name: "Pechuga de pollo",
  base_unit: "g",
  purchase_unit: "kg",
  alert_threshold_pct: 10,
  suppliers: [
    {
      supplier_id: 2,
      supplier_name: "Avícola A",
      supplier_active: true,
      purchases: [
        { reception_id: 9, business_date: "2026-01-12", purchase_unit_price: "15000", unit_cost: "15", qty_received: "1000", change_bp: 714 },
        { reception_id: 8, business_date: "2026-01-10", purchase_unit_price: "14000", unit_cost: "14", qty_received: "1000", change_bp: null },
      ],
    },
  ],
}

describe("Compras › Precios — historial por proveedor, tal cual lo calcula el servidor", () => {
  beforeEach(() => {
    getPricesMock.mockReset()
    listIngredientsMock.mockReset()
    listIngredientsMock.mockResolvedValue([POLLO])
    getPricesMock.mockResolvedValue(PRICES)
  })

  it("al elegir un insumo muestra las compras de cada proveedor con el cambio con signo y el umbral del aviso", async () => {
    const user = userEvent.setup()
    renderWithProviders(<SupplierPricesTab storeId={1} />)

    await user.click(screen.getByRole("combobox", { name: "Insumo" }))
    await user.click(await screen.findByRole("option", { name: "Pechuga de pollo" }))

    await waitFor(() => expect(getPricesMock).toHaveBeenCalledWith(1, 7))
    expect(await screen.findByText("Avícola A")).toBeInTheDocument()
    expect(screen.getByText("$ 15.000")).toBeInTheDocument()
    expect(screen.getByText(/▲ \+7,1/)).toBeInTheDocument()
    expect(screen.getByText(/más de 10 % contra la compra anterior/)).toBeInTheDocument()
  })
})
