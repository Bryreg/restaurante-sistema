import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders } from "@/test/utils"

import { RecipeEffectDialog } from "./RecipeEffectDialog"

const { getProductRecipeMock, listIngredientOptionsMock, listPreparationsMock, putModifierOptionRecipeEffectMock } =
  vi.hoisted(() => ({
    getProductRecipeMock: vi.fn(),
    listIngredientOptionsMock: vi.fn(),
    listPreparationsMock: vi.fn().mockResolvedValue([]),
    putModifierOptionRecipeEffectMock: vi.fn(),
  }))

vi.mock("@/api/recipes", async () => {
  const actual = await vi.importActual<typeof import("@/api/recipes")>("@/api/recipes")
  return {
    ...actual,
    getProductRecipe: getProductRecipeMock,
    listIngredientOptions: listIngredientOptionsMock,
    listPreparations: listPreparationsMock,
    putModifierOptionRecipeEffect: putModifierOptionRecipeEffectMock,
  }
})

describe("RecipeEffectDialog", () => {
  it("effect=«add» manda las líneas sin replaces_*", async () => {
    getProductRecipeMock.mockResolvedValue({
      product_id: 5, version: 1, theoretical_cost: 1000, cost_source: "official", food_cost_pct: "20",
      net_price: 5000, lines: [],
    })
    listIngredientOptionsMock.mockResolvedValue([{ id: 3, name: "Queso extra", base_unit: "g" }])
    putModifierOptionRecipeEffectMock.mockResolvedValue({
      modifier_option_id: 9, effect: "add",
      lines: [{ ingredient_id: 3, ingredient_name: "Queso extra", preparation_id: null, preparation_name: null, qty: "30", unit: "g" }],
    })

    const user = userEvent.setup()
    renderWithProviders(<RecipeEffectDialog optionId={9} optionName="Extra queso" productId={5} storeId={1} />)

    await user.click(screen.getByRole("button", { name: "Efecto en receta" }))
    await user.click(await screen.findByRole("combobox", { name: /componente/i }))
    await user.click(await screen.findByRole("option", { name: "Queso extra (insumo)" }))
    await user.type(screen.getByLabelText("Cantidad"), "30")

    await user.click(screen.getByRole("button", { name: "Guardar efecto" }))

    await waitFor(() => expect(putModifierOptionRecipeEffectMock).toHaveBeenCalledTimes(1))
    expect(putModifierOptionRecipeEffectMock).toHaveBeenCalledWith(9, {
      effect: "add",
      lines: [
        {
          ingredient_id: 3,
          preparation_id: undefined,
          qty: "30",
          unit: "g",
          replaces_ingredient_id: undefined,
          replaces_preparation_id: undefined,
        },
      ],
    })
  })

  it("effect=«replace» exige elegir qué línea de la ficha base reemplaza antes de dejar guardar", async () => {
    getProductRecipeMock.mockResolvedValue({
      product_id: 5, version: 1, theoretical_cost: 1000, cost_source: "official", food_cost_pct: "20",
      net_price: 5000,
      lines: [{ ingredient_id: 2, ingredient_name: "Leche entera", preparation_id: null, preparation_name: null, qty: "200", unit: "ml" }],
    })
    listIngredientOptionsMock.mockResolvedValue([
      { id: 2, name: "Leche entera", base_unit: "ml" },
      { id: 4, name: "Leche deslactosada", base_unit: "ml" },
    ])

    const user = userEvent.setup()
    renderWithProviders(<RecipeEffectDialog optionId={9} optionName="Sin lactosa" productId={5} storeId={1} />)

    await user.click(screen.getByRole("button", { name: "Efecto en receta" }))
    await user.click(await screen.findByRole("combobox", { name: "Tipo de efecto" }))
    await user.click(await screen.findByRole("option", { name: "Reemplaza" }))

    await user.click(screen.getByRole("combobox", { name: /componente/i }))
    await user.click(await screen.findByRole("option", { name: "Leche deslactosada (insumo)" }))
    await user.type(screen.getByLabelText("Cantidad"), "200")
    await user.click(screen.getByRole("combobox", { name: "Unidad" }))
    await user.click(await screen.findByRole("option", { name: "ml" }))

    // Sin elegir qué reemplaza todavía, no se puede guardar.
    expect(screen.getByRole("button", { name: "Guardar efecto" })).toBeDisabled()

    await user.click(screen.getByRole("combobox", { name: "Reemplaza, en la ficha base" }))
    await user.click(await screen.findByRole("option", { name: "Leche entera" }))

    expect(screen.getByRole("button", { name: "Guardar efecto" })).not.toBeDisabled()
    await user.click(screen.getByRole("button", { name: "Guardar efecto" }))

    await waitFor(() => expect(putModifierOptionRecipeEffectMock).toHaveBeenCalledTimes(1))
    expect(putModifierOptionRecipeEffectMock).toHaveBeenCalledWith(9, {
      effect: "replace",
      lines: [
        {
          ingredient_id: 4,
          preparation_id: undefined,
          qty: "200",
          unit: "ml",
          replaces_ingredient_id: 2,
          replaces_preparation_id: undefined,
        },
      ],
    })
  })

  it("abre siempre en blanco (gap declarado: no hay GET de recipe_effect) y por defecto guarda como «add»", async () => {
    getProductRecipeMock.mockResolvedValue({
      product_id: 5, version: 1, theoretical_cost: null, cost_source: "none", food_cost_pct: null,
      net_price: 5000, lines: [],
    })
    listIngredientOptionsMock.mockResolvedValue([{ id: 6, name: "Tocineta", base_unit: "g" }])
    putModifierOptionRecipeEffectMock.mockResolvedValue({
      modifier_option_id: 9, effect: "add",
      lines: [{ ingredient_id: 6, ingredient_name: "Tocineta", preparation_id: null, preparation_name: null, qty: "20", unit: "g" }],
    })

    const user = userEvent.setup()
    renderWithProviders(<RecipeEffectDialog optionId={9} optionName="Punto de la carne" productId={5} storeId={1} />)

    await user.click(screen.getByRole("button", { name: "Efecto en receta" }))
    expect(screen.queryByText(/guardado:/i)).not.toBeInTheDocument()

    // Sin tocar el selector de "Tipo de efecto", el default es "add".
    await user.click(await screen.findByRole("combobox", { name: /componente/i }))
    await user.click(await screen.findByRole("option", { name: "Tocineta (insumo)" }))
    await user.type(screen.getByLabelText("Cantidad"), "20")
    await user.click(screen.getByRole("button", { name: "Guardar efecto" }))

    await waitFor(() => expect(putModifierOptionRecipeEffectMock).toHaveBeenCalledTimes(1))
    expect(putModifierOptionRecipeEffectMock.mock.calls[0]![1].effect).toBe("add")
  })
})
