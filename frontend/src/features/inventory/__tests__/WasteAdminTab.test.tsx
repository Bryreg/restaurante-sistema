import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { IncomingTransferOut, IngredientOut } from "@/api/inventory"

import { renderWithProviders } from "@/test/utils"

import { WasteAdminTab } from "../WasteAdminTab"

const { getWasteListMock, getIncomingTransfersMock, receiveTransferMock } = vi.hoisted(() => ({
  getWasteListMock: vi.fn(),
  getIncomingTransfersMock: vi.fn().mockResolvedValue([]),
  receiveTransferMock: vi.fn(),
}))

vi.mock("@/api/employees", () => ({ listEmployees: vi.fn().mockResolvedValue([]) }))
vi.mock("@/api/recipes", () => ({ listPreparations: vi.fn().mockResolvedValue([]) }))
vi.mock("@/api/inventory", async () => {
  const actual = await vi.importActual<typeof import("@/api/inventory")>("@/api/inventory")
  return {
    ...actual,
    getWasteList: getWasteListMock,
    getIncomingTransfers: getIncomingTransfersMock,
    receiveTransfer: receiveTransferMock,
  }
})

describe("WasteAdminTab — el KPI mermas ÷ compras es entero en puntos básicos, no una fracción (deuda 2a → 2b cerrada)", () => {
  it("ratio=437 (puntos básicos) se pinta «4,4 %» con el formato único es-CO (científico #14), nunca «43700%» (Math.round(ratio*100) de 2a)", async () => {
    getWasteListMock.mockResolvedValue({ items: [], weekly_kpi: { ratio: 437, label: "4,37 % de las compras" } })

    renderWithProviders(<WasteAdminTab storeId={1} ingredients={[]} />)

    await waitFor(() => expect(screen.getByText(/^4,4\s%$/)).toBeInTheDocument())
    expect(screen.queryByText(/43700/)).not.toBeInTheDocument()
  })

  it("ratio=null se dice «Sin datos», nunca «0 %»", async () => {
    getWasteListMock.mockResolvedValue({
      items: [],
      weekly_kpi: { ratio: null, label: "Sin compras en el período para comparar" },
    })

    renderWithProviders(<WasteAdminTab storeId={1} ingredients={[]} />)

    await waitFor(() => expect(screen.getByText(/Sin datos/)).toBeInTheDocument())
    expect(screen.queryByText("0 %")).not.toBeInTheDocument()
    expect(screen.queryByText(/^0%$/)).not.toBeInTheDocument()
  })
})

describe("WasteAdminTab — salidas explicadas y traslados por recibir", () => {
  it("el consumo interno se marca «no es pérdida» y dice quién", async () => {
    getWasteListMock.mockResolvedValue({
      items: [
        {
          id: 1, ingredient_id: 3, preparation_id: null, qty: "2", type: "internal_use", employee_id: 1,
          employee_name: "Ana", at: "2026-09-24T20:00:00Z", consumer_employee_id: null, consumer_name: "Dueño",
          destination_store_id: null, cost: "10", cost_source: "official", note: null, photo: null,
          received_at: null, received_by_employee_name: null,
        },
      ],
      weekly_kpi: { ratio: null, label: "sin datos" },
    })
    renderWithProviders(<WasteAdminTab storeId={1} ingredients={[]} />)
    expect(await screen.findByText("(no es pérdida)")).toBeInTheDocument()
    expect(screen.getByText("Dueño")).toBeInTheDocument()
  })

  it("un traslado por recibir se recibe en el insumo que sugiere el servidor", async () => {
    getWasteListMock.mockResolvedValue({ items: [], weekly_kpi: { ratio: null, label: "sin datos" } })
    const transfer: IncomingTransferOut = {
      id: 12, source_store_id: 2, source_store_name: "Sede Centro", ingredient_id: 3, ingredient_name: "Queso",
      base_unit: "g", qty: "3000", cost: "12", cost_source: "official", sent_at: "2026-09-24T20:00:00Z",
      sent_by_employee_name: "Ana", note: null, photo: null, suggested_ingredient_id: 30, received_at: null,
      received_ingredient_id: null, received_by_employee_name: null,
    }
    getIncomingTransfersMock.mockResolvedValue([transfer])
    receiveTransferMock.mockResolvedValue({ ...transfer, received_at: "2026-09-25T10:00:00Z" })
    const ingredients = [
      { id: 30, name: "Queso campesino", base_unit: "g", active: true },
      { id: 31, name: "Huevos", base_unit: "unit", active: true },
    ] as unknown as IngredientOut[]
    const user = userEvent.setup()
    renderWithProviders(<WasteAdminTab storeId={5} ingredients={ingredients} />)

    expect(await screen.findByRole("heading", { name: "Traslados por recibir (1)" })).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Recibir traslado" }))
    await waitFor(() => expect(receiveTransferMock).toHaveBeenCalledTimes(1))
    expect(receiveTransferMock.mock.calls[0]!.slice(0, 3)).toEqual([5, 12, 30])
  })
})
