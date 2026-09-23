import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { SupplierOut, SupplierReliabilityOut } from "@/api/purchases"
import { renderWithProviders } from "@/test/utils"

import { SupplierReliabilityDialog } from "../SupplierReliabilityDialog"

const { getSupplierReliabilityMock } = vi.hoisted(() => ({ getSupplierReliabilityMock: vi.fn() }))

vi.mock("@/api/purchases", async () => {
  const actual = await vi.importActual<typeof import("@/api/purchases")>("@/api/purchases")
  return { ...actual, getSupplierReliability: getSupplierReliabilityMock }
})

const AVICOLA: SupplierOut = {
  id: 3,
  store_id: 1,
  name: "Avícola del Valle",
  nit: null,
  payment_term_days: 15,
  contact_name: null,
  contact_phone: null,
  invoices_required: true,
  active: true,
}

describe("SupplierReliabilityDialog — recibido ÷ facturado, % con factura y deriva de precio, todo ya calculado por el servidor", () => {
  it("sin recepciones en el rango, cada número se dibuja «Sin datos» rayado con su motivo, nunca «0 %»", async () => {
    const empty: SupplierReliabilityOut = {
      supplier_id: 3,
      date_from: "2026-06-01",
      date_to: "2026-09-01",
      receptions: 0,
      received_over_invoiced_pct: null,
      invoice_share_pct: null,
      avg_price_drift_pct: null,
    }
    getSupplierReliabilityMock.mockResolvedValue(empty)

    const user = userEvent.setup()
    renderWithProviders(<SupplierReliabilityDialog supplier={AVICOLA} />)

    await user.click(screen.getByRole("button", { name: "Confiabilidad" }))
    await waitFor(() => expect(getSupplierReliabilityMock).toHaveBeenCalled())

    // Patrón 5: `null` se dibuja «Sin datos» rayado, apagado y nunca en rojo, y `StatTile`
    // EXIGE la frase que explica por qué no se sabe. Antes decía «sin datos»
    // sin decir de qué carecía.
    const values = await screen.findAllByText("Sin datos")
    expect(values).toHaveLength(3)
    expect(screen.queryByText("0 %")).not.toBeInTheDocument()
    expect(screen.getAllByText(/no es 0 %, es que no hay con qué medirlo/i).length).toBe(3)
  })

  it("con datos, muestra los tres porcentajes tal cual el servidor los calculó, la deriva con signo y el detalle por insumo", async () => {
    getSupplierReliabilityMock.mockResolvedValue({
      supplier_id: 3,
      date_from: "2026-06-01",
      date_to: "2026-09-01",
      receptions: 4,
      received_over_invoiced_pct: 98,
      invoice_share_pct: 100,
      avg_price_drift_pct: 3,
      received_over_invoiced_bp: 9800,
      invoice_share_bp: 10_000,
      price_drift_bp: 286,
      n_receptions: 4,
      n_ingredients: 2,
      spend: 144_086,
      ingredients: [
        {
          ingredient_id: 15,
          name: "Chorizo antioqueño",
          base_unit: "unit",
          n_receptions: 4,
          received_over_invoiced_bp: 10_000,
          price_drift_bp: 1100,
          n_price_comparisons: 3,
          spend: 131_213,
        },
        {
          ingredient_id: 16,
          name: "Lomo de res",
          base_unit: "g",
          n_receptions: 4,
          received_over_invoiced_bp: 9300,
          price_drift_bp: -40,
          n_price_comparisons: 3,
          spend: 12_873,
        },
      ],
    } satisfies SupplierReliabilityOut)

    const user = userEvent.setup()
    renderWithProviders(<SupplierReliabilityDialog supplier={AVICOLA} />)
    await user.click(screen.getByRole("button", { name: "Confiabilidad" }))

    expect(await screen.findByText(/^98,0\s%$/)).toBeInTheDocument()
    expect(screen.getByText("Recepciones con factura").closest('[class*="rounded-lg"]')).toHaveTextContent(/100,0\s%/)
    expect(screen.getByText(/^▲ \+2,9\s%$/)).toBeInTheDocument()
    // Cuatro recepciones es muestra chica: se dice.
    expect(screen.getByText(/Muestra chica: Sobre 4 recepciones/)).toBeInTheDocument()

    const tabla = screen.getByRole("table", { name: /confiabilidad por insumo/i })
    const chorizo = within(tabla).getByText("Chorizo antioqueño").closest("tr")!
    expect(within(chorizo).getByText(/▲ \+11,0\s%/).closest("[data-tono]")).toHaveAttribute("data-tono", "critical")
    const lomo = within(tabla).getByText("Lomo de res").closest("tr")!
    expect(within(lomo).getByText(/93,0\s%/).closest("[data-tono]")).toHaveAttribute("data-tono", "critical")
    expect(within(lomo).getByText(/▼ −0,4\s%/)).toBeInTheDocument()
  })
})
