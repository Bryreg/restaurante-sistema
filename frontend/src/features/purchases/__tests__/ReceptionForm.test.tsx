import { fireEvent, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { ApiError } from "@/api/client"
import type { IngredientOut } from "@/api/inventory"
import type { ReceptionOut, SupplierOut } from "@/api/purchases"
import type { StaffRequest } from "@/api/requests"
import { buildMe, renderWithProviders } from "@/test/utils"

import { ReceptionForm } from "../ReceptionForm"

const { createReceptionMock, listApprovedSupplyRequestsMock } = vi.hoisted(() => ({
  createReceptionMock: vi.fn(),
  listApprovedSupplyRequestsMock: vi.fn(),
}))

vi.mock("@/api/purchases", async () => {
  const actual = await vi.importActual<typeof import("@/api/purchases")>("@/api/purchases")
  return { ...actual, createReception: createReceptionMock }
})

vi.mock("@/api/requests", async () => {
  const actual = await vi.importActual<typeof import("@/api/requests")>("@/api/requests")
  return { ...actual, listApprovedSupplyRequests: listApprovedSupplyRequestsMock }
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

const CONFIRMED_RECEPTION: ReceptionOut = {
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
  price_confirmed: true,
  price_confirmed_by_employee_name: "Admin de prueba",
  at: "2026-09-16T10:00:00Z",
  business_date: "2026-09-16",
  reversed_at: null,
  reversed_by_employee_name: null,
  payable_id: 7,
  lines: [],
}

async function fillMinimalForm(user: ReturnType<typeof userEvent.setup>, price: string) {
  await user.click(screen.getByRole("combobox", { name: "Proveedor" }))
  await user.click(await screen.findByRole("option", { name: "Avícola del Valle" }))

  // `type="date"` no se tipea carácter a carácter con `userEvent` de forma
  // confiable (mismo criterio que `src/components/__tests__/DateRangeFilter.test.tsx`).
  fireEvent.change(screen.getByLabelText(/fecha de factura/i), { target: { value: "2026-09-16" } })

  await user.click(screen.getByRole("combobox", { name: "Insumo" }))
  await user.click(await screen.findByRole("option", { name: "Pechuga" }))

  await user.type(screen.getByLabelText(/cantidad recibida/i), "10")
  await user.type(screen.getByLabelText(/cantidad facturada/i), "10")
  await user.type(screen.getByLabelText(/precio por unidad de compra/i), price)
}

async function continueToPin(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Continuar" }))
}

async function typePin(user: ReturnType<typeof userEvent.setup>, digits = "1234") {
  for (const digit of digits) {
    await user.click(screen.getByRole("button", { name: `Dígito ${digit}` }))
  }
}

function renderForm(onSuccess = vi.fn()) {
  renderWithProviders(
    <ReceptionForm storeId={1} suppliers={[AVICOLA]} ingredients={[PECHUGA]} onSuccess={onSuccess} />,
    { me: buildMe() },
  )
  return onSuccess
}

describe("ReceptionForm — las dos guardas de tecleo preguntan y NUNCA corrigen el precio solas", () => {
  it("409 PRICE_JUMP: muestra el mensaje del servidor y lo que se tecleó, oculta el PIN, y NO reenvía sola", async () => {
    createReceptionMock.mockRejectedValueOnce(
      new ApiError(
        409,
        "PRICE_JUMP",
        'lines[0]: el precio de "Pechuga" se aleja más de 15% del promedio ponderado; si es correcto, repetí la recepción con confirm_price: true',
      ),
    )

    const user = userEvent.setup()
    renderForm()

    await fillMinimalForm(user, "45000")
    await continueToPin(user)
    await typePin(user)

    await waitFor(() => expect(createReceptionMock).toHaveBeenCalledTimes(1))
    const [, firstBody, firstKey] = createReceptionMock.mock.calls[0]!
    expect(firstBody.confirm_price).toBe(false)
    expect(firstBody.lines[0].purchase_unit_price).toBe("45000")

    // La pregunta, no una corrección muda.
    expect(await screen.findByText("El precio no coincide con lo esperado")).toBeInTheDocument()
    expect(
      screen.getByText('lines[0]: el precio de "Pechuga" se aleja más de 15% del promedio ponderado; si es correcto, repetí la recepción con confirm_price: true'),
    ).toBeInTheDocument()
    expect(screen.getByText("Lo que tecleaste para Pechuga:")).toBeInTheDocument()
    expect(screen.getByText("45000")).toBeInTheDocument()

    // El PIN desaparece: no hay forma de que un doble toque reenvíe sin confirmar a propósito.
    expect(screen.queryByRole("group", { name: "PIN de quien recibe" })).not.toBeInTheDocument()

    // Nunca se ajustó el precio tecleado.
    expect(screen.getByLabelText(/precio por unidad de compra/i)).toHaveValue("45000")

    createReceptionMock.mockResolvedValueOnce(CONFIRMED_RECEPTION)
    await user.click(screen.getByRole("button", { name: "Confirmar que el precio es correcto" }))

    await waitFor(() => expect(createReceptionMock).toHaveBeenCalledTimes(2))
    const [, secondBody, secondKey] = createReceptionMock.mock.calls[1]!
    expect(secondBody.confirm_price).toBe(true)
    // Mismo precio, EXACTO — la guarda pregunta, no corrige.
    expect(secondBody.lines[0].purchase_unit_price).toBe("45000")
    expect(secondBody.received_by_pin).toBe("1234")
    // El cuerpo cambió (confirm_price), así que la clave de idempotencia rota:
    // reusarla con un cuerpo distinto habría levantado IDEMPOTENCY_MISMATCH.
    expect(secondKey).not.toBe(firstKey)
  })

  it("409 PRICE_LOOKS_LIKE_PACKAGE: misma pregunta explícita, mismo camino de confirmación", async () => {
    createReceptionMock.mockRejectedValueOnce(
      new ApiError(
        409,
        "PRICE_LOOKS_LIKE_PACKAGE",
        'lines[0]: el precio tecleado para "Pechuga" parece un precio de empaque (entre 10 y 12 veces la referencia); si es correcto, repetí la recepción con confirm_price: true',
      ),
    )

    const user = userEvent.setup()
    renderForm()

    await fillMinimalForm(user, "180000")
    await continueToPin(user)
    await typePin(user)

    expect(await screen.findByText("El precio no coincide con lo esperado")).toBeInTheDocument()
    expect(screen.getByText(/parece un precio de empaque/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Confirmar que el precio es correcto" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Volver a revisar el precio" })).toBeInTheDocument()
  })

  it('"Volver a revisar el precio" cierra la pregunta sin reenviar nada', async () => {
    createReceptionMock.mockRejectedValueOnce(new ApiError(409, "PRICE_JUMP", 'lines[0]: el precio de "Pechuga" se aleja más de 15%; confirm_price: true'))

    const user = userEvent.setup()
    renderForm()
    await fillMinimalForm(user, "45000")
    await continueToPin(user)
    await typePin(user)

    await screen.findByText("El precio no coincide con lo esperado")
    await user.click(screen.getByRole("button", { name: "Volver a revisar el precio" }))

    expect(screen.queryByText("El precio no coincide con lo esperado")).not.toBeInTheDocument()
    expect(createReceptionMock).toHaveBeenCalledTimes(1)
  })

  it('"400 INVOICE_REQUIRED" se muestra tal cual, nunca como error mudo', async () => {
    createReceptionMock.mockRejectedValueOnce(
      new ApiError(
        400,
        "INVOICE_REQUIRED",
        '"Avícola del Valle" está marcado como obligado a facturar; cargá número y fecha de factura, o desmarcá "obligado a facturar" en el proveedor',
      ),
    )

    const user = userEvent.setup()
    renderForm()
    await fillMinimalForm(user, "12000")
    // El `Checkbox` de base-ui también trae un input nativo oculto
    // (`aria-hidden="true"`) para participar en un `<form>`; `getByRole`
    // ya lo excluye por defecto, a diferencia de `getByLabelText`.
    await user.click(screen.getByRole("checkbox", { name: /sin factura/i }))
    await continueToPin(user)
    await typePin(user)

    expect(await screen.findByRole("alert")).toHaveTextContent(
      '"Avícola del Valle" está marcado como obligado a facturar; cargá número y fecha de factura, o desmarcá "obligado a facturar" en el proveedor',
    )
  })

  it("un reintento con el MISMO cuerpo (sin cambios) reusa la Idempotency-Key en vez de rotarla", async () => {
    createReceptionMock.mockRejectedValueOnce(new ApiError(500, "UNKNOWN_ERROR", "Error del servidor (500). Intentá de nuevo."))

    const user = userEvent.setup()
    renderForm()
    await fillMinimalForm(user, "12000")
    await continueToPin(user)
    await typePin(user)

    await waitFor(() => expect(createReceptionMock).toHaveBeenCalledTimes(1))
    const firstKey = createReceptionMock.mock.calls[0]![2]

    createReceptionMock.mockResolvedValueOnce(CONFIRMED_RECEPTION)
    await typePin(user) // mismo PIN, mismos datos: el mismo intento, reintentado

    await waitFor(() => expect(createReceptionMock).toHaveBeenCalledTimes(2))
    const secondKey = createReceptionMock.mock.calls[1]![2]
    expect(secondKey).toBe(firstKey)
  })

  it("el botón «Confirmar» llama a onSuccess con la recepción confirmada", async () => {
    createReceptionMock.mockRejectedValueOnce(new ApiError(409, "PRICE_JUMP", 'lines[0]: el precio de "Pechuga" se aleja más de 15%; confirm_price: true'))
    createReceptionMock.mockResolvedValueOnce(CONFIRMED_RECEPTION)

    const user = userEvent.setup()
    const onSuccess = renderForm()
    await fillMinimalForm(user, "45000")
    await continueToPin(user)
    await typePin(user)
    await screen.findByText("El precio no coincide con lo esperado")
    await user.click(screen.getByRole("button", { name: "Confirmar que el precio es correcto" }))

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(CONFIRMED_RECEPTION))
  })
})

describe("ReceptionForm — los pedidos del salón que cubre viajan como supply_request_ids (u6)", () => {
  const APPROVED_REQUEST: StaffRequest = {
    id: 31,
    kind: "supply",
    status: "approved",
    shift_id: 1,
    business_date: "2026-09-16",
    requested_by: { id: 4, name: "Cocinera Ana" },
    requested_at: "2026-09-16T08:00:00Z",
    note: null,
    reason: null,
    lines: [
      {
        id: 1,
        ingredient_id: 5,
        ingredient_name: "Pechuga",
        base_unit: "g",
        qty_requested: "10000",
        qty_approved: "10000",
        suggested_qty: null,
        entry_unit: "kg",
        qty_requested_entry: "10",
        qty_approved_entry: "10",
      },
    ],
    requested_denominations: null,
    requested_total: null,
    approved_denominations: null,
    approved_total: null,
    resolved_by: { id: 1, name: "Admin" },
    resolved_at: "2026-09-16T09:00:00Z",
    resolution_note: null,
    closed_by: null,
    closed_at: null,
    cash_swap_id: null,
  }

  it("con pos.requests, el pedido marcado sale en supply_request_ids", async () => {
    listApprovedSupplyRequestsMock.mockReset().mockResolvedValue([APPROVED_REQUEST])
    createReceptionMock.mockReset().mockResolvedValueOnce(CONFIRMED_RECEPTION)
    const user = userEvent.setup()
    renderWithProviders(
      <ReceptionForm storeId={1} suppliers={[AVICOLA]} ingredients={[PECHUGA]} onSuccess={vi.fn()} />,
      { me: buildMe({ features: { "pos.requests": true } }) },
    )
    await fillMinimalForm(user, "12000")
    await user.click(await screen.findByRole("checkbox", { name: /Pedido #31 · Cocinera Ana/ }))
    expect(listApprovedSupplyRequestsMock).toHaveBeenCalledWith(1)
    await continueToPin(user)
    await typePin(user)

    await waitFor(() => expect(createReceptionMock).toHaveBeenCalledTimes(1))
    expect(createReceptionMock.mock.calls[0]![1].supply_request_ids).toEqual([31])
  })

  it("sin pos.requests no se ofrece ni se consulta, y no se manda ningún pedido", async () => {
    listApprovedSupplyRequestsMock.mockReset().mockResolvedValue([APPROVED_REQUEST])
    createReceptionMock.mockReset().mockResolvedValueOnce(CONFIRMED_RECEPTION)
    const user = userEvent.setup()
    renderForm()
    await fillMinimalForm(user, "12000")
    expect(screen.queryByText("Qué pedidos del salón cubre")).not.toBeInTheDocument()
    await continueToPin(user)
    await typePin(user)

    await waitFor(() => expect(createReceptionMock).toHaveBeenCalledTimes(1))
    expect(createReceptionMock.mock.calls[0]![1].supply_request_ids).toEqual([])
    expect(listApprovedSupplyRequestsMock).not.toHaveBeenCalled()
  })
})

describe("ReceptionForm — «Total de la factura» viaja como invoice_total (u5)", () => {
  it("lo tecleado sale como invoice_total en pesos enteros", async () => {
    createReceptionMock.mockReset().mockResolvedValueOnce(CONFIRMED_RECEPTION)
    const user = userEvent.setup()
    renderForm()
    await fillMinimalForm(user, "12000")
    await user.type(screen.getByLabelText(/total de la factura/i), "125000")
    await user.tab()
    await continueToPin(user)
    await typePin(user)

    await waitFor(() => expect(createReceptionMock).toHaveBeenCalledTimes(1))
    expect(createReceptionMock.mock.calls[0]![1].invoice_total).toBe(125000)
  })

  it("vacío es null, nunca 0", async () => {
    createReceptionMock.mockReset().mockResolvedValueOnce(CONFIRMED_RECEPTION)
    const user = userEvent.setup()
    renderForm()
    await fillMinimalForm(user, "12000")
    await continueToPin(user)
    await typePin(user)

    await waitFor(() => expect(createReceptionMock).toHaveBeenCalledTimes(1))
    expect(createReceptionMock.mock.calls[0]![1].invoice_total).toBeNull()
  })

  it("sin factura no hay papel: el campo desaparece y no se manda cifra", async () => {
    createReceptionMock.mockReset().mockResolvedValueOnce(CONFIRMED_RECEPTION)
    const user = userEvent.setup()
    renderForm()
    await fillMinimalForm(user, "12000")
    await user.type(screen.getByLabelText(/total de la factura/i), "125000")
    await user.tab()
    await user.click(screen.getByRole("checkbox", { name: /sin factura/i }))
    expect(screen.queryByLabelText(/total de la factura/i)).not.toBeInTheDocument()
    await continueToPin(user)
    await typePin(user)

    await waitFor(() => expect(createReceptionMock).toHaveBeenCalledTimes(1))
    expect(createReceptionMock.mock.calls[0]![1].invoice_total).toBeNull()
  })
})
