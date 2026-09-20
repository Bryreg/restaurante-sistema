import { screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { BreakEvenOut } from "@/api/expenses"
import { renderWithProviders } from "@/test/utils"

import { BreakEvenTab } from "../BreakEvenTab"

const { getBreakEvenMock } = vi.hoisted(() => ({ getBreakEvenMock: vi.fn() }))

vi.mock("@/api/expenses", async () => {
  const actual = await vi.importActual<typeof import("@/api/expenses")>("@/api/expenses")
  return { ...actual, getBreakEven: getBreakEvenMock }
})

describe("BreakEvenTab — sin costos fijos, null con motivo, nunca $0 (checklist de la fase)", () => {
  it("sin costos fijos cargados muestra el motivo, no una cifra en cero", async () => {
    const unavailable: BreakEvenOut = {
      fixed_costs: null,
      contribution_margin_pct_bp: null,
      break_even_amount: null,
      available: false,
      reason: "Cargá los costos fijos del período en Gastos para poder calcularlo.",
    }
    getBreakEvenMock.mockResolvedValue(unavailable)
    renderWithProviders(<BreakEvenTab storeId={1} />)

    expect(await screen.findByText("Punto de equilibrio no disponible")).toBeInTheDocument()
    expect(screen.getByText("Cargá los costos fijos del período en Gastos para poder calcularlo.")).toBeInTheDocument()
    expect(screen.queryByText(/\$\s*0\b/)).not.toBeInTheDocument()
  })

  it("con datos disponibles pinta las tres cifras tal como llegan del servidor", async () => {
    const available: BreakEvenOut = {
      fixed_costs: 5_000_000,
      contribution_margin_pct_bp: 6000,
      break_even_amount: 8_333_333,
      available: true,
      reason: null,
    }
    getBreakEvenMock.mockResolvedValue(available)
    renderWithProviders(<BreakEvenTab storeId={1} />)

    await waitFor(() => expect(screen.getByText("$ 5.000.000")).toBeInTheDocument())
    expect(screen.getByText("60 %")).toBeInTheDocument()
    expect(screen.getByText("$ 8.333.333")).toBeInTheDocument()
  })
})
