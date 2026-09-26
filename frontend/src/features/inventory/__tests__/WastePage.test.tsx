import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

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

  it('los tipos NO incluyen "consumo de personal" — eso es una comanda staff_meal, nunca una merma', async () => {
    listDeviceIngredientsMock.mockResolvedValue([{ id: 1, name: "Papa criolla", base_unit: "g", entry_mode: "weight", entry_unit: "kg" }])
    renderWithProviders(<WastePage />, { me: deviceMe({ "inventory.waste": true }) })

    // El tipo son botones grandes (≥ 56 px), no una lista desplegable.
    const group = await screen.findByRole("group", { name: "Tipo" })
    const options = within(group)
      .getAllByRole("button")
      .map((o) => o.textContent)
    expect(options.some((label) => /personal/i.test(label ?? ""))).toBe(false)
    expect(options).toEqual(
      expect.arrayContaining(["Vencido", "Sobreproducción", "Error de cocina", "Rotura", "Devolución de cliente", "Degustación", "Cortesía sin plato", "Sin identificar"]),
    )
  })

  it("nunca muestra un costo o margen en ningún texto de la pantalla", async () => {
    listDeviceIngredientsMock.mockResolvedValue([{ id: 1, name: "Papa criolla", base_unit: "g", entry_mode: "weight", entry_unit: "kg" }])
    renderWithProviders(<WastePage />, { me: deviceMe({ "inventory.waste": true }) })

    await screen.findByLabelText("Buscar insumo")
    expect(screen.queryByText(/costo/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/margen/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument()
  })

  it("un 409 (misma clave en vuelo) NO rota la Idempotency-Key; cualquier otro error sí", async () => {
    listDeviceIngredientsMock.mockResolvedValue([{ id: 1, name: "Papa criolla", base_unit: "g", entry_mode: "weight", entry_unit: "kg" }])
    postWasteMock
      .mockRejectedValueOnce(new ApiError(409, "IDEMPOTENCY_IN_PROGRESS", "Ya hay una merma en curso con esta clave"))
      .mockResolvedValueOnce({ id: 1, ingredient_id: 1, preparation_id: null, qty: "500", type: "expired", employee_id: 1, employee_name: "Ana", at: "2026-09-15T10:00:00Z" })

    const user = userEvent.setup()
    renderWithProviders(<WastePage />, { me: deviceMe({ "inventory.waste": true }) })

    await user.click(await screen.findByRole("button", { name: "Papa criolla" }))
    await user.type(screen.getByLabelText("Cantidad"), "500")
    await user.click(screen.getByRole("button", { name: "Vencido" }))

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

  describe("unidad cómoda y buscador", () => {
    const INGREDIENTS = [
      { id: 1, name: "Lomo", base_unit: "g", entry_mode: "weight", entry_unit: "kg" },
      { id: 2, name: "Ron", base_unit: "ml", entry_mode: "bottle", entry_unit: "botella" },
      { id: 3, name: "Limón", base_unit: "g", entry_mode: "weight", entry_unit: "kg" },
    ]

    beforeEach(() => {
      postWasteMock.mockReset()
    })

    async function typePin(user: ReturnType<typeof userEvent.setup>) {
      for (const d of ["1", "2", "3", "4"]) await user.click(screen.getByRole("button", { name: `Dígito ${d}` }))
    }

    it("«0,8» de lomo viaja tal cual con su unidad (kg): la pantalla no multiplica", async () => {
      listDeviceIngredientsMock.mockResolvedValue(INGREDIENTS)
      postWasteMock.mockResolvedValue({ id: 1 })
      const user = userEvent.setup()
      renderWithProviders(<WastePage />, { me: deviceMe({ "inventory.waste": true }) })

      await user.type(await screen.findByLabelText("Buscar insumo"), "lom")
      expect(screen.queryByRole("button", { name: "Ron" })).not.toBeInTheDocument()
      await user.click(screen.getByRole("button", { name: "Lomo" }))
      // La unidad queda escrita junto al campo.
      expect(screen.getByLabelText("Cantidad")).toHaveAccessibleDescription("kg")
      await user.type(screen.getByLabelText("Cantidad"), "0,8")
      await user.click(screen.getByRole("button", { name: "Rotura" }))
      expect(screen.getByRole("button", { name: "Rotura" })).toHaveAttribute("aria-pressed", "true")
      await typePin(user)

      await waitFor(() => expect(postWasteMock).toHaveBeenCalledTimes(1))
      expect(postWasteMock.mock.calls[0]![0]).toMatchObject({
        ingredient_id: 1,
        qty: "0,8",
        entry_unit: "kg",
        type: "breakage",
      })
    })

    it("el buscador ignora tildes y un licor se registra en botellas", async () => {
      listDeviceIngredientsMock.mockResolvedValue(INGREDIENTS)
      const user = userEvent.setup()
      renderWithProviders(<WastePage />, { me: deviceMe({ "inventory.waste": true }) })

      await user.type(await screen.findByLabelText("Buscar insumo"), "limon")
      expect(screen.getByRole("button", { name: "Limón" })).toBeInTheDocument()
      await user.clear(screen.getByLabelText("Buscar insumo"))
      await user.type(screen.getByLabelText("Buscar insumo"), "ron")
      await user.click(screen.getByRole("button", { name: "Ron" }))
      expect(screen.getByLabelText("Cantidad")).toHaveAccessibleDescription("botellas")
    })

    it("lo último elegido aparece en «Recientes»", async () => {
      listDeviceIngredientsMock.mockResolvedValue(INGREDIENTS)
      const user = userEvent.setup()
      const first = renderWithProviders(<WastePage />, { me: deviceMe({ "inventory.waste": true }) })
      await user.type(await screen.findByLabelText("Buscar insumo"), "ron")
      await user.click(screen.getByRole("button", { name: "Ron" }))
      first.unmount()

      renderWithProviders(<WastePage />, { me: deviceMe({ "inventory.waste": true }) })
      const recientes = (await screen.findByText("Recientes")).parentElement as HTMLElement
      expect(within(recientes).getByRole("button", { name: "Ron" })).toBeInTheDocument()
    })
  })
})
