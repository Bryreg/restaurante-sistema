import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { ModifierGroupOut, ProductAdminOut } from "@/api/catalog"
import { renderWithProviders } from "@/test/utils"

import { ModifiersTab } from "./ModifiersTab"

const { PRODUCTS, GROUPS } = vi.hoisted(() => ({
  PRODUCTS: [
    {
      id: 1, category_id: 1, name: "Bandeja paisa", description: null, station: null, default_course: null,
      prices: { dine_in: 38_000, takeout: null, delivery: null, platform: null }, tax_code: "inc_8" as const,
      active: true, available: true,
    },
  ] satisfies ProductAdminOut[],
  GROUPS: [
    {
      id: 10, product_id: 1, name: "Término de la carne", required: true, min: 1, max: 1, sort_order: 0,
      options: [{ id: 101, name: "Término medio", price_delta: 0, available: true }],
    },
  ] satisfies ModifierGroupOut[],
}))

vi.mock("@/api/catalog", async () => {
  const actual = await vi.importActual<typeof import("@/api/catalog")>("@/api/catalog")
  return {
    ...actual,
    listProducts: vi.fn().mockResolvedValue(PRODUCTS),
    listModifierGroups: vi.fn().mockResolvedValue(GROUPS),
  }
})

vi.mock("@/api/recipes", async () => {
  const actual = await vi.importActual<typeof import("@/api/recipes")>("@/api/recipes")
  return {
    ...actual,
    listIngredientOptions: vi.fn().mockResolvedValue([]),
    listPreparations: vi.fn().mockResolvedValue([]),
    getProductRecipe: vi.fn().mockResolvedValue({
      product_id: 1, version: 0, theoretical_cost: null, cost_source: "none", food_cost_pct: null,
      net_price: 38_000, lines: [],
    }),
  }
})

async function selectProduct() {
  const user = userEvent.setup()
  await user.click(await screen.findByRole("combobox", { name: "Producto" }))
  await user.click(await screen.findByRole("option", { name: "Bandeja paisa" }))
  return user
}

describe("ModifiersTab — recipe_effect", () => {
  it("sin catalog.recipes no ofrece «Efecto en receta»: recipe_effect queda null como en 1b", async () => {
    renderWithProviders(<ModifiersTab storeId={1} />, { me: { kind: "admin", features: { "catalog.recipes": false } } })
    await selectProduct()

    await waitFor(() => expect(screen.getByText("Término de la carne")).toBeInTheDocument())
    expect(screen.queryByRole("button", { name: "Efecto en receta" })).not.toBeInTheDocument()
  })

  it("con catalog.recipes ofrece «Efecto en receta» por opción", async () => {
    renderWithProviders(<ModifiersTab storeId={1} />, { me: { kind: "admin", features: { "catalog.recipes": true } } })
    await selectProduct()

    expect(await screen.findByRole("button", { name: "Efecto en receta" })).toBeInTheDocument()
  })
})
