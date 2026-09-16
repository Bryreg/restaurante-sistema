import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { ProductAdminOut } from "@/api/catalog"
import type { ProductRecipeOut } from "@/api/recipes"
import { renderWithProviders } from "@/test/utils"

import { RecipeEditor } from "./RecipeEditor"

const { listProductsMock, getProductRecipeMock, putProductRecipeMock, listIngredientOptionsMock, listPreparationsMock } =
  vi.hoisted(() => ({
    listProductsMock: vi.fn(),
    getProductRecipeMock: vi.fn(),
    putProductRecipeMock: vi.fn(),
    listIngredientOptionsMock: vi.fn().mockResolvedValue([{ id: 7, name: "Papa criolla", base_unit: "g" }]),
    listPreparationsMock: vi.fn().mockResolvedValue([]),
  }))

vi.mock("@/api/catalog", async () => {
  const actual = await vi.importActual<typeof import("@/api/catalog")>("@/api/catalog")
  return { ...actual, listProducts: listProductsMock }
})

vi.mock("@/api/recipes", async () => {
  const actual = await vi.importActual<typeof import("@/api/recipes")>("@/api/recipes")
  return {
    ...actual,
    getProductRecipe: getProductRecipeMock,
    putProductRecipe: putProductRecipeMock,
    listIngredientOptions: listIngredientOptionsMock,
    listPreparations: listPreparationsMock,
  }
})

const PRODUCTS: ProductAdminOut[] = [
  {
    id: 5,
    category_id: 1,
    name: "Bandeja paisa",
    description: null,
    station: null,
    default_course: null,
    prices: { dine_in: 38_000, takeout: null, delivery: null, platform: null },
    tax_code: "inc_8",
    active: true,
    available: true,
  },
]

function recipe(overrides: Partial<ProductRecipeOut> = {}): ProductRecipeOut {
  return {
    product_id: 5,
    version: 1,
    // `theoretical_cost` viaja como string decimal (ronda 2 del contrato:
    // precisión completa, no entero) — nunca un número JSON.
    theoretical_cost: "12000",
    cost_source: "official",
    food_cost_pct: "31.58",
    net_price: 38_000,
    lines: [
      { ingredient_id: 7, ingredient_name: "Papa criolla", preparation_id: null, preparation_name: null, qty: "300", unit: "g" },
    ],
    ...overrides,
  }
}

describe("RecipeEditor", () => {
  it("sin plato elegido no pide la ficha", () => {
    listProductsMock.mockResolvedValue(PRODUCTS)
    renderWithProviders(<RecipeEditor storeId={1} />)
    expect(getProductRecipeMock).not.toHaveBeenCalled()
  })

  it("muestra la versión, el costo con origen y el food cost %, y guardar sube la versión (v1 → v2)", async () => {
    listProductsMock.mockResolvedValue(PRODUCTS)
    getProductRecipeMock.mockResolvedValue(recipe())
    putProductRecipeMock.mockResolvedValue(recipe({ version: 2 }))

    const user = userEvent.setup()
    renderWithProviders(<RecipeEditor storeId={1} />)

    await user.click(await screen.findByRole("combobox", { name: "Plato" }))
    await user.click(await screen.findByRole("option", { name: "Bandeja paisa" }))

    await waitFor(() => expect(screen.getByText("v1")).toBeInTheDocument())
    expect(screen.getByText("$ 12.000")).toBeInTheDocument()
    expect(screen.getByText("oficial")).toBeInTheDocument()
    expect(screen.getByText("Food cost 31.58%")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Guardar ficha" }))

    await waitFor(() => expect(putProductRecipeMock).toHaveBeenCalledTimes(1))
    expect(putProductRecipeMock).toHaveBeenCalledWith(5, {
      version: 1,
      lines: [{ ingredient_id: 7, preparation_id: undefined, qty: "300", unit: "g" }],
    })

    await waitFor(() => expect(screen.getByText(/se guardó como versión 2/i)).toBeInTheDocument())
    expect(screen.getByText(/antes v1/i)).toBeInTheDocument()
  })

  it("costo null con origen «none» se dice «Sin costo», nunca $0, y avisa que el plato no descuenta nada", async () => {
    listProductsMock.mockResolvedValue(PRODUCTS)
    getProductRecipeMock.mockResolvedValue(
      recipe({ version: 0, theoretical_cost: null, cost_source: "none", food_cost_pct: null, lines: [] }),
    )

    const user = userEvent.setup()
    renderWithProviders(<RecipeEditor storeId={1} />)

    await user.click(await screen.findByRole("combobox", { name: "Plato" }))
    await user.click(await screen.findByRole("option", { name: "Bandeja paisa" }))

    await waitFor(() => expect(screen.getByText("Sin ficha todavía")).toBeInTheDocument())
    expect(screen.getByText("Sin costo")).toBeInTheDocument()
    expect(screen.queryByText("$ 0")).not.toBeInTheDocument()
    expect(screen.getByText("Food cost: sin datos")).toBeInTheDocument()
    expect(screen.getByText(/aparece en «Cobertura de recetas»/i)).toBeInTheDocument()

    // Sin ninguna línea completa, no se puede guardar (el backend exige al menos una).
    expect(screen.getByRole("button", { name: "Guardar ficha" })).toBeDisabled()
  })
})
