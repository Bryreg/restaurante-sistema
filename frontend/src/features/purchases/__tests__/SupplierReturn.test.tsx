import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { IngredientOut } from "@/api/inventory"
import type { ReceptionOut, SupplierOut, SupplierReturnOut } from "@/api/purchases"
import { renderWithProviders } from "@/test/utils"

import { ReceptionDetailDialog } from "../ReceptionDetailDialog"

const mocks = vi.hoisted(() => ({ createSupplierReturn: vi.fn(), listSupplierReturns: vi.fn() }))

vi.mock("@/api/purchases", async () => {
  const actual = await vi.importActual<typeof import("@/api/purchases")>("@/api/purchases")
  return { ...actual, createSupplierReturn: mocks.createSupplierReturn, listSupplierReturns: mocks.listSupplierReturns }
})

const PECHUGA = { id: 5, name: "Pechuga", base_unit: "g", purchase_unit: "kg" } as unknown as IngredientOut
const AVICOLA = { id: 3, store_id: 1, name: "Avícola del Valle" } as SupplierOut

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
  lines: [
    {
      id: 100,
      ingredient_id: 5,
      qty_received: "2000",
      qty_invoiced: "2000",
      purchase_unit_price: "14500",
      unit_cost: "14.5",
      final_unit_cost: "14.5",
      tax_base: 0,
      tax_rate: 0,
      tax_amount: 0,
      lot_code: "L-1",
      expires_at: null,
      stock_batch_id: 55,
      stock_movement_id: 200,
      qty_returned: "0",
    },
  ],
}

const RETURNED: SupplierReturnOut = {
  id: 1,
  store_id: 1,
  supplier_id: 3,
  supplier_name: "Avícola del Valle",
  reception_id: 42,
  reception_line_id: 100,
  ingredient_id: 5,
  ingredient_name: "Pechuga",
  base_unit: "g",
  payable_id: 7,
  qty: "500",
  amount: 7_250,
  applied_to_payable: 4_000,
  credit_amount: 3_250,
  reason: "Llegó dañado",
  employee_name: "Admin",
  authorized_by_employee_name: "Admin",
  created_at: "2026-09-17T10:00:00Z",
  business_date: "2026-09-17",
}

describe("Recepción › Devolver al proveedor", () => {
  beforeEach(() => {
    mocks.createSupplierReturn.mockReset()
    mocks.listSupplierReturns.mockReset()
    mocks.listSupplierReturns.mockResolvedValue([])
  })

  it("manda la línea, la cantidad tal cual, el motivo y el PIN, y muestra lo que el servidor decidió de la plata", async () => {
    mocks.createSupplierReturn.mockResolvedValue(RETURNED)
    const user = userEvent.setup()
    renderWithProviders(<ReceptionDetailDialog reception={RECEPTION} suppliers={[AVICOLA]} ingredients={[PECHUGA]} />)
    await user.click(screen.getByRole("button", { name: "Ver" }))
    const section = await screen.findByRole("region", { name: "Devolver al proveedor" })

    const submit = within(section).getByRole("button", { name: "Registrar devolución" })
    expect(submit).toBeDisabled()
    await user.type(within(section).getByLabelText("Cantidad"), "500")
    await user.type(within(section).getByLabelText("Motivo"), "Llegó dañado")
    await user.type(within(section).getByLabelText("PIN que autoriza la devolución"), "9999")
    await user.click(submit)

    await waitFor(() => expect(mocks.createSupplierReturn).toHaveBeenCalled())
    const [receptionId, payload] = mocks.createSupplierReturn.mock.calls[0]
    expect(receptionId).toBe(42)
    expect(payload).toEqual({ reception_line_id: 100, qty: "500", reason: "Llegó dañado", authorizer_pin: "9999" })
    expect(await within(section).findByText(/\$ 3\.250 quedan a favor con el proveedor/)).toBeInTheDocument()
  })
})
