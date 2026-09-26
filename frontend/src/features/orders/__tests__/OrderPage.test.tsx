import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { Route, Routes } from "react-router-dom"

import type { Me } from "@/api/auth"
import { ApiError } from "@/api/client"
import type { OrderOut } from "@/api/orders"
import { renderWithProviders } from "@/test/utils"

import { OrderPage } from "../OrderPage"
import { buildCatalog, buildCatalogProduct, buildOrder, buildOrderItem, deviceMe } from "./fixtures"

const {
  getOrderMock,
  voidItemMock,
  addItemsMock,
  patchItemMock,
  sendOrderMock,
  listFavoritesMock,
  getCatalogMock,
  fireCourseMock,
  markServedMock,
  presentBillMock,
  toastSuccessMock,
} = vi.hoisted(() => ({
  getOrderMock: vi.fn(),
  voidItemMock: vi.fn(),
  addItemsMock: vi.fn(),
  patchItemMock: vi.fn(),
  sendOrderMock: vi.fn(),
  listFavoritesMock: vi.fn().mockResolvedValue([]),
  getCatalogMock: vi.fn(),
  fireCourseMock: vi.fn(),
  markServedMock: vi.fn(),
  presentBillMock: vi.fn(),
  toastSuccessMock: vi.fn(),
}))

vi.mock("sonner", async () => {
  const actual = await vi.importActual<typeof import("sonner")>("sonner")
  return { ...actual, toast: Object.assign(vi.fn(), actual.toast, { success: toastSuccessMock }) }
})

vi.mock("@/api/orders", async () => {
  const actual = await vi.importActual<typeof import("@/api/orders")>("@/api/orders")
  return {
    ...actual,
    getOrder: getOrderMock,
    voidItem: voidItemMock,
    addItems: addItemsMock,
    patchItem: patchItemMock,
    sendOrder: sendOrderMock,
    listFavorites: listFavoritesMock,
    fireCourse: fireCourseMock,
    markServed: markServedMock,
    presentBill: presentBillMock,
  }
})

vi.mock("@/api/catalog", async () => {
  const actual = await vi.importActual<typeof import("@/api/catalog")>("@/api/catalog")
  return { ...actual, getCatalog: getCatalogMock }
})

getCatalogMock.mockResolvedValue(buildCatalog())

beforeEach(() => {
  addItemsMock.mockReset()
  patchItemMock.mockReset()
  sendOrderMock.mockReset()
  presentBillMock.mockReset()
  toastSuccessMock.mockReset()
  voidItemMock.mockReset()
  getCatalogMock.mockResolvedValue(buildCatalog())
})

/** `OrderPage` sólo resuelve `useParams()` dentro de una ruta real. */
function renderOrderPage(orderId: number, features: Record<string, boolean>, meOverrides: Partial<Me> = {}) {
  return renderWithProviders(
    <Routes>
      <Route path="/pos/comanda/:orderId" element={<OrderPage />} />
      <Route path="/pos/mesas" element={<p>Mapa de mesas</p>} />
      <Route path="/pos/cobro/:orderId" element={<p>Pantalla de cobro</p>} />
    </Routes>,
    { me: deviceMe(features, meOverrides), route: `/pos/comanda/${orderId}` },
  )
}

