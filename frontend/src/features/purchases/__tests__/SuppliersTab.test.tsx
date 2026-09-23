import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ApiError } from "@/api/client"
import type { SupplierOut, SupplierReliabilityRowOut } from "@/api/purchases"
import { renderWithProviders } from "@/test/utils"

import { SuppliersTab } from "../SuppliersTab"

const { listSuppliersMock, createSupplierMock, deactivateSupplierMock, getSuppliersReliabilityMock } = vi.hoisted(() => ({
  listSuppliersMock: vi.fn(),
  createSupplierMock: vi.fn(),
  deactivateSupplierMock: vi.fn(),
  getSuppliersReliabilityMock: vi.fn(),
}))

vi.mock("@/api/purchases", async () => {
  const actual = await vi.importActual<typeof import("@/api/purchases")>("@/api/purchases")
  return {
    ...actual,
    listSuppliers: listSuppliersMock,
    createSupplier: createSupplierMock,
    deactivateSupplier: deactivateSupplierMock,
    getSuppliersReliability: getSuppliersReliabilityMock,
  }
})

const DISTRIBUIDORA: SupplierOut = {
  id: 1,
  store_id: 1,
  name: "Distribuidora El Surtidor",
  nit: "900123456",
  payment_term_days: 30,
  contact_name: "Ana",
  contact_phone: "3001234567",
  invoices_required: true,
  active: true,
}

beforeEach(() => {
  getSuppliersReliabilityMock.mockResolvedValue({ store_id: 1, date_from: "2026-06-25", date_to: "2026-09-23", rows: [] })
})

describe("SuppliersTab — entidad canónica, baja lógica, NIT duplicado con mensaje específico", () => {
  it('"400 SUPPLIER_DUPLICATE_NIT" se muestra tal cual el servidor lo redactó, no como un toast genérico', async () => {
    listSuppliersMock.mockResolvedValue([])
    createSupplierMock.mockRejectedValueOnce(
      new ApiError(400, "SUPPLIER_DUPLICATE_NIT", 'Ya existe un proveedor con NIT "900123456" en esta sede ("Distribuidora El Surtidor")'),
    )

    const user = userEvent.setup()
    renderWithProviders(<SuppliersTab storeId={1} />)

    await user.click(screen.getByRole("button", { name: "Nuevo proveedor" }))
    await screen.findByRole("dialog")

    await user.type(screen.getByLabelText("Nombre"), "Distribuidora Nueva")
    await user.type(screen.getByLabelText("NIT (opcional)"), "900123456")
    await user.click(screen.getByRole("button", { name: "Crear" }))

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent('Ya existe un proveedor con NIT "900123456" en esta sede ("Distribuidora El Surtidor")')
  })

  it("«Desactivar» hace una baja LÓGICA (DELETE = active:false), nunca un borrado de fila", async () => {
    listSuppliersMock.mockResolvedValue([DISTRIBUIDORA])
    deactivateSupplierMock.mockResolvedValue({ ...DISTRIBUIDORA, active: false })

    const user = userEvent.setup()
    renderWithProviders(<SuppliersTab storeId={1} />)

    await screen.findByText("Distribuidora El Surtidor")
    await user.click(screen.getByRole("button", { name: "Desactivar" }))

    await waitFor(() => expect(deactivateSupplierMock).toHaveBeenCalledWith(1))
  })

  it("con el proveedor obligado a facturar, el formulario lo dice y no lo esconde", async () => {
    listSuppliersMock.mockResolvedValue([DISTRIBUIDORA])
    renderWithProviders(<SuppliersTab storeId={1} />)

    await screen.findByText("Distribuidora El Surtidor")
    // «Obligado a facturar» es a la vez la celda de la fila y un término de
    // la leyenda del pie: se acota a la tabla, que es donde el test quiere
    // verlo.
    expect(within(screen.getByRole("table")).getByText("Obligado a facturar")).toBeInTheDocument()
  })
})

function fila(over: Partial<SupplierReliabilityRowOut> & { supplier_id: number; name: string }): SupplierReliabilityRowOut {
  return {
    date_from: "2026-06-25",
    date_to: "2026-09-23",
    receptions: 6,
    received_over_invoiced_pct: 100,
    invoice_share_pct: 100,
    avg_price_drift_pct: 0,
    received_over_invoiced_bp: 10_000,
    invoice_share_bp: 10_000,
    price_drift_bp: 0,
    n_receptions: 6,
    n_ingredients: 2,
    spend: 500_000,
    ingredients: [],
    active: true,
    ...over,
  }
}

describe("SuppliersTab — la confiabilidad se compara en la lista (informe #9)", () => {
  const OTRO: SupplierOut = { ...DISTRIBUIDORA, id: 2, name: "Frigorífico El Llano", nit: "900999999" }
  const TERCERO: SupplierOut = { ...DISTRIBUIDORA, id: 3, name: "Lácteos San Fernando", nit: "900888888" }

  it("recibido ÷ facturado y deriva con signo, en ámbar/rojo fuera de umbral, y «muestra chica» con pocas recepciones", async () => {
    listSuppliersMock.mockResolvedValue([DISTRIBUIDORA, OTRO, TERCERO])
    getSuppliersReliabilityMock.mockResolvedValue({
      store_id: 1,
      date_from: "2026-06-25",
      date_to: "2026-09-23",
      rows: [
        fila({ supplier_id: 1, name: DISTRIBUIDORA.name, received_over_invoiced_bp: 9700, price_drift_bp: -120 }),
        fila({ supplier_id: 2, name: OTRO.name, received_over_invoiced_bp: 9400, price_drift_bp: 1250 }),
        fila({ supplier_id: 3, name: TERCERO.name, n_receptions: 2, receptions: 2, price_drift_bp: null }),
      ],
    })
    renderWithProviders(<SuppliersTab storeId={1} />)

    const tabla = await screen.findByRole("table", { name: /proveedores de la sede/i })
    await waitFor(() => expect(within(tabla).getByText(/97,0\s%/)).toBeInTheDocument())

    const surtidor = within(tabla).getByText(DISTRIBUIDORA.name).closest("tr")!
    expect(within(surtidor).getByText(/97,0\s%/).closest("[data-tono]")).toHaveAttribute("data-tono", "warning")
    // Una bajada de precio lleva ▼ y signo, y nunca es alerta.
    expect(within(surtidor).getByText(/▼ −1,2\s%/).closest("[data-tono]")).toHaveAttribute("data-tono", "none")

    const llano = within(tabla).getByText(OTRO.name).closest("tr")!
    expect(within(llano).getByText(/94,0\s%/).closest("[data-tono]")).toHaveAttribute("data-tono", "critical")
    expect(within(llano).getByText(/▲ \+12,5\s%/).closest("[data-tono]")).toHaveAttribute("data-tono", "critical")

    const lacteos = within(tabla).getByText(TERCERO.name).closest("tr")!
    expect(within(lacteos).getByText("muestra chica")).toBeInTheDocument()
    expect(getSuppliersReliabilityMock).toHaveBeenCalledWith(expect.objectContaining({ storeId: 1 }))
  })
})
