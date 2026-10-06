import { screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { WasteAnalysisOut } from "@/api/inventory"
import { renderWithProviders } from "@/test/utils"

import { WasteAnalysisTab } from "../WasteAnalysisTab"

const { getWasteAnalysisMock } = vi.hoisted(() => ({ getWasteAnalysisMock: vi.fn() }))

vi.mock("@/api/inventory", async () => {
  const actual = await vi.importActual<typeof import("@/api/inventory")>("@/api/inventory")
  return { ...actual, getWasteAnalysis: getWasteAnalysisMock }
})

const DATA: WasteAnalysisOut = {
  store_id: 1,
  date_from: "2026-01-01",
  date_to: "2026-01-31",
  entries: 4,
  uncosted_entries: 1,
  cost: 5_500,
  by_reason: [
    { type: "expired", loss: true, entries: 2, uncosted_entries: 1, cost: 3_000, share_bp: 5455 },
    { type: "internal_use", loss: false, entries: 1, uncosted_entries: 0, cost: 6_000, share_bp: null },
  ],
  by_ingredient: [
    { kind: "ingredient", item_id: 1, name: "Carne", unit: "g", qty: "150", entries: 2, uncosted_entries: 0, cost: 4_500, share_bp: 8182 },
    { kind: "ingredient", item_id: 3, name: "Hierbas", unit: "g", qty: "10", entries: 1, uncosted_entries: 1, cost: null, share_bp: null },
  ],
  by_person: [{ employee_id: 4, employee_name: "Operator", entries: 2, uncosted_entries: 0, cost: 4_000, share_bp: 7273 }],
}

describe("Inventario › Análisis de mermas", () => {
  it("pinta lo que calculó el servidor: total, por motivo, por insumo y por persona, sin costo ≠ $0", async () => {
    getWasteAnalysisMock.mockResolvedValue(DATA)
    renderWithProviders(<WasteAnalysisTab storeId={1} />)

    expect(await screen.findByTestId("merma-total")).toHaveTextContent("$ 5.500")
    expect(screen.getByTestId("merma-total")).toHaveTextContent("1 sin costo")

    const motivos = screen.getByRole("region", { name: "Por motivo" })
    expect(within(motivos).getByText("Vencido")).toBeInTheDocument()
    expect(within(motivos).getByText("no es pérdida")).toBeInTheDocument()

    const insumos = screen.getByRole("region", { name: "Por insumo" })
    const hierbas = within(insumos).getByText("Hierbas").closest("tr") as HTMLElement
    expect(within(hierbas).getByText("Sin costo")).toBeInTheDocument()
    expect(within(hierbas).queryByText("$ 0")).not.toBeInTheDocument()

    const personas = screen.getByRole("region", { name: "Por persona" })
    expect(within(personas).getByText("$ 4.000")).toBeInTheDocument()
  })
})
