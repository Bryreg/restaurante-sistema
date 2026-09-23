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
  const SANA = {
    days_since_full_count: 3,
    last_full_count_at: "2026-09-12T10:00:00Z",
    inventory_unreliable: false,
    reception_invoice_ratio_bp: 8000,
    reception_invoice_ratio_reason: null,
    batch_preps_produced_ratio_bp: 5000,
    batch_preps_produced_reason: null,
    waste_entries_this_week: 4,
  }
  const FOOD_COST = {
    available: true,
    reason: null,
    opening_count_id: 5,
    closing_count_id: 6,
    window_from: "2026-09-01T14:00:00Z",
    window_to: "2026-09-14T14:00:00Z",
    opening_value: 500000,
    purchases_value: 200000,
    closing_value: 450000,
    net_sales: 1000000,
    pct_bp: 2500,
    window_hours: 312,
    window_days: 13,
    orders_in_window: 240,
    theoretical_pct_bp: 2210,
    theoretical_reason: null,
    costed_pct_bp: 9800,
    gap_bp: 290,
    min_window_days: 1,
    min_costed_pct_bp: 8000,
  }

  it("food cost real disponible: titular real vs teórico con la brecha del servidor, ventana, comandas y los cuatro totales", async () => {
    getControlHealthMock.mockResolvedValue(SANA)
    getFoodCostMock.mockResolvedValue(FOOD_COST)

    renderWithProviders(<ControlHealthTab storeId={1} />)

    // Analista #1: la conclusión, con la brecha tal como llega (`gap_bp`).
    expect(
      await screen.findByRole("heading", { name: /^Real 25,0\s% vs teórico 22,1\s%: se pierden 2,9 puntos$/ }),
    ).toBeInTheDocument()
    // La base: comandas y ventana (ChartFrame.muestra).
    expect(screen.getByText(/Base: 240 comandas · 13 días, del mar 1 sep al lun 14 sep/)).toBeInTheDocument()
    // Enlace a la varianza que explica la brecha.
    expect(screen.getByRole("link", { name: "Ver qué insumos explican la brecha" })).toHaveAttribute(
      "href",
      "/admin/inventario?tab=varianza",
    )
    // La banda de cifra con su libro (patrón 4) sigue abajo.
    expect(screen.getByText(/conteos #5 y #6/)).toBeInTheDocument()
    expect(screen.getByText("$ 500.000")).toBeInTheDocument()
    expect(screen.getByText("3")).toBeInTheDocument()
  })

  it("real por debajo del teórico: dice «por debajo», nunca «se pierden» un número negativo, y no ofrece la varianza como explicación", async () => {
    getControlHealthMock.mockResolvedValue(SANA)
    getFoodCostMock.mockResolvedValue({ ...FOOD_COST, pct_bp: 1901, theoretical_pct_bp: 3421, gap_bp: -1520 })

    renderWithProviders(<ControlHealthTab storeId={1} />)

    expect(
      await screen.findByRole("heading", { name: /el real queda 15,2 puntos por debajo$/ }),
    ).toBeInTheDocument()
    expect(screen.queryByText(/se pierden/)).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Ver qué insumos explican la brecha" })).not.toBeInTheDocument()
  })

  it("food cost real rechazado por el servidor (ventana de 16 h): el motivo del servidor, el teórico al lado, nunca un % negativo ni 0 %", async () => {
    getControlHealthMock.mockResolvedValue(SANA)
    getFoodCostMock.mockResolvedValue({
      ...FOOD_COST,
      available: false,
      reason:
        "Los dos últimos conteos completos están a 16 h de distancia; hacen falta al menos 24 h (un día completo) entre conteos para que el food cost real sea confiable",
      opening_count_id: 2,
      closing_count_id: 5,
      window_from: "2026-09-21T21:39:43Z",
      window_to: "2026-09-22T14:00:00Z",
      purchases_value: 0,
      pct_bp: null,
      window_hours: 16,
      window_days: 0,
      orders_in_window: 16,
      theoretical_pct_bp: 3310,
      gap_bp: null,
    })

    const { container } = renderWithProviders(<ControlHealthTab storeId={1} />)

    expect(await screen.findByText(/están a 16 h de distancia/)).toBeInTheDocument()
    expect(screen.getByText(/Food cost real sin publicar entre los conteos #2 y #5/)).toBeInTheDocument()
    expect(screen.getByText(/^33,1\s%$/)).toBeInTheDocument()
    expect(screen.getByText(/16 h, del lun 21 sep al mar 22 sep · 16 comandas/)).toBeInTheDocument()
    const texto = container.textContent ?? ""
    expect(texto).not.toMatch(/[-−]\d+,\d+\s%/)
    expect(texto).not.toMatch(/(^|[^\d,.])0(,0)?\s%/)
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
