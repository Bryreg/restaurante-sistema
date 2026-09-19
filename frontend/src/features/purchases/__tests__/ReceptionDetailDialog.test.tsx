import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { ApiError } from "@/api/client"
import type { IngredientOut } from "@/api/inventory"
import type { ReceptionOut, SupplierOut } from "@/api/purchases"
import { renderWithProviders } from "@/test/utils"

import { ReceptionDetailDialog } from "../ReceptionDetailDialog"

const { reverseReceptionMock } = vi.hoisted(() => ({ reverseReceptionMock: vi.fn() }))

vi.mock("@/api/purchases", async () => {
  const actual = await vi.importActual<typeof import("@/api/purchases")>("@/api/purchases")
  return { ...actual, reverseReception: reverseReceptionMock }
})

const PECHUGA: IngredientOut = {
  id: 5,
  name: "Pechuga",
  category: null,
  base_unit: "g",
  purchase_unit: "kg",
  purchase_factor: 1000,
  yield_pct: 100,
  official_cost: null,
  estimated_cost: null,
  cost: null,
  cost_source: "none",
  min_stock: "1000",
  lead_time_days: null,
  perishable: true,
  key_item: true,
  consumption_untracked: false,
  substitute_ingredient_id: null,
  supplier_id: null,
  active: true,
}

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
  lines: [
    {
      id: 100,
      ingredient_id: 5,
      qty_received: "10",
      qty_invoiced: "10",
      purchase_unit_price: "12000",
      unit_cost: "12",
      final_unit_cost: "12",
      tax_base: 0,
      tax_rate: 0,
      tax_amount: 0,
      lot_code: "L-1",
      expires_at: "2026-10-01",
      stock_batch_id: 55,
      stock_movement_id: 200,
    },
  ],
}

async function openReversalDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Ver" }))
  await screen.findByRole("dialog")
  await user.click(screen.getByRole("button", { name: "Eliminar recepción" }))
  await screen.findByRole("alertdialog")
}

describe("ReceptionDetailDialog — eliminar muestra QUÉ se va a revertir antes de pedir el PIN", () => {
  it("el resumen de lo que se revierte aparece antes del campo de PIN, y el PIN arranca vacío", async () => {
    reverseReceptionMock.mockResolvedValue({ ...RECEPTION })
    const user = userEvent.setup()
    renderWithProviders(<ReceptionDetailDialog reception={RECEPTION} suppliers={[AVICOLA]} ingredients={[PECHUGA]} />)

    await openReversalDialog(user)

    const alertDialog = screen.getByRole("alertdialog")
    expect(within(alertDialog).getByText("Esto es lo que se va a revertir")).toBeInTheDocument()
    expect(within(alertDialog).getByText(/L-1/)).toBeInTheDocument()
    expect(within(alertDialog).getByLabelText("PIN de administrador")).toHaveValue("")

    // El botón de confirmar no habilita sin PIN.
    expect(within(alertDialog).getByRole("button", { name: "Eliminar recepción" })).toBeDisabled()
  })

  it('"409 LOT_CONSUMED" se explica en castellano, con el motivo exacto del servidor', async () => {
    reverseReceptionMock.mockRejectedValueOnce(
      new ApiError(409, "LOT_CONSUMED", "Este lote ya se consumió, al menos en parte; no se puede revertir la recepción que lo creó"),
    )
    const user = userEvent.setup()
    renderWithProviders(<ReceptionDetailDialog reception={RECEPTION} suppliers={[AVICOLA]} ingredients={[PECHUGA]} />)

    await openReversalDialog(user)
    await user.type(screen.getByLabelText("PIN de administrador"), "9000")
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Eliminar recepción" }))

    expect(await screen.findByText("Este lote ya se consumió, al menos en parte; no se puede revertir la recepción que lo creó")).toBeInTheDocument()
  })

  it('"409 PAYABLE_HAS_PAYMENTS" se explica en castellano, con el motivo exacto del servidor', async () => {
    reverseReceptionMock.mockRejectedValueOnce(
      new ApiError(409, "PAYABLE_HAS_PAYMENTS", "Esta recepción tiene una cuenta por pagar con pagos vivos; anulalos antes de revertir la recepción"),
    )
    const user = userEvent.setup()
    renderWithProviders(<ReceptionDetailDialog reception={RECEPTION} suppliers={[AVICOLA]} ingredients={[PECHUGA]} />)

    await openReversalDialog(user)
    await user.type(screen.getByLabelText("PIN de administrador"), "9000")
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Eliminar recepción" }))

    expect(await screen.findByText("Esta recepción tiene una cuenta por pagar con pagos vivos; anulalos antes de revertir la recepción")).toBeInTheDocument()
  })

  it("una recepción ya revertida no ofrece «Eliminar recepción»", async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <ReceptionDetailDialog
        reception={{ ...RECEPTION, status: "reversed", reversed_at: "2026-09-16T12:00:00Z", reversed_by_employee_name: "Admin" }}
        suppliers={[AVICOLA]}
        ingredients={[PECHUGA]}
      />,
    )
    await user.click(screen.getByRole("button", { name: "Ver" }))
    await screen.findByRole("dialog")
    expect(screen.queryByRole("button", { name: "Eliminar recepción" })).not.toBeInTheDocument()
  })
})
