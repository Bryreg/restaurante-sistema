import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { IngredientOut } from "@/api/inventory"
import type { PurchaseOrderOut, SupplierOut } from "@/api/purchases"
import { renderWithProviders } from "@/test/utils"

import { PurchaseOrderPrintPage } from "../PurchaseOrderPrintPage"
import { PurchaseOrdersTab } from "../PurchaseOrdersTab"

const mocks = vi.hoisted(() => ({
  listPurchaseOrders: vi.fn(),
  createPurchaseOrder: vi.fn(),
  createPurchaseOrderFromReplenishment: vi.fn(),
  sendPurchaseOrder: vi.fn(),
  getPurchaseOrder: vi.fn(),
  listIngredients: vi.fn(),
  hasFeature: vi.fn(),
}))

vi.mock("@/api/purchases", async () => {
  const actual = await vi.importActual<typeof import("@/api/purchases")>("@/api/purchases")
  return {
    ...actual,
    listPurchaseOrders: mocks.listPurchaseOrders,
    createPurchaseOrder: mocks.createPurchaseOrder,
    createPurchaseOrderFromReplenishment: mocks.createPurchaseOrderFromReplenishment,
    sendPurchaseOrder: mocks.sendPurchaseOrder,
    getPurchaseOrder: mocks.getPurchaseOrder,
  }
})
vi.mock("@/api/inventory", async () => {
  const actual = await vi.importActual<typeof import("@/api/inventory")>("@/api/inventory")
  return { ...actual, listIngredients: mocks.listIngredients }
})

const SUPPLIER = { id: 3, store_id: 1, name: "Avícola del Valle", active: true } as SupplierOut
const POLLO = { id: 7, name: "Pechuga de pollo", purchase_unit: "kg", base_unit: "g" } as unknown as IngredientOut

const ORDER: PurchaseOrderOut = {
  id: 11,
  store_id: 1,
  store_name: "Sede Centro",
  supplier_id: 3,
  supplier_name: "Avícola del Valle",
  supplier_nit: "900123",
  supplier_contact_name: "Carlos",
  supplier_contact_phone: "300",
  number: 4,
  status: "draft",
  source: "manual",
  expected_date: "2026-01-20",
  notes: "Antes de las 10",
  created_by_employee_name: "Admin",
  created_at: "2026-01-15T12:00:00Z",
  business_date: "2026-01-15",
  sent_at: null,
  sent_by_employee_name: null,
  cancelled_at: null,
  cancelled_by_employee_name: null,
  cancel_reason: null,
  expected_total: 43_500,
  expected_total_reason: null,
  reception_ids: [],
  lines: [
    {
      id: 1,
      ingredient_id: 7,
      ingredient_name: "Pechuga de pollo",
      quantity: "3",
      purchase_unit: "kg",
      qty_base: "3000",
      base_unit: "g",
      expected_unit_price: "14500",
      received_quantity: "0",
      closed: false,
      closed_reception_id: null,
    },
  ],
}

describe("Compras › Órdenes de compra", () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset()
    mocks.listIngredients.mockResolvedValue([POLLO])
    mocks.hasFeature.mockReturnValue(true)
  })

  it("lista las órdenes con su estado y el total que calculó el servidor", async () => {
    mocks.listPurchaseOrders.mockResolvedValue([ORDER])
    renderWithProviders(<PurchaseOrdersTab storeId={1} suppliers={[SUPPLIER]} />, { session: { hasFeature: mocks.hasFeature } })
    expect(await screen.findByText("#4")).toBeInTheDocument()
    expect(screen.getByText("Borrador")).toBeInTheDocument()
    expect(screen.getByText("$ 43.500")).toBeInTheDocument()
  })

  it("crea un borrador con las líneas en la unidad de compra, como texto", async () => {
    mocks.listPurchaseOrders.mockResolvedValue([])
    mocks.createPurchaseOrder.mockResolvedValue(ORDER)
    const user = userEvent.setup()
    renderWithProviders(<PurchaseOrdersTab storeId={1} suppliers={[SUPPLIER]} />, { session: { hasFeature: mocks.hasFeature } })

    await user.click(await screen.findByRole("button", { name: "Nueva orden de compra" }))
    await user.click(screen.getByRole("combobox", { name: "Proveedor" }))
    await user.click(await screen.findByRole("option", { name: "Avícola del Valle" }))
    await user.click(screen.getByRole("combobox", { name: "Insumo de la línea 1" }))
    await user.click(await screen.findByRole("option", { name: "Pechuga de pollo" }))
    await user.type(screen.getByLabelText(/Cantidad/), "3")
    await user.type(screen.getByLabelText("Precio esperado"), "14500")
    await user.click(screen.getByRole("button", { name: "Crear borrador" }))

    await waitFor(() => expect(mocks.createPurchaseOrder).toHaveBeenCalled())
    const [storeId, payload, key] = mocks.createPurchaseOrder.mock.calls[0]
    expect(storeId).toBe(1)
    expect(payload).toEqual({
      supplier_id: 3,
      expected_date: null,
      notes: null,
      lines: [{ ingredient_id: 7, quantity: "3", expected_unit_price: "14500" }],
    })
    expect(typeof key).toBe("string")
  })

  it("sin la reposición sugerida encendida no ofrece armar la orden desde ahí", async () => {
    mocks.hasFeature.mockReturnValue(false)
    mocks.listPurchaseOrders.mockResolvedValue([])
    renderWithProviders(<PurchaseOrdersTab storeId={1} suppliers={[SUPPLIER]} />, { session: { hasFeature: mocks.hasFeature } })
    await screen.findByText("Todavía no hay órdenes de compra")
    expect(screen.queryByRole("button", { name: "Desde la reposición sugerida" })).not.toBeInTheDocument()
  })

  it("la hoja para imprimir muestra proveedor, cantidades y, si se pide, los precios", async () => {
    mocks.getPurchaseOrder.mockResolvedValue(ORDER)
    const user = userEvent.setup()
    renderWithProviders(<PurchaseOrderPrintPage />, { route: "/imprimir/orden-compra?id=11" })
    expect(await screen.findByText("#4")).toBeInTheDocument()
    expect(screen.getByText("Avícola del Valle")).toBeInTheDocument()
    expect(screen.getByText("3 kg")).toBeInTheDocument()
    expect(screen.queryByText("$ 14.500")).not.toBeInTheDocument()
    await user.click(screen.getByRole("checkbox", { name: "Mostrar precios esperados" }))
    expect(await screen.findByText("$ 14.500")).toBeInTheDocument()
  })
})
