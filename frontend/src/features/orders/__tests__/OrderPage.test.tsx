import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { Route, Routes } from "react-router-dom"

import { ApiError } from "@/api/client"
import type { OrderOut } from "@/api/orders"
import { renderWithProviders } from "@/test/utils"

import { OrderPage } from "../OrderPage"
import { buildCatalog, buildOrder, deviceMe } from "./fixtures"

const { getOrderMock, voidItemMock, addItemsMock, listFavoritesMock, getCatalogMock } = vi.hoisted(() => ({
  getOrderMock: vi.fn(),
  voidItemMock: vi.fn(),
  addItemsMock: vi.fn(),
  listFavoritesMock: vi.fn().mockResolvedValue([]),
  getCatalogMock: vi.fn(),
}))

vi.mock("@/api/orders", async () => {
  const actual = await vi.importActual<typeof import("@/api/orders")>("@/api/orders")
  return {
    ...actual,
    getOrder: getOrderMock,
    voidItem: voidItemMock,
    addItems: addItemsMock,
    listFavorites: listFavoritesMock,
  }
})

vi.mock("@/api/catalog", async () => {
  const actual = await vi.importActual<typeof import("@/api/catalog")>("@/api/catalog")
  return { ...actual, getCatalog: getCatalogMock }
})

getCatalogMock.mockResolvedValue(buildCatalog())

/** `OrderPage` sólo resuelve `useParams()` dentro de una ruta real. */
function renderOrderPage(orderId: number, features: Record<string, boolean>) {
  return renderWithProviders(
    <Routes>
      <Route path="/pos/comanda/:orderId" element={<OrderPage />} />
    </Routes>,
    { me: deviceMe(features), route: `/pos/comanda/${orderId}` },
  )
}

describe("OrderPage", () => {
  it("sin kitchen.view no existe el botón Enviar", async () => {
    getOrderMock.mockResolvedValue(buildOrder())
    renderOrderPage(501, { "kitchen.view": false })

    await waitFor(() => expect(screen.getByText(/limonada de coco/i)).toBeInTheDocument())
    expect(screen.queryByRole("button", { name: /enviar/i })).not.toBeInTheDocument()
  })

  it("con kitchen.view existe el botón Enviar", async () => {
    getOrderMock.mockResolvedValue(buildOrder())
    renderOrderPage(501, { "kitchen.view": true })

    expect(await screen.findByRole("button", { name: /enviar/i })).toBeInTheDocument()
  })

  it("409 STALE_VERSION reemplaza la comanda local y avisa a la persona", async () => {
    const initialOrder = buildOrder({ version: 1, note: null })
    const freshOrder = buildOrder({ version: 2, note: "Nota nueva de otra tablet" })
    getOrderMock.mockResolvedValueOnce(initialOrder).mockResolvedValue(freshOrder)
    voidItemMock.mockRejectedValueOnce(
      new ApiError(409, "STALE_VERSION", "La comanda cambió en otra tablet", { order: freshOrder }),
    )

    const user = userEvent.setup()
    renderOrderPage(501, {})

    await waitFor(() => expect(screen.getByText(/limonada de coco/i)).toBeInTheDocument())
    await user.click(screen.getByRole("button", { name: /^anular limonada de coco$/i }))

    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByRole("combobox"))
    await user.click(await screen.findByRole("option", { name: "El cliente cambió de opinión" }))
    await user.click(within(dialog).getByRole("button", { name: /^anular$/i }))

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/la comanda cambió en otra tablet; revisá y repetí/i),
    )
    await waitFor(() => expect(screen.getByText(/nota nueva de otra tablet/i)).toBeInTheDocument())
  })

  it("ante AUTHORIZATION_REQUIRED (BILL_PRESENTED_NEEDS_AUTH) pide PIN y reintenta con una Idempotency-Key nueva", async () => {
    const order = buildOrder()
    const updated: OrderOut = buildOrder({ version: 2 })
    getOrderMock.mockResolvedValue(order)
    addItemsMock
      .mockRejectedValueOnce(new ApiError(400, "BILL_PRESENTED_NEEDS_AUTH", "La comanda ya tiene cuenta presentada"))
      .mockResolvedValueOnce(updated)

    const user = userEvent.setup()
    renderOrderPage(501, {})

    await user.click(await screen.findByRole("tab", { name: "Bebidas" }))
    await user.click(await screen.findByRole("button", { name: /agregar limonada de coco/i }))

    const itemDialog = await screen.findByRole("dialog")
    await user.click(within(itemDialog).getByRole("button", { name: /agregar a la comanda/i }))

    expect(await screen.findByText(/la comanda ya tiene cuenta presentada/i)).toBeInTheDocument()
    expect(screen.getByRole("group", { name: /pin de supervisor o administrador/i })).toBeInTheDocument()

    for (const digit of ["1", "2", "3", "4"]) {
      await user.click(screen.getByRole("button", { name: `Dígito ${digit}` }))
    }

    await waitFor(() => expect(addItemsMock).toHaveBeenCalledTimes(2))
    const [, secondBody, secondKey] = addItemsMock.mock.calls[1]
    expect(secondBody.authorizer_pin).toBe("1234")
    const [, , firstKey] = addItemsMock.mock.calls[0]
    expect(secondKey).not.toBe(firstKey)
  })
})
