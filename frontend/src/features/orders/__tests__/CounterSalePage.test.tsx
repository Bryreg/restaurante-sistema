import { screen, waitFor } from "@testing-library/react"
import { Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { renderWithProviders } from "@/test/utils"

import { CounterSalePage } from "../CounterSalePage"
import { buildOrder, buildOrderItem, deviceMe } from "./fixtures"

const { listOrdersMock, createOrderMock } = vi.hoisted(() => ({
  listOrdersMock: vi.fn(),
  createOrderMock: vi.fn(),
}))

vi.mock("@/api/orders", async () => {
  const actual = await vi.importActual<typeof import("@/api/orders")>("@/api/orders")
  return { ...actual, listOrders: listOrdersMock, createOrder: createOrderMock }
})

function renderCounter(features: Record<string, boolean>) {
  return renderWithProviders(
    <Routes>
      <Route path="/pos/mostrador" element={<CounterSalePage />} />
      <Route path="/pos/comanda/:orderId" element={<p>Comanda abierta</p>} />
    </Routes>,
    { me: deviceMe(features), route: "/pos/mostrador" },
  )
}

beforeEach(() => {
  listOrdersMock.mockReset()
  createOrderMock.mockReset()
})

describe("CounterSalePage («Mostrador» en la barra)", () => {
  it("abre una venta de mostrador directo y aterriza en la comanda, sin selector de canal", async () => {
    listOrdersMock.mockResolvedValue([])
    createOrderMock.mockResolvedValue(buildOrder({ id: 77, channel: "counter", tables: [], items: [] }))

    renderCounter({ "pos.counter": true })

    expect(await screen.findByText("Comanda abierta")).toBeInTheDocument()
    expect(createOrderMock).toHaveBeenCalledTimes(1)
    expect(createOrderMock).toHaveBeenCalledWith({ channel: "counter" })
    expect(listOrdersMock).toHaveBeenCalledWith({ status: "open", channel: "counter" })
  })

  it("reusa la comanda de mostrador vacía que la misma persona dejó abierta, en vez de abrir otra", async () => {
    listOrdersMock.mockResolvedValue([
      // De otra persona: no se toca.
      buildOrder({ id: 60, channel: "counter", tables: [], items: [], opened_by: { id: 9, name: "Beto" } }),
      // Propia pero con algo cargado: tampoco.
      buildOrder({ id: 61, channel: "counter", tables: [], items: [buildOrderItem()], opened_by: { id: 2, name: "Ana" } }),
      buildOrder({ id: 62, channel: "counter", tables: [], items: [], opened_by: { id: 2, name: "Ana" } }),
    ])

    renderCounter({ "pos.counter": true })

    expect(await screen.findByText("Comanda abierta")).toBeInTheDocument()
    expect(createOrderMock).not.toHaveBeenCalled()
  })

  it("si el servidor rechaza, lo dice y ofrece reintentar", async () => {
    listOrdersMock.mockResolvedValue([])
    createOrderMock.mockRejectedValueOnce(new Error("Esta sede no vende por mostrador"))

    renderCounter({ "pos.counter": true })

    expect(await screen.findByRole("alert")).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole("button", { name: "Reintentar" })).toBeInTheDocument())
  })

  it("con la función apagada no crea nada y manda a «Nuevo pedido»", () => {
    renderCounter({ "pos.counter": false })

    expect(screen.getByText(/la venta de mostrador no está habilitada/i)).toBeInTheDocument()
    expect(listOrdersMock).not.toHaveBeenCalled()
    expect(createOrderMock).not.toHaveBeenCalled()
  })
})
