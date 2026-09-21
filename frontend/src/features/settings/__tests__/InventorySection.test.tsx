import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { buildMe, renderWithProviders } from "@/test/utils"
import type { IngredientOut } from "@/api/inventory"

import { InventorySection } from "../InventorySection"

const { getInventorySettingsMock, putInventorySettingsMock, listIngredientsMock, updateIngredientMock } = vi.hoisted(() => ({
  getInventorySettingsMock: vi.fn(),
  putInventorySettingsMock: vi.fn(),
  listIngredientsMock: vi.fn(),
  updateIngredientMock: vi.fn(),
}))

vi.mock("@/api/inventory", async () => {
  const actual = await vi.importActual<typeof import("@/api/inventory")>("@/api/inventory")
  return {
    ...actual,
    getInventorySettings: getInventorySettingsMock,
    putInventorySettings: putInventorySettingsMock,
    listIngredients: listIngredientsMock,
    updateIngredient: updateIngredientMock,
  }
})

const PECHUGA: IngredientOut = {
  id: 1,
  name: "Pechuga de pollo",
  category: null,
  base_unit: "g",
  purchase_unit: "kg",
  purchase_factor: 1000,
  yield_pct: 85,
  official_cost: "14000",
  estimated_cost: null,
  cost: "14000",
  cost_source: "official",
  min_stock: "3000",
  lead_time_days: null,
  perishable: true,
  key_item: true,
  consumption_untracked: false,
  substitute_ingredient_id: null,
  supplier_id: null,
  active: true,
}

const SAL: IngredientOut = { ...PECHUGA, id: 2, name: "Sal de mesa", key_item: false, official_cost: "3", cost: "3" }

const ENABLED_ME = buildMe({ features: { "inventory.perpetual": true, "inventory.variance": true } })

describe("InventorySection — umbrales de varianza e insumos críticos (huérfano de §9.3, dueño desde el arranque)", () => {
  it("carga los umbrales guardados como porcentaje y los defaults de industria se muestran como tales", async () => {
    getInventorySettingsMock.mockResolvedValue({ store_id: 1, variance_yellow_threshold_bp: 200, variance_red_threshold_bp: 400 })
    listIngredientsMock.mockResolvedValue([PECHUGA, SAL])

    renderWithProviders(<InventorySection storeId={1} />, { me: ENABLED_ME })

    await waitFor(() => expect(screen.getByLabelText(/Umbral amarillo/)).toHaveValue("2"))
    expect(screen.getByLabelText(/Umbral rojo/)).toHaveValue("4")
    expect(screen.getByText("Default de industria: 2 %.")).toBeInTheDocument()
    expect(screen.getByText("Default de industria: 4 %.")).toBeInTheDocument()
  })

  it("guarda el umbral escrito como porcentaje, convertido a puntos básicos reales (100 = 1 %)", async () => {
    getInventorySettingsMock.mockResolvedValue({ store_id: 1, variance_yellow_threshold_bp: 200, variance_red_threshold_bp: 400 })
    listIngredientsMock.mockResolvedValue([])
    putInventorySettingsMock.mockResolvedValue({ store_id: 1, variance_yellow_threshold_bp: 250, variance_red_threshold_bp: 500 })

    const user = userEvent.setup()
    renderWithProviders(<InventorySection storeId={1} />, { me: ENABLED_ME })

    await waitFor(() => expect(screen.getByLabelText(/Umbral amarillo/)).toHaveValue("2"))

    const yellow = screen.getByLabelText(/Umbral amarillo/)
    await user.clear(yellow)
    await user.type(yellow, "2,5")
    const red = screen.getByLabelText(/Umbral rojo/)
    await user.clear(red)
    await user.type(red, "5")

    await user.click(screen.getByRole("button", { name: "Guardar umbrales" }))

    await waitFor(() =>
      expect(putInventorySettingsMock).toHaveBeenCalledWith(1, {
        variance_yellow_threshold_bp: 250,
        variance_red_threshold_bp: 500,
      }),
    )
  })

  it("no deja guardar si el rojo no es mayor que el amarillo", async () => {
    getInventorySettingsMock.mockResolvedValue({ store_id: 1, variance_yellow_threshold_bp: 200, variance_red_threshold_bp: 400 })
    listIngredientsMock.mockResolvedValue([])

    const user = userEvent.setup()
    renderWithProviders(<InventorySection storeId={1} />, { me: ENABLED_ME })

    await waitFor(() => expect(screen.getByLabelText(/Umbral amarillo/)).toHaveValue("2"))

    const red = screen.getByLabelText(/Umbral rojo/)
    await user.clear(red)
    await user.type(red, "1")

    expect(screen.getByRole("button", { name: "Guardar umbrales" })).toBeDisabled()
    expect(putInventorySettingsMock).not.toHaveBeenCalled()
  })

  it("lista TODOS los insumos activos con su casilla de crítico, y togglear uno manda key_item al backend", async () => {
    getInventorySettingsMock.mockResolvedValue({ store_id: 1, variance_yellow_threshold_bp: 200, variance_red_threshold_bp: 400 })
    listIngredientsMock.mockResolvedValue([PECHUGA, SAL])
    updateIngredientMock.mockResolvedValue({ ...SAL, key_item: true })

    const user = userEvent.setup()
    renderWithProviders(<InventorySection storeId={1} />, { me: ENABLED_ME })

    await waitFor(() => expect(screen.getByText("Pechuga de pollo")).toBeInTheDocument())
    expect(screen.getByText("1 de 2 marcados como críticos.")).toBeInTheDocument()

    const salCheckbox = screen.getByRole("checkbox", { name: "Sal de mesa" })
    expect(salCheckbox).not.toBeChecked()
    await user.click(salCheckbox)

    await waitFor(() => expect(updateIngredientMock).toHaveBeenCalledWith(2, { key_item: true }))
  })

  it("con inventory.variance apagada, explica qué la prende en vez de romper — pero insumos críticos sigue disponible (depende de perpetual, no de variance)", async () => {
    listIngredientsMock.mockResolvedValue([PECHUGA])
    renderWithProviders(<InventorySection storeId={1} />, {
      me: buildMe({ features: { "inventory.perpetual": true, "inventory.variance": false } }),
    })

    // El vacío por función apagada ahora nombra la función completa y su
    // clave, y ofrece el camino para encenderla (patrón 13, motivo «función
    // apagada»): el rótulo cambió a propósito en la ola 2 del rediseño.
    expect(screen.getByText(/no está encendida/)).toBeInTheDocument()
    expect(screen.getByText(/inventory\.variance/)).toBeInTheDocument()
    expect(getInventorySettingsMock).not.toHaveBeenCalled()

    await waitFor(() => expect(screen.getByText("Pechuga de pollo")).toBeInTheDocument())
  })
})
