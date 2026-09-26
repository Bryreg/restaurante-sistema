/**
 * Recibir mercancía desde el POS (decisión del dueño, 2026-09-25): el cajero
 * registra proveedor, factura o «sin factura», foto obligatoria y líneas
 * (insumo + cantidad en su unidad de compra) — SIN NINGÚN PRECIO. Se prueba:
 *
 * - sin foto no sale el POST;
 * - el POST lleva exactamente el contrato de `POST /reception-drafts`, sin un
 *   solo campo de precio, con la cantidad tal cual se tecleó y su
 *   `Idempotency-Key`;
 * - «¿Pagaste de contado desde la caja?» manda el monto o `null`, nunca 0;
 * - «Recibido hoy» muestra el estado que dice el servidor.
 */
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type {
  DeviceReceptionIngredientOut,
  DeviceSupplierOut,
  ReceptionDraftOut,
  ReceptionSuggestions,
} from "@/api/purchases"
import { renderWithProviders } from "@/test/utils"

import { ReceiveGoodsPanel } from "../ReceiveGoodsPanel"

const { suppliersMock, ingredientsMock, todayMock, createMock, suggestionsMock } = vi.hoisted(() => ({
  suppliersMock: vi.fn(),
  ingredientsMock: vi.fn(),
  todayMock: vi.fn(),
  createMock: vi.fn(),
  suggestionsMock: vi.fn(),
}))

vi.mock("@/api/purchases", async () => {
  const actual = await vi.importActual<typeof import("@/api/purchases")>("@/api/purchases")
  return {
    ...actual,
    listDeviceSuppliers: suppliersMock,
    listDeviceReceptionIngredients: ingredientsMock,
    listTodayReceptionDrafts: todayMock,
    createReceptionDraft: createMock,
    getReceptionSuggestions: suggestionsMock,
  }
})

vi.mock("@/components/PhotoCaptureField", () => ({
  PhotoCaptureField: ({ onChange, label }: { onChange: (dataUrl: string | null) => void; label?: string }) => (
    <button type="button" onClick={() => onChange("data:image/png;base64,xyz")}>
      {label} (stub)
    </button>
  ),
}))

const SUPPLIERS: DeviceSupplierOut[] = [{ id: 3, name: "Avícola del Valle", invoices_required: true }]
const INGREDIENTS: DeviceReceptionIngredientOut[] = [
  { id: 5, name: "Pechuga de pollo", purchase_unit: "kg", base_unit: "g" },
  { id: 6, name: "Papa criolla", purchase_unit: "bulto", base_unit: "g" },
]

const NO_SUGGESTIONS: ReceptionSuggestions = {
  supplier_id: 3,
  source: "none",
  request_ids: [],
  request_lines: [],
  last_purchase_date: null,
  last_purchase_lines: [],
}

function draft(overrides: Partial<ReceptionDraftOut>): ReceptionDraftOut {
  return {
    id: 1,
    supplier_id: 3,
    supplier_name: "Avícola del Valle",
    invoice_number: "FE-9",
    no_invoice: false,
    photo: "/api/v1/photos/1",
    status: "pending",
    cash_paid_amount: null,
    created_by_employee_name: "Cajera Ana",
    created_at: "2026-09-25T15:00:00Z",
    business_date: "2026-09-25",
    rejected_reason: null,
    lines: [
      {
        id: 1,
        ingredient_id: 5,
        ingredient_name: "Pechuga de pollo",
        quantity: "2",
        purchase_unit: "kg",
        lot_code: null,
        expires_at: null,
      },
    ],
    ...overrides,
  }
}

beforeEach(() => {
  suppliersMock.mockReset().mockResolvedValue(SUPPLIERS)
  ingredientsMock.mockReset().mockResolvedValue(INGREDIENTS)
  todayMock.mockReset().mockResolvedValue([])
  createMock.mockReset()
  suggestionsMock.mockReset().mockResolvedValue(NO_SUGGESTIONS)
})

async function fillBasics(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("combobox", { name: "Proveedor" }))
  await user.click(await screen.findByRole("option", { name: "Avícola del Valle" }))
  await user.type(screen.getByLabelText("Número de factura o remisión"), "FE-77")
  await user.type(screen.getByLabelText("Buscar insumo"), "pech")
  await user.click(screen.getByRole("button", { name: "Pechuga de pollo" }))
  await user.type(screen.getByLabelText("Cantidad (kg)"), "2,5")
}

