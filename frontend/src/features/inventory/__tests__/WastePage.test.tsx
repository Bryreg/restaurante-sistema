import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { ApiError } from "@/api/client"
import { buildMe, renderWithProviders } from "@/test/utils"

import { WastePage } from "../WastePage"

const { listDeviceIngredientsMock, postWasteMock, listDevicePreparationsMock } = vi.hoisted(() => ({
  listDeviceIngredientsMock: vi.fn(),
  postWasteMock: vi.fn(),
  listDevicePreparationsMock: vi.fn().mockResolvedValue([]),
}))

vi.mock("@/api/inventory", async () => {
  const actual = await vi.importActual<typeof import("@/api/inventory")>("@/api/inventory")
  return { ...actual, listDeviceIngredients: listDeviceIngredientsMock, postWaste: postWasteMock }
})

vi.mock("@/api/recipes", async () => {
  const actual = await vi.importActual<typeof import("@/api/recipes")>("@/api/recipes")
  return { ...actual, listDevicePreparations: listDevicePreparationsMock }
})

function deviceMe(features: Record<string, boolean>) {
  return buildMe({ kind: "device", features })
}

describe("WastePage — dispositivo, sin costos (AGENTS.md)", () => {
  it("sin inventory.waste explica qué la prende, no una pantalla rota", () => {
    renderWithProviders(<WastePage />, { me: deviceMe({ "inventory.waste": false }) })
    expect(screen.getByText(/registro de mermas no está habilitado/i)).toBeInTheDocument()
    expect(listDeviceIngredientsMock).not.toHaveBeenCalled()
  })

  it('el selector de tipo NO incluye "consumo de personal" — eso es una comanda staff_meal, nunca una merma', async () => {
    listDeviceIngredientsMock.mockResolvedValue([{ id: 1, name: "Papa criolla", base_unit: "g" }])
    const user = userEvent.setup()
    renderWithProviders(<WastePage />, { me: deviceMe({ "inventory.waste": true }) })

    const typeCombobox = await screen.findByRole("combobox", { name: "Tipo" })
    await user.click(typeCombobox)

    const options = screen.getAllByRole("option").map((o) => o.textContent)
    expect(options.some((label) => /personal/i.test(label ?? ""))).toBe(false)
    expect(options).toEqual(
      expect.arrayContaining(["Vencido", "Sobreproducción", "Error de cocina", "Rotura", "Devolución de cliente", "Degustación", "Cortesía sin plato", "Sin identificar"]),
    )
  })

  it("nunca muestra un costo o margen en ningún texto de la pantalla", async () => {
    listDeviceIngredientsMock.mockResolvedValue([{ id: 1, name: "Papa criolla", base_unit: "g" }])
    renderWithProviders(<WastePage />, { me: deviceMe({ "inventory.waste": true }) })

    await screen.findByRole("combobox", { name: "Insumo" })
    expect(screen.queryByText(/costo/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/margen/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument()
  })

  it("un 409 (misma clave en vuelo) NO rota la Idempotency-Key; cualquier otro error sí", async () => {
    listDeviceIngredientsMock.mockResolvedValue([{ id: 1, name: "Papa criolla", base_unit: "g" }])
    postWasteMock
      .mockRejectedValueOnce(new ApiError(409, "IDEMPOTENCY_IN_PROGRESS", "Ya hay una merma en curso con esta clave"))
      .mockResolvedValueOnce({ id: 1, ingredient_id: 1, preparation_id: null, qty: "500", type: "expired", employee_id: 1, employee_name: "Ana", at: "2026-09-15T10:00:00Z" })

    const user = userEvent.setup()
    renderWithProviders(<WastePage />, { me: deviceMe({ "inventory.waste": true }) })

    const ingredientCombobox = await screen.findByRole("combobox", { name: "Insumo" })
    await user.click(ingredientCombobox)
    await user.click(await screen.findByRole("option", { name: "Papa criolla" }))
    await user.type(screen.getByLabelText("Cantidad"), "500")
    await user.click(screen.getByRole("combobox", { name: "Tipo" }))
    await user.click(await screen.findByRole("option", { name: "Vencido" }))

    await user.click(screen.getByRole("button", { name: "Dígito 1" }))
    await user.click(screen.getByRole("button", { name: "Dígito 2" }))
    await user.click(screen.getByRole("button", { name: "Dígito 3" }))
    await user.click(screen.getByRole("button", { name: "Dígito 4" }))

    await waitFor(() => expect(postWasteMock).toHaveBeenCalledTimes(1))
    const firstKey = postWasteMock.mock.calls[0]![1]

    await user.click(screen.getByRole("button", { name: "Dígito 1" }))
    await user.click(screen.getByRole("button", { name: "Dígito 2" }))
    await user.click(screen.getByRole("button", { name: "Dígito 3" }))
    await user.click(screen.getByRole("button", { name: "Dígito 4" }))

    await waitFor(() => expect(postWasteMock).toHaveBeenCalledTimes(2))
    const secondKey = postWasteMock.mock.calls[1]![1]
    // Mismo intento (409 en vuelo): la clave se mantuvo.
    expect(secondKey).toBe(firstKey)
  })
})