/** Abre el panel de acciones de una línea del pedido (tocar la línea). */
async function openLine(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(await screen.findByRole("button", { name }))
  return screen.findByRole("dialog")
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
    const sheet = await openLine(user, /limonada de coco: acciones/i)
    await user.click(within(sheet).getByRole("button", { name: /^anular limonada de coco$/i }))

    const dialog = await screen.findByRole("dialog", { name: /anular limonada de coco/i })
    await user.click(within(dialog).getByRole("radio", { name: "El cliente cambió de opinión" }))
    await user.click(within(dialog).getByRole("button", { name: /^anular$/i }))

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/la comanda cambió en otra tablet; revisá y repetí/i),
    )
    await waitFor(() => expect(screen.getByText(/nota nueva de otra tablet/i)).toBeInTheDocument())
  })

  it("ante AUTHORIZATION_REQUIRED (BILL_PRESENTED_NEEDS_AUTH) pide PIN y reintenta con una Idempotency-Key nueva", async () => {
    // Cuenta presentada: el toque rápido va por `addItems` (que exige PIN),
    // nunca por el PATCH de cantidad, aunque ya haya una línea igual.
    const order = buildOrder({ bill_presented_at: "2026-09-15T19:00:00Z" })
    const updated: OrderOut = buildOrder({ version: 2, bill_presented_at: "2026-09-15T19:00:00Z" })
    getOrderMock.mockResolvedValue(order)
    addItemsMock
      .mockRejectedValueOnce(new ApiError(400, "BILL_PRESENTED_NEEDS_AUTH", "La comanda ya tiene cuenta presentada"))
      .mockResolvedValueOnce(updated)

    const user = userEvent.setup()
    renderOrderPage(501, {})

    await user.click(await screen.findByRole("tab", { name: "Bebidas" }))
    // Un plato sin modificadores obligatorios se suma con un toque, sin diálogo.
    await user.click(await screen.findByRole("button", { name: /agregar limonada de coco/i }))

    expect(await screen.findByText(/la comanda ya tiene cuenta presentada/i)).toBeInTheDocument()
    expect(screen.getByRole("group", { name: /pin de supervisor o administrador/i })).toBeInTheDocument()
    expect(patchItemMock).not.toHaveBeenCalled()

    for (const digit of ["1", "2", "3", "4"]) {
      await user.click(screen.getByRole("button", { name: `Dígito ${digit}` }))
    }

    await waitFor(() => expect(addItemsMock).toHaveBeenCalledTimes(2))
    const [, firstBody, firstKey] = addItemsMock.mock.calls[0]
    expect(firstBody.items).toEqual([{ product_id: 10, qty: 1 }])
    const [, secondBody, secondKey] = addItemsMock.mock.calls[1]
    expect(secondBody.authorizer_pin).toBe("1234")
    expect(secondKey).not.toBe(firstKey)
  })

  it("con la cuenta presentada, «Sumar una unidad» pide PIN y reintenta el cambio de cantidad con él", async () => {
    // El servidor exige el PIN también en el PATCH de cantidad: subirla es
    // agregar platos, y antes era la puerta de atrás de `addItems`.
    const order = buildOrder({ bill_presented_at: "2026-09-15T19:00:00Z" })
    getOrderMock.mockResolvedValue(order)
    patchItemMock
      .mockRejectedValueOnce(new ApiError(400, "BILL_PRESENTED_NEEDS_AUTH", "La cuenta ya se presentó"))
      .mockResolvedValueOnce(buildOrder({ version: 2, bill_presented_at: "2026-09-15T19:00:00Z" }))

    const user = userEvent.setup()
    renderOrderPage(501, {})

    const sheet = await openLine(user, /limonada de coco: acciones/i)
    await user.click(within(sheet).getByRole("button", { name: /^sumar una unidad de limonada de coco$/i }))
    expect(await screen.findByRole("group", { name: /pin de supervisor o administrador/i })).toBeInTheDocument()
    for (const digit of ["1", "2", "3", "4"]) {
      await user.click(screen.getByRole("button", { name: `Dígito ${digit}` }))
    }

    await waitFor(() => expect(patchItemMock).toHaveBeenCalledTimes(2))
    expect(patchItemMock.mock.calls[0][2].authorizer_pin).toBeUndefined()
    expect(patchItemMock.mock.calls[1][2]).toMatchObject({ qty: 2, authorizer_pin: "1234" })
  })

  describe("toque en la carta", () => {
    it("un plato sin modificadores obligatorios suma una unidad a la línea igual que ya existe", async () => {
      getOrderMock.mockResolvedValue(buildOrder({ version: 3 }))
      patchItemMock.mockResolvedValue(buildOrder({ version: 4, items: [buildOrderItem({ qty: 2, net: 16000 })] }))

      const user = userEvent.setup()
      renderOrderPage(501, {})

      await user.click(await screen.findByRole("tab", { name: "Bebidas" }))
      await user.click(await screen.findByRole("button", { name: /agregar limonada de coco/i }))

      await waitFor(() => expect(patchItemMock).toHaveBeenCalledTimes(1))
      expect(patchItemMock).toHaveBeenCalledWith(501, 1, { expected_version: 3, qty: 2 })
      expect(addItemsMock).not.toHaveBeenCalled()
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    })

    it("sin una línea igual en la ronda, agrega una línea nueva de 1× por addItems", async () => {
      getOrderMock.mockResolvedValue(buildOrder({ version: 3, items: [buildOrderItem({ status: "sent", round_no: 1 })] }))
      addItemsMock.mockResolvedValue(buildOrder({ version: 4 }))

      const user = userEvent.setup()
      renderOrderPage(501, {})

      await user.click(await screen.findByRole("tab", { name: "Bebidas" }))
      await user.click(await screen.findByRole("button", { name: /agregar limonada de coco/i }))

      await waitFor(() => expect(addItemsMock).toHaveBeenCalledTimes(1))
      const [orderId, body] = addItemsMock.mock.calls[0]
      expect(orderId).toBe(501)
      expect(body).toEqual({ expected_version: 3, items: [{ product_id: 10, qty: 1 }], authorizer_pin: undefined })
      expect(patchItemMock).not.toHaveBeenCalled()
    })

    it("un plato con un grupo de modificadores obligatorio abre el diálogo en vez de sumarlo", async () => {
      getCatalogMock.mockResolvedValue(
        buildCatalog({
          categories: [{ id: 2, name: "Fuertes", sort_order: 1, active: true }],
          products: [
            buildCatalogProduct({
              id: 30,
              category_id: 2,
              name: "Bandeja paisa",
              default_course: "main",
              modifier_groups: [
                {
                  id: 7,
                  product_id: 30,
                  name: "Término",
                  required: true,
                  min: 1,
                  max: 1,
                  sort_order: 1,
                  options: [{ id: 70, name: "A punto", price_delta: 0, available: true }],
                },
              ],
            }),
          ],
        }),
      )
      getOrderMock.mockResolvedValue(buildOrder())

      const user = userEvent.setup()
      renderOrderPage(501, { "pos.modifiers": true })

      await user.click(await screen.findByRole("tab", { name: "Fuertes" }))
      await user.click(await screen.findByRole("button", { name: /agregar bandeja paisa/i }))

      const dialog = await screen.findByRole("dialog")
      expect(within(dialog).getByText(/término/i)).toBeInTheDocument()
      expect(addItemsMock).not.toHaveBeenCalled()
      expect(patchItemMock).not.toHaveBeenCalled()
    })

    it("«Elegir opciones» abre el diálogo para el próximo plato, y el siguiente toque vuelve a sumar directo", async () => {
      getOrderMock.mockResolvedValue(buildOrder({ items: [] }))
      addItemsMock.mockResolvedValue(buildOrder({ version: 2 }))

      const user = userEvent.setup()
      renderOrderPage(501, {})

      await user.click(await screen.findByRole("tab", { name: "Bebidas" }))
      const toggle = screen.getByRole("button", { name: /elegir opciones/i })
      await user.click(toggle)
      expect(toggle).toHaveAttribute("aria-pressed", "true")

      await user.click(screen.getByRole("button", { name: /agregar limonada de coco/i }))
      expect(await screen.findByRole("dialog")).toBeInTheDocument()
      expect(addItemsMock).not.toHaveBeenCalled()
      expect(toggle).toHaveAttribute("aria-pressed", "false")
    })
  })

  describe("«Enviar a cocina»", () => {
    it("dice cuántas unidades salen (suma de cantidades sin enviar) y manda la versión vigente", async () => {
      getOrderMock.mockResolvedValue(
        buildOrder({
          version: 5,
          items: [
            buildOrderItem({ id: 1, qty: 2 }),
            buildOrderItem({ id: 2, product_id: 11, name: "Sopa", qty: 3, course: "starter" }),
            // Lo ya enviado no cuenta: sale con la ronda anterior.
            buildOrderItem({ id: 3, product_id: 12, name: "Postre", qty: 4, status: "sent", round_no: 1 }),
          ],
        }),
      )
      sendOrderMock.mockResolvedValue(buildOrder({ version: 6, items: [] }))

      const user = userEvent.setup()
      renderOrderPage(501, { "kitchen.view": true })

      const button = await screen.findByRole("button", { name: "Enviar a cocina · 5 ítems" })
      expect(button).toBeEnabled()
      await user.click(button)

      await waitFor(() => expect(sendOrderMock).toHaveBeenCalledTimes(1))
      const [orderId, body] = sendOrderMock.mock.calls[0]
      expect(orderId).toBe(501)
      expect(body).toEqual({ expected_version: 5 })
    })

    it("en singular con una unidad", async () => {
      getOrderMock.mockResolvedValue(buildOrder())
      renderOrderPage(501, { "kitchen.view": true })

      expect(await screen.findByRole("button", { name: "Enviar a cocina · 1 ítem" })).toBeEnabled()
    })

    it("sin nada sin enviar, la barra fija vuelve a ofrecer la cuenta en ese lugar", async () => {
      getOrderMock.mockResolvedValue(buildOrder({ items: [buildOrderItem({ status: "sent", round_no: 1 })] }))
      renderOrderPage(501, { "kitchen.view": true }, { employee: { id: 2, name: "Ana", role: "operator", can_charge: true } })

      expect(await screen.findByRole("button", { name: "Cuenta / Cobrar" })).toBeEnabled()
      expect(screen.queryByRole("button", { name: /enviar a cocina/i })).not.toBeInTheDocument()
    })

    it("mientras hay algo sin enviar, «Enviar a cocina» ocupa el lugar de la cuenta en la barra", async () => {
      getOrderMock.mockResolvedValue(buildOrder())
      renderOrderPage(501, { "kitchen.view": true }, { employee: { id: 2, name: "Ana", role: "operator", can_charge: true } })

      expect(await screen.findByRole("button", { name: "Enviar a cocina · 1 ítem" })).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "Cuenta / Cobrar" })).not.toBeInTheDocument()
    })

    it("al enviar confirma en grande («Mesa 5 · 2 ítems enviados») y vuelve al mapa de mesas", async () => {
      getOrderMock.mockResolvedValue(buildOrder({ items: [buildOrderItem({ qty: 2 })] }))
      sendOrderMock.mockResolvedValue(buildOrder({ version: 2, items: [buildOrderItem({ qty: 2, status: "sent", round_no: 1 })] }))

      const user = userEvent.setup()
      renderOrderPage(501, { "kitchen.view": true, "pos.tables": true })

      await user.click(await screen.findByRole("button", { name: "Enviar a cocina · 2 ítems" }))

      await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("Mesa 5 · 2 ítems enviados", expect.anything()))
      expect(await screen.findByText("Mapa de mesas")).toBeInTheDocument()
    })

    it("«Enviar y quedarme» envía, confirma y se queda en la comanda", async () => {
      getOrderMock.mockResolvedValue(buildOrder())
      sendOrderMock.mockResolvedValue(buildOrder({ version: 2, items: [buildOrderItem({ status: "sent", round_no: 1 })] }))

      const user = userEvent.setup()
      renderOrderPage(501, { "kitchen.view": true, "pos.tables": true })

      await user.click(await screen.findByRole("button", { name: "Enviar y quedarme" }))

      await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("Mesa 5 · 1 ítem enviado", expect.anything()))
      expect(sendOrderMock).toHaveBeenCalledTimes(1)
      expect(screen.queryByText("Mapa de mesas")).not.toBeInTheDocument()
    })

    it("el cargo de domicilio no cuenta como plato para enviar ni se ofrece para marchar", async () => {
      getOrderMock.mockResolvedValue(
        buildOrder({
          channel: "delivery",
          tables: [],
          delivery: { address: "Calle 10 # 20-30", phone: "3001234567", courier: { id: 9, name: "Luis" } },
          items: [
            buildOrderItem({ id: 1, qty: 2 }),
            buildOrderItem({ id: 2, product_id: 99, name: "Domicilio", course: "main", station: null, is_delivery_fee: true }),
          ],
        }),
      )
      renderOrderPage(501, { "kitchen.view": true, "pos.courses": true })

      expect(await screen.findByRole("button", { name: "Enviar a cocina · 2 ítems" })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: /marchar bebida/i })).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: /marchar fuerte/i })).not.toBeInTheDocument()
    })
  })

  it("la carta muestra en la insignia de cada plato las unidades de la ronda sin enviar", async () => {
    getOrderMock.mockResolvedValue(
      buildOrder({
        items: [
          buildOrderItem({ id: 1, qty: 2 }),
          buildOrderItem({ id: 2, qty: 1, note: "sin hielo" }),
          // Enviado: ya no es de esta ronda, no suma a la insignia.
          buildOrderItem({ id: 3, qty: 5, status: "sent", round_no: 1 }),
        ],
      }),
    )
    const user = userEvent.setup()
    renderOrderPage(501, {})

    await user.click(await screen.findByRole("tab", { name: "Bebidas" }))
    expect(await screen.findByRole("button", { name: "Agregar Limonada de coco, 3 en la ronda" })).toBeInTheDocument()
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

  it("un plato listo se marca «Servido» desde la comanda, y «Marcar todo servido» sirve todos los listos", async () => {
    const listo1 = buildOrderItem({ id: 11, name: "Bandeja Paisa", status: "ready", round_no: 1, station: "hot_kitchen" })
    const listo2 = buildOrderItem({ id: 12, name: "Ajiaco", status: "ready", round_no: 1, station: "hot_kitchen" })
    const enviado = buildOrderItem({ id: 13, name: "Sancocho", status: "sent", round_no: 1, station: "hot_kitchen" })
    getOrderMock.mockResolvedValue(buildOrder({ items: [listo1, listo2, enviado] }))
    markServedMock.mockReset()
    markServedMock.mockImplementation(async (_orderId: number, itemId: number) =>
      buildOrder({
        items: [listo1, listo2, enviado].map((i) => (i.id === itemId ? { ...i, status: "served" as const } : i)),
      }),
    )

    const user = userEvent.setup()
    renderOrderPage(501, { "kitchen.view": true })

    await user.click(await screen.findByRole("button", { name: "Servido: Bandeja Paisa" }))
    await waitFor(() => expect(markServedMock).toHaveBeenCalledWith(501, 11, expect.any(String)))
    // Lo enviado y no listo no se ofrece para servir.
    expect(screen.queryByRole("button", { name: "Servido: Sancocho" })).not.toBeInTheDocument()

    markServedMock.mockClear()
    getOrderMock.mockResolvedValue(buildOrder({ items: [listo1, listo2, enviado] }))
    await user.click(await screen.findByRole("button", { name: /marcar todo servido/i }))
    await waitFor(() => expect(markServedMock).toHaveBeenCalledTimes(1))
    // En la comanda ya sólo quedaba un listo (Ajiaco): se sirve ése.
    expect(markServedMock).toHaveBeenCalledWith(501, 12, expect.any(String))
  })
})

