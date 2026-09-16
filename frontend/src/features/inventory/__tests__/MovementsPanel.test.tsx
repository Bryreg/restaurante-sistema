import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { IngredientOut } from "@/api/inventory"

import { MovementsPanel } from "../MovementsPanel"

const { getIngredientMovementsMock } = vi.hoisted(() => ({ getIngredientMovementsMock: vi.fn() }))

vi.mock("@/api/inventory", async () => {
  const actual = await vi.importActual<typeof import("@/api/inventory")>("@/api/inventory")
  return { ...actual, getIngredientMovements: getIngredientMovementsMock }
})

const PAPA: IngredientOut = {
  id: 7,
  name: "Papa criolla",
  category: null,
  base_unit: "g",
  purchase_unit: "bulto",
  purchase_factor: 25000,
  yield_pct: 100,
  official_cost: null,
  estimated_cost: null,
  cost: null,
  cost_source: "none",
  min_stock: "1000",
  lead_time_days: null,
  perishable: false,
  key_item: false,
  consumption_untracked: false,
  substitute_ingredient_id: null,
  supplier_id: null,
  active: true,
}

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MovementsPanel ingredients={[PAPA]} />
    </QueryClientProvider>,
  )
}

describe("MovementsPanel — la causa es un enum cerrado, nunca texto libre", () => {
  it("el filtro de causa es una lista desplegable con las 11 causas del backend, sin campo de texto", async () => {
    getIngredientMovementsMock.mockResolvedValue([])
    const user = userEvent.setup()
    renderPanel()

    await waitFor(() => expect(getIngredientMovementsMock).toHaveBeenCalled())
    await user.click(screen.getByRole("combobox", { name: "Causa" }))

    const options = screen.getAllByRole("option").map((o) => o.textContent)
    expect(options).toEqual(
      expect.arrayContaining(["Todas", "Venta", "Entrada por producción", "Salida por producción", "Anulación tras envío", "Merma", "Nota — vuelve", "Ajuste manual"]),
    )
    // Nunca un <input type="text"> libre para la causa.
    expect(screen.queryByPlaceholderText(/causa/i)).not.toBeInTheDocument()
  })

  it("elegir una causa manda exactamente esa causa a la API, no un texto derivado", async () => {
    getIngredientMovementsMock.mockResolvedValue([])
    const user = userEvent.setup()
    renderPanel()

    await waitFor(() => expect(getIngredientMovementsMock).toHaveBeenCalled())
    await user.click(screen.getByRole("combobox", { name: "Causa" }))
    await user.click(screen.getByRole("option", { name: "Merma" }))

    await waitFor(() =>
      expect(getIngredientMovementsMock).toHaveBeenLastCalledWith(expect.objectContaining({ ingredientId: 7, cause: "waste" })),
    )
  })
})
