/**
 * Admin → Compras → Recepciones: las recepciones que registró el POS sin
 * precios aparecen primero, marcadas «Desde el POS · por completar», con la
 * foto a la vista y cuánto hace que esperan (lo dice el servidor).
 * «Completar» abre el formulario de siempre PRECARGADO (proveedor, factura,
 * líneas con la cantidad ya en unidad base) y confirma sin PIN ni foto nueva;
 * «Rechazar» pide motivo.
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { IngredientOut } from "@/api/inventory"
import type { ReceptionDraftAdminOut, ReceptionOut, SupplierOut } from "@/api/purchases"
import { buildMe, renderWithProviders } from "@/test/utils"

import { ReceptionDraftsSection } from "../ReceptionDraftsSection"

const { listDraftsMock, completeMock, rejectMock } = vi.hoisted(() => ({
  listDraftsMock: vi.fn(),
  completeMock: vi.fn(),
  rejectMock: vi.fn(),
}))

vi.mock("@/api/purchases", async () => {
  const actual = await vi.importActual<typeof import("@/api/purchases")>("@/api/purchases")
  return {
    ...actual,
    listReceptionDrafts: listDraftsMock,
    completeReceptionDraft: completeMock,
    rejectReceptionDraft: rejectMock,
  }
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

const DRAFT: ReceptionDraftAdminOut = {
  id: 11,
  store_id: 1,
  supplier_id: 3,
  supplier_name: "Avícola del Valle",
  invoice_number: "FE-77",
  no_invoice: false,
  photo: "/api/v1/photos/9",
  status: "pending",
  cash_paid_amount: 20_000,
  cash_movement_id: 4,
  created_by_employee_id: 8,
  created_by_employee_name: "Cajera Ana",
  created_at: "2026-09-25T13:00:00Z",
  business_date: "2026-09-25",
  waiting_minutes: 125,
  reception_id: null,
  completed_at: null,
  completed_by_employee_name: null,
  rejected_at: null,
  rejected_reason: null,
  rejected_by_employee_name: null,
  lines: [
    {
      id: 1,
      ingredient_id: 5,
      ingredient_name: "Pechuga",
      quantity: "2",
      purchase_unit: "kg",
      lot_code: "L-7",
      expires_at: "2026-12-31",
      qty_base: "2000",
      base_unit: "g",
    },
  ],
}

const RECEPTION: ReceptionOut = {
  id: 42,
  store_id: 1,
  supplier_id: 3,
  invoice_number: "FE-77",
  invoice_date: "2026-09-25",
  no_invoice: false,
  photo: "/api/v1/photos/9",
  received_by_employee_id: 8,
  received_by_employee_name: "Cajera Ana",
  status: "confirmed",
  price_confirmed: false,
  price_confirmed_by_employee_name: null,
  at: "2026-09-25T15:00:00Z",
  business_date: "2026-09-25",
  reversed_at: null,
  reversed_by_employee_name: null,
  payable_id: 7,
  lines: [],
}

beforeEach(() => {
  listDraftsMock.mockReset().mockResolvedValue([DRAFT])
  completeMock.mockReset()
  rejectMock.mockReset()
})

function renderSection(onCompleted = vi.fn()) {
  renderWithProviders(
    <ReceptionDraftsSection storeId={1} suppliers={[AVICOLA]} ingredients={[PECHUGA]} onCompleted={onCompleted} />,
    { me: buildMe() },
  )
  return onCompleted
}

describe("ReceptionDraftsSection — recepciones del POS por completar", () => {
  it("las muestra marcadas, con la foto, lo que contó el cajero, cuánto espera y el pago de la caja", async () => {
    renderSection()
    const card = await screen.findByRole("article", { name: /recepción del pos #11/i })
    expect(within(card).getByText("Desde el POS · por completar")).toBeInTheDocument()
    expect(within(card).getByText("2 h 5 min")).toBeInTheDocument()
    expect(within(card).getByText(/2 kg de Pechuga · lote L-7/)).toBeInTheDocument()
    expect(within(card).getByText("$ 20.000")).toBeInTheDocument()
    expect(within(card).getByRole("link", { name: /ver la foto/i })).toHaveAttribute("href", "/api/v1/photos/9")
    expect(listDraftsMock).toHaveBeenCalledWith(1, "pending")
  })

  it("sin ninguna por completar, no dibuja nada", async () => {
    listDraftsMock.mockResolvedValue([])
    renderSection()
    await waitFor(() => expect(listDraftsMock).toHaveBeenCalled())
    expect(screen.queryByText(/desde el pos/i)).not.toBeInTheDocument()
  })

  it("«Completar» abre el formulario precargado y confirma sin PIN ni foto nueva, con los precios del admin", async () => {
    completeMock.mockResolvedValue(RECEPTION)
    const user = userEvent.setup()
    const onCompleted = renderSection()

    await user.click(await screen.findByRole("button", { name: "Completar" }))
    const dialog = await screen.findByRole("dialog")

    // Precargado con lo del POS: la cantidad ya viene en unidad base, del servidor.
    expect(within(dialog).getByLabelText(/cantidad recibida/i)).toHaveValue("2000")
    expect(within(dialog).getByLabelText(/cantidad facturada/i)).toHaveValue("2000")
    expect(within(dialog).getByLabelText("Número de factura")).toHaveValue("FE-77")
    expect(within(dialog).getByLabelText(/fecha de factura/i)).toHaveValue("2026-09-25")
    expect(within(dialog).getByRole("img", { name: /factura o remisión de avícola del valle/i })).toHaveAttribute(
      "src",
      "/api/v1/photos/9",
    )
    expect(within(dialog).getByText(/no vuelve a salir plata del cajón/i)).toBeInTheDocument()

    fireEvent.change(within(dialog).getByLabelText(/fecha de factura/i), { target: { value: "2026-09-24" } })
    await user.type(within(dialog).getByLabelText(/precio por unidad de compra/i), "14500")
    await user.click(within(dialog).getByRole("button", { name: "Continuar" }))
    // Sin PinPad: quien recibió es quien la registró en el POS.
    expect(within(dialog).queryByRole("button", { name: "Dígito 1" })).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole("button", { name: "Confirmar recepción" }))

    await waitFor(() => expect(completeMock).toHaveBeenCalledTimes(1))
    const [draftId, body, key] = completeMock.mock.calls[0]!
    expect(draftId).toBe(11)
    expect(body).not.toHaveProperty("photo")
    expect(body).not.toHaveProperty("received_by_pin")
    expect(body).toMatchObject({
      supplier_id: 3,
      invoice_number: "FE-77",
      invoice_date: "2026-09-24",
      no_invoice: false,
      confirm_price: false,
      lines: [
        {
          ingredient_id: 5,
          qty_received: "2000",
          qty_invoiced: "2000",
          purchase_unit_price: "14500",
          lot_code: "L-7",
          expires_at: "2026-12-31",
        },
      ],
    })
    expect(typeof key).toBe("string")
    await waitFor(() => expect(onCompleted).toHaveBeenCalled())
  })

  it("«Rechazar» pide motivo, avisa que la plata de la caja no vuelve, y manda el motivo", async () => {
    rejectMock.mockResolvedValue({ ...DRAFT, status: "rejected", rejected_reason: "Factura de otra sede" })
    const user = userEvent.setup()
    renderSection()

    await user.click(await screen.findByRole("button", { name: "Rechazar" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText(/no devuelve esa plata al cajón/i)).toBeInTheDocument()
    const submit = within(dialog).getByRole("button", { name: "Rechazar recepción" })
    expect(submit).toBeDisabled()

    await user.type(within(dialog).getByLabelText("Motivo"), "Factura de otra sede")
    await user.click(submit)
    await waitFor(() => expect(rejectMock).toHaveBeenCalledWith(11, "Factura de otra sede"))
  })
})
