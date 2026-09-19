import { screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { PayableOut, SupplierOut } from "@/api/purchases"
import { renderWithProviders } from "@/test/utils"

import { PayablesTab } from "../PayablesTab"

const { listPayablesMock } = vi.hoisted(() => ({ listPayablesMock: vi.fn() }))

vi.mock("@/api/purchases", async () => {
  const actual = await vi.importActual<typeof import("@/api/purchases")>("@/api/purchases")
  return { ...actual, listPayables: listPayablesMock }
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

const PAYABLE: PayableOut = {
  id: 7,
  store_id: 1,
  supplier_id: 3,
  reception_id: 42,
  amount: 120000,
  balance: 80000,
  status: "approved",
  due_date: "2026-08-01",
  overdue: true,
  approved_at: "2026-09-10T10:00:00Z",
  approved_by_employee_name: "Admin",
  business_date: "2026-09-10",
}

describe("PayablesTab — el saldo mostrado es EXACTAMENTE el que manda el servidor", () => {
  it("lista con proveedor resuelto, saldo del servidor, vencida marcada, y exporta CSV", async () => {
    listPayablesMock.mockResolvedValue([PAYABLE])
    renderWithProviders(<PayablesTab storeId={1} suppliers={[AVICOLA]} />)

    await waitFor(() => expect(listPayablesMock).toHaveBeenCalled())
    expect(await screen.findByText("Avícola del Valle")).toBeInTheDocument()
    expect(screen.getByText("Vencida")).toBeInTheDocument()

    const csvLink = screen.getByRole("link", { name: /exportar csv/i })
    expect(csvLink.getAttribute("href")).toContain("format=csv")
    expect(csvLink.getAttribute("href")).toContain("/api/v1/admin/payables")
  })

  it("sin cuentas por pagar en el rango, dice que una recepción confirmada crea una automáticamente", async () => {
    listPayablesMock.mockResolvedValue([])
    renderWithProviders(<PayablesTab storeId={1} suppliers={[AVICOLA]} />)

    expect(await screen.findByText(/una recepción confirmada crea una automáticamente/i)).toBeInTheDocument()
  })
})