describe("ReceiveGoodsPanel — recibir mercancía desde el POS", () => {
  it("sin foto no registra nada y dice por qué", async () => {
    const user = userEvent.setup()
    renderWithProviders(<ReceiveGoodsPanel />)
    await fillBasics(user)
    await user.click(screen.getByRole("button", { name: "No" }))
    await user.click(screen.getByRole("button", { name: "Registrar lo que llegó" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(/foto/i)
    expect(createMock).not.toHaveBeenCalled()
  })

  it("registra sin ningún precio, con la cantidad tal cual y el pago de la caja", async () => {
    createMock.mockResolvedValue(draft({}))
    const user = userEvent.setup()
    renderWithProviders(<ReceiveGoodsPanel />)
    await fillBasics(user)
    await user.type(screen.getByLabelText("Lote (opcional)"), "L-1")
    await user.click(screen.getByRole("button", { name: /foto de la factura o remisión/i }))
    await user.click(screen.getByRole("button", { name: "Sí, pagué de la caja" }))
    await user.type(screen.getByLabelText("Monto que le entregaste"), "50000")
    await user.click(screen.getByRole("button", { name: "Registrar lo que llegó" }))

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    const [body, key] = createMock.mock.calls[0]!
    expect(body).toEqual({
      supplier_id: 3,
      invoice_number: "FE-77",
      no_invoice: false,
      photo: "data:image/png;base64,xyz",
      cash_paid_amount: 50_000,
      lines: [{ ingredient_id: 5, quantity: "2,5", lot_code: "L-1", expires_at: null }],
    })
    expect(JSON.stringify(body)).not.toMatch(/price|cost/)
    expect(typeof key).toBe("string")
  })

  it("«Sin factura» manda el número en null, y «No pagué» manda el monto en null (no 0)", async () => {
    createMock.mockResolvedValue(draft({}))
    const user = userEvent.setup()
    renderWithProviders(<ReceiveGoodsPanel />)
    await fillBasics(user)
    await user.click(screen.getByRole("checkbox", { name: "Sin factura" }))
    await user.click(screen.getByRole("button", { name: /foto de la factura o remisión/i }))
    await user.click(screen.getByRole("button", { name: "No" }))
    await user.click(screen.getByRole("button", { name: "Registrar lo que llegó" }))

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    const [body] = createMock.mock.calls[0]!
    expect(body.no_invoice).toBe(true)
    expect(body.invoice_number).toBeNull()
    expect(body.cash_paid_amount).toBeNull()
  })

  it("«Recibido hoy» muestra el estado que dice el servidor, con el motivo del rechazo", async () => {
    todayMock.mockResolvedValue([
      draft({ id: 1 }),
      draft({ id: 2, status: "completed", cash_paid_amount: 20_000 }),
      draft({ id: 3, status: "rejected", rejected_reason: "Factura de otra sede" }),
    ])
    renderWithProviders(<ReceiveGoodsPanel />)

    expect(await screen.findByText("Por completar")).toBeInTheDocument()
    expect(screen.getByText("Completada")).toBeInTheDocument()
    expect(screen.getByText("Rechazada: Factura de otra sede")).toBeInTheDocument()
    expect(screen.getByText(/pagado de la caja \$ 20\.000/)).toBeInTheDocument()
    expect(screen.getAllByText("2 kg de Pechuga de pollo").length).toBe(3)
  })
})

describe("ReceiveGoodsPanel — arranca precargado (auditoría de tablet)", () => {
  const APPROVED: ReceptionSuggestions = {
    ...NO_SUGGESTIONS,
    source: "request",
    request_ids: [40],
    request_lines: [
      { ingredient_id: 5, name: "Pechuga de pollo", purchase_unit: "kg", base_unit: "g", quantity: "10" },
      { ingredient_id: 6, name: "Papa criolla", purchase_unit: "bulto", base_unit: "g", quantity: "2" },
    ],
    last_purchase_date: "2026-09-20",
    last_purchase_lines: [{ ingredient_id: 6, name: "Papa criolla", purchase_unit: "bulto", base_unit: "g", quantity: "3" }],
  }

  it("precarga lo aprobado; cada línea se marca «Llegó» o «Llegó distinto», y viaja sin precios", async () => {
    suggestionsMock.mockResolvedValue(APPROVED)
    createMock.mockResolvedValue(draft({}))
    const user = userEvent.setup()
    renderWithProviders(<ReceiveGoodsPanel />)

    await user.click(await screen.findByRole("combobox", { name: "Proveedor" }))
    await user.click(await screen.findByRole("option", { name: "Avícola del Valle" }))
    expect(await screen.findByText(/Precargado con lo aprobado en Solicitudes/)).toBeInTheDocument()
    expect(suggestionsMock).toHaveBeenCalledWith(3)

    await user.type(screen.getByLabelText("Número de factura o remisión"), "FE-77")
    await user.click(screen.getByRole("button", { name: /foto de la factura o remisión/i }))
    await user.click(screen.getByRole("button", { name: "No" }))

    // Sin marcar cómo llegó cada una, no se registra.
    await user.click(screen.getByRole("button", { name: "Registrar lo que llegó" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/llegó tal cual o distinto/)
    expect(createMock).not.toHaveBeenCalled()

    const pollo = screen.getByRole("group", { name: "¿Cómo llegó Pechuga de pollo?" })
    await user.click(within(pollo).getByRole("button", { name: "Llegó" }))
    const papa = screen.getByRole("group", { name: "¿Cómo llegó Papa criolla?" })
    await user.click(within(papa).getByRole("button", { name: "Llegó distinto" }))
    await user.type(screen.getByLabelText("Cantidad que llegó (bulto)"), "1,5")
    await user.click(screen.getByRole("button", { name: "Registrar lo que llegó" }))

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    const [body] = createMock.mock.calls[0]!
    expect(body.lines).toEqual([
      { ingredient_id: 5, quantity: "10", lot_code: null, expires_at: null },
      { ingredient_id: 6, quantity: "1,5", lot_code: null, expires_at: null },
    ])
    expect(JSON.stringify(body)).not.toMatch(/price|cost/)
  })

  it("se puede cambiar a la última compra del proveedor", async () => {
    suggestionsMock.mockResolvedValue(APPROVED)
    const user = userEvent.setup()
    renderWithProviders(<ReceiveGoodsPanel />)
    await user.click(await screen.findByRole("combobox", { name: "Proveedor" }))
    await user.click(await screen.findByRole("option", { name: "Avícola del Valle" }))
    await user.click(await screen.findByRole("button", { name: "Cargar la última compra (1)" }))
    expect(screen.getByText(/Precargado con la última compra/)).toBeInTheDocument()
    expect(screen.getByText(/se esperaba 3 bulto/)).toBeInTheDocument()
    expect(screen.queryByRole("group", { name: "¿Cómo llegó Pechuga de pollo?" })).not.toBeInTheDocument()
  })
})
