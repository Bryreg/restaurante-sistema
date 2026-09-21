import { screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { IngredientOut } from "@/api/inventory"
import { renderWithProviders } from "@/test/utils"

import { IngredientsTab } from "../IngredientsTab"

const { listIngredientsMock } = vi.hoisted(() => ({ listIngredientsMock: vi.fn() }))

vi.mock("@/api/inventory", async () => {
  const actual = await vi.importActual<typeof import("@/api/inventory")>("@/api/inventory")
  return { ...actual, listIngredients: listIngredientsMock }
})

const SAL: IngredientOut = {
  id: 9,
  name: "Sal de mesa",
  category: null,
  base_unit: "g",
  purchase_unit: "bulto 25kg",
  purchase_factor: 25000,
  yield_pct: 100,
  official_cost: null,
  estimated_cost: "0.003",
  // Costo real del seed: $0,003/g ($3.000 el bulto de 25 kg). Redondeado a
  // peso entero (`formatCOP`, `maximumFractionDigits: 0`) publicaba "$ 0"
  // con origen "estimado" — el cero mudo que B-2 (ronda 2) corrige.
  cost: "0.003",
  cost_source: "estimated",
  min_stock: "5000",
  lead_time_days: null,
  perishable: false,
  key_item: false,
  consumption_untracked: true,
  substitute_ingredient_id: null,
  supplier_id: null,
  active: true,
}

describe("IngredientsTab — costo con origen, nunca un cero mudo (B-2, ronda 2)", () => {
  it("un insumo a $0,003/g (la sal del seed) no se pinta «$ 0» en la fila", async () => {
    listIngredientsMock.mockResolvedValue([SAL])

    renderWithProviders(<IngredientsTab storeId={1} />)

    await waitFor(() => expect(screen.getByText("Sal de mesa")).toBeInTheDocument())

    // El costo real está, con su origen — pero nunca redondeado a "$ 0".
    expect(screen.getByText("estimado")).toBeInTheDocument()
    expect(within(screen.getByRole("table")).queryByText("$ 0")).not.toBeInTheDocument()
    expect(within(screen.getByRole("table")).queryByText("Sin costo")).not.toBeInTheDocument()
  })
})
