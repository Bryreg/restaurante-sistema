import { screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders } from "@/test/utils"

import { ControlHealthTab } from "../ControlHealthTab"

const { getControlHealthMock, getFoodCostMock } = vi.hoisted(() => ({
  getControlHealthMock: vi.fn(),
  getFoodCostMock: vi.fn(),
}))

vi.mock("@/api/inventory", async () => {
  const actual = await vi.importActual<typeof import("@/api/inventory")>("@/api/inventory")
  return { ...actual, getControlHealth: getControlHealthMock, getFoodCost: getFoodCostMock }
})

describe("ControlHealthTab — «sin datos» se dice, nunca 0 ni un guion mudo (SPEC-NEGOCIO §5.4)", () => {
  it("food cost real disponible: muestra el % y los cuatro totales", async () => {
    getControlHealthMock.mockResolvedValue({
      days_since_full_count: 3,
      last_full_count_at: "2026-09-12T10:00:00Z",
      inventory_unreliable: false,
      reception_invoice_ratio_bp: 8000,
      reception_invoice_ratio_reason: null,
      batch_preps_produced_ratio_bp: 5000,
      batch_preps_produced_reason: null,
      waste_entries_this_week: 4,
    })
    getFoodCostMock.mockResolvedValue({
      available: true,
      reason: null,
      opening_count_id: 5,
      closing_count_id: 6,
      window_from: "2026-09-01T09:00:00Z",
      window_to: "2026-09-14T09:00:00Z",
      opening_value: 500000,
      purchases_value: 200000,
      closing_value: 450000,
      net_sales: 1000000,
      pct_bp: 2500,
    })

    renderWithProviders(<ControlHealthTab storeId={1} />)

    await waitFor(() => expect(screen.getByText("25 %")).toBeInTheDocument())
    expect(screen.getByText(/conteos #5 y #6/)).toBeInTheDocument()
    expect(screen.getByText("$ 500.000")).toBeInTheDocument()
    expect(screen.getByText("3")).toBeInTheDocument()
  })

  it("food cost real NO disponible: dice el motivo, nunca 0 % ni un guion mudo", async () => {
    getControlHealthMock.mockResolvedValue({
      days_since_full_count: null,
      last_full_count_at: null,
      inventory_unreliable: true,
      reception_invoice_ratio_bp: null,
      reception_invoice_ratio_reason: "sin recepciones en el período",
      batch_preps_produced_ratio_bp: null,
      batch_preps_produced_reason: "no hay preparaciones activas en modo lote",
      waste_entries_this_week: 0,
    })
    getFoodCostMock.mockResolvedValue({
      available: false,
      reason: "Hacen falta dos conteos completos aplicados y consecutivos en el período para calcular el food cost real",
      opening_count_id: null,
      closing_count_id: null,
      window_from: null,
      window_to: null,
      opening_value: null,
      purchases_value: null,
      closing_value: null,
      net_sales: null,
      pct_bp: null,
    })

    renderWithProviders(<ControlHealthTab storeId={1} />)

    await waitFor(() => expect(screen.getByText(/Hacen falta dos conteos completos/)).toBeInTheDocument())
    expect(screen.queryByText("0 %")).not.toBeInTheDocument()

    expect(screen.getByText(/Inventario no confiable/)).toBeInTheDocument()
    // "Días desde el último conteo completo" nunca hubo uno -> "—", con motivo en el hint, no "0".
    expect(screen.getByText("Nunca hubo un conteo completo aplicado")).toBeInTheDocument()
    expect(screen.getByText("sin recepciones en el período")).toBeInTheDocument()
  })
})