describe("OrderPage · encabezado, cuenta y anulación", () => {
  it("el título es la mesa y sus comensales; el número de comanda queda de segunda línea", async () => {
    getOrderMock.mockResolvedValue(buildOrder({ covers: 2 }))
    renderOrderPage(501, {})

    expect(await screen.findByRole("heading", { level: 1, name: "Mesa 5 · 2 comensales" })).toBeInTheDocument()
    expect(screen.getByText(/comanda #501/i)).toBeInTheDocument()
  })

  it("quien no cobra ve «Pedir cuenta»: presenta la precuenta y ofrece volver a Mesas", async () => {
    getOrderMock.mockResolvedValue(buildOrder({ items: [buildOrderItem({ status: "sent", round_no: 1 })] }))
    presentBillMock.mockResolvedValue({
      order_id: 501,
      version: 2,
      legend: "Leyenda del servidor",
      lines: [{ description: "Limonada de coco", qty: 1, unit_price: 8000, gross: 8000, discount: 0, net: 8000 }],
      subtotal: 8000,
      discount_total: 0,
      tax_lines: [],
      tax_total: 593,
      total: 8000,
      tip: null,
      bill_presented_at: "2026-09-15T19:00:00Z",
      bill_print_count: 1,
    })

    const user = userEvent.setup()
    renderOrderPage(501, { "kitchen.view": true, "pos.pre_bill": true, "pos.tables": true })

    expect(screen.queryByRole("button", { name: /cuenta \/ cobrar/i })).not.toBeInTheDocument()
    await user.click(await screen.findByRole("button", { name: "Pedir cuenta" }))

    await waitFor(() => expect(presentBillMock).toHaveBeenCalledTimes(1))
    const dialog = await screen.findByRole("dialog", { name: /precuenta/i })
    expect(within(dialog).getByRole("button", { name: "Reimprimir" })).toBeInTheDocument()
    await user.click(within(dialog).getByRole("button", { name: "Listo · ir a Mesas" }))
    expect(await screen.findByText("Mapa de mesas")).toBeInTheDocument()
  })

  it("quien cobra sigue viendo «Cuenta / Cobrar»", async () => {
    getOrderMock.mockResolvedValue(buildOrder({ items: [buildOrderItem({ status: "sent", round_no: 1 })] }))
    renderOrderPage(501, { "pos.pre_bill": true }, { employee: { id: 7, name: "Caja", role: "operator", can_charge: true } })

    expect(await screen.findByRole("button", { name: "Cuenta / Cobrar" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Pedir cuenta" })).not.toBeInTheDocument()
  })

  it("anular lo ya enviado avisa que necesita PIN y, autorizado, borra el aviso rojo", async () => {
    const sent = buildOrderItem({ status: "sent", round_no: 1 })
    getOrderMock.mockResolvedValue(buildOrder({ items: [sent] }))
    voidItemMock
      .mockRejectedValueOnce(new ApiError(400, "AUTHORIZATION_REQUIRED", "Anular un ítem enviado necesita autorización"))
      .mockResolvedValueOnce(buildOrder({ version: 2, items: [{ ...sent, status: "voided" }] }))

    const user = userEvent.setup()
    renderOrderPage(501, {})

    const sheet = await openLine(user, /limonada de coco: acciones/i)
    await user.click(within(sheet).getByRole("button", { name: /^anular limonada de coco$/i }))
    const dialog = await screen.findByRole("dialog", { name: /anular limonada de coco/i })
    expect(within(dialog).getByText("Anular lo ya enviado necesita PIN de supervisor")).toBeInTheDocument()
    await user.click(within(dialog).getByRole("radio", { name: "Error de cocina" }))
    await user.click(within(dialog).getByRole("button", { name: /^anular$/i }))

    expect(await screen.findByText(/necesita autorización/i)).toBeInTheDocument()
    expect(await screen.findByRole("group", { name: /pin de supervisor o administrador/i })).toBeInTheDocument()
    for (const digit of ["1", "2", "3", "4"]) {
      await user.click(screen.getByRole("button", { name: `Dígito ${digit}` }))
    }

    await waitFor(() => expect(voidItemMock).toHaveBeenCalledTimes(2))
    expect(voidItemMock.mock.calls[1][2]).toMatchObject({ reason: "kitchen_error", authorizer_pin: "1234" })
    await waitFor(() => expect(screen.queryByText(/necesita autorización/i)).not.toBeInTheDocument())
  })
})
