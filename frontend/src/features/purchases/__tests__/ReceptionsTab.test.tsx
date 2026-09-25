import { screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { IngredientOut } from "@/api/inventory"
import type { ReceptionOut, SupplierOut } from "@/api/purchases"
import { renderWithProviders } from "@/test/utils"

import { ReceptionsTab } from "../ReceptionsTab"

const { listReceptionsMock, listIngredientsMock, listReceptionDraftsMock } = vi.hoisted(() => ({
  listReceptionsMock: vi.fn(),
  listReceptionDraftsMock: vi.fn().mockResolvedValue([]),
  listIngredientsMock: vi.fn().mockResolvedValue([] as IngredientOut[]),
}))

vi.mock("@/api/purchases", async () => {
  const actual = await vi.importActual<typeof import("@/api/purchases")>("@/api/purchases")
  return { ...actual, listReceptions: listReceptionsMock, listReceptionDrafts: listReceptionDraftsMock }
})

vi.mock("@/api/inventory", async () => {
  const actual = await vi.importActual<typeof import("@/api/inventory")>("@/api/inventory")
  return { ...actual, listIngredients: listIngredientsMock }
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

const RECEPTION: ReceptionOut = {
  id: 42,
  store_id: 1,
  supplier_id: 3,
  invoice_number: "F-001",
  invoice_date: "2026-09-16",
  no_invoice: false,
  photo: null,
  received_by_employee_id: 9,
  received_by_employee_name: "Operador Uno",
  status: "confirmed",
  price_confirmed: false,
  price_confirmed_by_employee_name: null,
  at: "2026-09-16T10:00:00Z",
  business_date: "2026-09-16",
  reversed_at: null,
  reversed_by_employee_name: null,
  payable_id: 7,
  lines: [],
}

describe("ReceptionsTab", () => {
  it("lista recepciones con el nombre del proveedor resuelto, y exporta CSV con format=csv", async () => {
    listReceptionsMock.mockResolvedValue([RECEPTION])
    renderWithProviders(<ReceptionsTab storeId={1} suppliers={[AVICOLA]} />)

    await waitFor(() => expect(listReceptionsMock).toHaveBeenCalled())
    expect(await screen.findByText("Avícola del Valle")).toBeInTheDocument()

    const csvLink = screen.getByRole("link", { name: /exportar csv/i })
    expect(csvLink.getAttribute("href")).toContain("format=csv")
    expect(csvLink.getAttribute("href")).toContain("/api/v1/admin/receptions")
  })

  it("sin proveedores activos, avisa que hace falta crear uno antes de recibir mercancía", async () => {
    listReceptionsMock.mockResolvedValue([])
    renderWithProviders(<ReceptionsTab storeId={1} suppliers={[{ ...AVICOLA, active: false }]} />)

    expect(await screen.findByText(/creá al menos un proveedor activo/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Nueva recepción" })).toBeDisabled()
  })
})
