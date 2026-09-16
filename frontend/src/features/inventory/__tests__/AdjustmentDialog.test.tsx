import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { ApiError } from "@/api/client"
import type { IngredientOut } from "@/api/inventory"

import { AdjustmentDialog } from "../AdjustmentDialog"

const { postInventoryAdjustmentMock } = vi.hoisted(() => ({ postInventoryAdjustmentMock: vi.fn() }))

vi.mock("@/api/inventory", async () => {
  const actual = await vi.importActual<typeof import("@/api/inventory")>("@/api/inventory")
  return { ...actual, postInventoryAdjustment: postInventoryAdjustmentMock }
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

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <AdjustmentDialog storeId={1} ingredients={[PAPA]} />
    </QueryClientProvider>,
  )
}

describe("AdjustmentDialog — ajuste manual con PIN de administrador e Idempotency-Key", () => {
  it("manda ingredient_id, qty_delta y reason con store_id, y la clave se renueva tras un error que no es 409", async () => {
    postInventoryAdjustmentMock.mockRejectedValueOnce(new ApiError(400, "AUTHORIZATION_INVALID", "PIN de administrador incorrecto"))

    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByRole("button", { name: "Ajuste manual" }))
    await screen.findByRole("dialog")

    await user.click(screen.getByRole("combobox", { name: "Insumo" }))
    await user.click(await screen.findByRole("option", { name: "Papa criolla" }))
    await user.type(screen.getByLabelText("Cantidad (con signo)"), "-500")
    await user.type(screen.getByLabelText("Motivo"), "Se dañó en cámara fría")

    await user.click(screen.getByRole("button", { name: "Dígito 9" }))
    await user.click(screen.getByRole("button", { name: "Dígito 0" }))
    await user.click(screen.getByRole("button", { name: "Dígito 0" }))
    await user.click(screen.getByRole("button", { name: "Dígito 0" }))

    await waitFor(() => expect(postInventoryAdjustmentMock).toHaveBeenCalledTimes(1))
    const [storeId, body, firstKey] = postInventoryAdjustmentMock.mock.calls[0]!
    expect(storeId).toBe(1)
    expect(body).toEqual({ ingredient_id: 7, qty_delta: "-500", reason: "Se dañó en cámara fría", authorizer_pin: "9000" })
    expect(typeof firstKey).toBe("string")

    await screen.findByRole("alert")

    postInventoryAdjustmentMock.mockResolvedValueOnce({
      id: 1, ingredient_id: 7, qty_delta: "-500", reason: "Se dañó en cámara fría", employee_id: 1, employee_name: "Admin", at: "2026-09-15T10:00:00Z",
    })
    await user.click(screen.getByRole("button", { name: "Dígito 9" }))
    await user.click(screen.getByRole("button", { name: "Dígito 0" }))
    await user.click(screen.getByRole("button", { name: "Dígito 0" }))
    await user.click(screen.getByRole("button", { name: "Dígito 0" }))

    await waitFor(() => expect(postInventoryAdjustmentMock).toHaveBeenCalledTimes(2))
    const secondKey = postInventoryAdjustmentMock.mock.calls[1]![2]
    expect(secondKey).not.toBe(firstKey)
  })
})
