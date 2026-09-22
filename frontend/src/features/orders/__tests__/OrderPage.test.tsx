import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { Route, Routes } from "react-router-dom"

import { ApiError } from "@/api/client"
import type { OrderOut } from "@/api/orders"
import { renderWithProviders } from "@/test/utils"

import { OrderPage } from "../OrderPage"
import { buildCatalog, buildOrder, deviceMe } from "./fixtures"

const { getOrderMock, voidItemMock, addItemsMock, listFavoritesMock, getCatalogMock, fireCourseMock } = vi.hoisted(
  () => ({
    getOrderMock: vi.fn(),
    voidItemMock: vi.fn(),
    addItemsMock: vi.fn(),
    listFavoritesMock: vi.fn().mockResolvedValue([]),
    getCatalogMock: vi.fn(),
    fireCourseMock: vi.fn(),
  }),
)

vi.mock("@/api/orders", async () => {
  const actual = await vi.importActual<typeof import("@/api/orders")>("@/api/orders")
  return {
    ...actual,
    getOrder: getOrderMock,
    voidItem: voidItemMock,
    addItems: addItemsMock,
    listFavorites: listFavoritesMock,
    fireCourse: fireCourseMock,
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
  it("sin kitchen.view no existe el botón de mandar a cocina", async () => {
    getOrderMock.mockResolvedValue(buildOrder())
    renderOrderPage(501, { "kitchen.view": false })

    await waitFor(() => expect(screen.getByText(/limonada de coco/i)).toBeInTheDocument())
    expect(screen.queryByRole("button", { name: /a cocina/i })).not.toBeInTheDocument()
  })

  it("con kitchen.view existe el botón de mandar a cocina", async () => {
    getOrderMock.mockResolvedValue(buildOrder())
    renderOrderPage(501, { "kitchen.view": true })

    expect(await screen.findByRole("button", { name: /líneas? a cocina/i })).toBeInTheDocument()
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
    // Anular vive en el menú del renglón desde que la línea tomó la forma de
    // `m2b`: se llega como llega una persona, abriendo el menú.
    await user.click(screen.getByRole("button", { name: /más acciones de limonada de coco/i }))
    await user.click(await screen.findByRole("menuitem", { name: /^anular limonada de coco$/i }))

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

  it("muestra dirección, teléfono y domiciliario de una comanda de domicilio, nunca el cargo sumado a mano", async () => {
    getOrderMock.mockResolvedValue(
      buildOrder({
        channel: "delivery",
        delivery: { address: "Calle 10 # 20-30", phone: "3001234567", courier: { id: 9, name: "Luis" } },
      }),
    )
    renderOrderPage(501, {})

    await waitFor(() => expect(screen.getByText(/calle 10 # 20-30/i)).toBeInTheDocument())
    expect(screen.getByText(/3001234567/)).toBeInTheDocument()
    expect(screen.getByText(/domiciliario: luis/i)).toBeInTheDocument()
  })

  it("muestra la plataforma y el número de pedido de una comanda de plataforma", async () => {
    getOrderMock.mockResolvedValue(
      buildOrder({ channel: "platform", platform: { id: 3, name: "Rappi", external_id: "RP-778899" } }),
    )
    renderOrderPage(501, {})

    await waitFor(() => expect(screen.getByText(/rappi/i)).toBeInTheDocument())
    expect(screen.getByText(/pedido rp-778899/i)).toBeInTheDocument()
  })

  describe("«Marchar» (pos.courses)", () => {
    it("sin pos.courses no existe ningún botón Marchar", async () => {
      getOrderMock.mockResolvedValue(buildOrder())
      renderOrderPage(501, { "pos.courses": false })

      await waitFor(() => expect(screen.getByText(/limonada de coco/i)).toBeInTheDocument())
      expect(screen.queryByText(/^marchar$/i)).not.toBeInTheDocument()
    })

    it("marcha un curso pendiente y, una vez marchado, no deja marcharlo de nuevo", async () => {
      const order = buildOrder({ courses_fired: [] })
      const fired = buildOrder({
        version: 2,
        courses_fired: [{ course: "beverage", fired_at: "2026-09-15T18:10:00Z", fired_by: { id: 2, name: "Ana" } }],
      })
      getOrderMock.mockResolvedValueOnce(order).mockResolvedValue(fired)
      fireCourseMock.mockResolvedValue(fired)

      const user = userEvent.setup()
      renderOrderPage(501, { "pos.courses": true })

      const button = await screen.findByRole("button", { name: /marchar bebida/i })
      await user.click(button)

      await waitFor(() => expect(fireCourseMock).toHaveBeenCalledTimes(1))
      const [orderId, course, body] = fireCourseMock.mock.calls[0]
      expect(orderId).toBe(501)
      expect(course).toBe("beverage")
      expect(body).toEqual({ expected_version: 1 })

      // Una vez marchado, la UI refleja el gate del backend: ya no hay
      // botón para "Marchar" de nuevo, sólo el aviso de que ya se marchó.
      expect(await screen.findByText(/bebida marchado/i)).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: /marchar bebida/i })).not.toBeInTheDocument()
    })
  })
})
