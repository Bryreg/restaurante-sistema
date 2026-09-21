import { screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders } from "@/test/utils"

import { WasteAdminTab } from "../WasteAdminTab"

const { getWasteListMock } = vi.hoisted(() => ({ getWasteListMock: vi.fn() }))

vi.mock("@/api/employees", () => ({ listEmployees: vi.fn().mockResolvedValue([]) }))
vi.mock("@/api/recipes", () => ({ listPreparations: vi.fn().mockResolvedValue([]) }))
vi.mock("@/api/inventory", async () => {
  const actual = await vi.importActual<typeof import("@/api/inventory")>("@/api/inventory")
  return { ...actual, getWasteList: getWasteListMock }
})

describe("WasteAdminTab — el KPI mermas ÷ compras es entero en puntos básicos, no una fracción (deuda 2a → 2b cerrada)", () => {
  it("ratio=437 (puntos básicos) se pinta «4,37 %», nunca «43700%» (Math.round(ratio*100) de 2a)", async () => {
    getWasteListMock.mockResolvedValue({ items: [], weekly_kpi: { ratio: 437, label: "4,37 % de las compras" } })

    renderWithProviders(<WasteAdminTab storeId={1} ingredients={[]} />)

    await waitFor(() => expect(screen.getByText("4,37 %")).toBeInTheDocument())
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
