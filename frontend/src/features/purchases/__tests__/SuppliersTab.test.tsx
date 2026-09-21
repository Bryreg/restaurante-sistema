import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { ApiError } from "@/api/client"
import type { SupplierOut } from "@/api/purchases"
import { renderWithProviders } from "@/test/utils"

import { SuppliersTab } from "../SuppliersTab"

const { listSuppliersMock, createSupplierMock, deactivateSupplierMock } = vi.hoisted(() => ({
  listSuppliersMock: vi.fn(),
  createSupplierMock: vi.fn(),
  deactivateSupplierMock: vi.fn(),
}))

vi.mock("@/api/purchases", async () => {
  const actual = await vi.importActual<typeof import("@/api/purchases")>("@/api/purchases")
  return { ...actual, listSuppliers: listSuppliersMock, createSupplier: createSupplierMock, deactivateSupplier: deactivateSupplierMock }
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
