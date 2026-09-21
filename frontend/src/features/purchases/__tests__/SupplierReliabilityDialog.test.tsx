import { screen, waitFor } from "@testing-library/react"
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
  it("sin recepciones en el rango, cada número se dibuja «—» con su motivo, nunca «0 %»", async () => {
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

    // Patrón 5: `null` se dibuja «—», apagado y nunca en rojo, y `StatTile`
    // EXIGE la frase que explica por qué no se sabe. Antes decía «sin datos»
    // sin decir de qué carecía.
    const values = await screen.findAllByText("—")
    expect(values).toHaveLength(3)
    expect(screen.queryByText("0 %")).not.toBeInTheDocument()
    expect(screen.getAllByText(/no es 0 %, es que no hay con qué medirlo/i).length).toBe(3)
  })

  it("con datos, muestra los tres porcentajes tal cual el servidor los calculó", async () => {
    getSupplierReliabilityMock.mockResolvedValue({
      supplier_id: 3,
      date_from: "2026-06-01",
      date_to: "2026-09-01",
      receptions: 4,
      received_over_invoiced_pct: 98,
      invoice_share_pct: 100,
      avg_price_drift_pct: 3,
    })

    const user = userEvent.setup()
    renderWithProviders(<SupplierReliabilityDialog supplier={AVICOLA} />)
    await user.click(screen.getByRole("button", { name: "Confiabilidad" }))

    expect(await screen.findByText("98 %")).toBeInTheDocument()
    expect(screen.getByText("100 %")).toBeInTheDocument()
    expect(screen.getByText("3 %")).toBeInTheDocument()
  })
})
