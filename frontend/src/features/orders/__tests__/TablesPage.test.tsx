import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { OrderOut } from "@/api/orders"
import { renderWithProviders } from "@/test/utils"

import { TablesPage } from "../TablesPage"
import { buildOrder, buildTablesStatus, deviceMe } from "./fixtures"

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }))

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom")
  return { ...actual, useNavigate: () => navigateMock }
})

const { listTablesStatusMock, createOrderMock } = vi.hoisted(() => ({
  listTablesStatusMock: vi.fn(),
  createOrderMock: vi.fn(),
}))

vi.mock("@/api/orders", async () => {
  const actual = await vi.importActual<typeof import("@/api/orders")>("@/api/orders")
  return {
    ...actual,
    listTablesStatus: listTablesStatusMock,
    createOrder: createOrderMock,
  }
})

describe("TablesPage", () => {
  it("sin pos.tables muestra el mensaje de función apagada y no llama a la API", () => {
    renderWithProviders(<TablesPage />, { me: deviceMe({ "pos.tables": false }) })

    expect(screen.getByText(/las mesas no están habilitadas/i)).toBeInTheDocument()
    expect(listTablesStatusMock).not.toHaveBeenCalled()
  })

  it("con pos.tables pinta el mapa por zona con libre / ocupada / por cobrar", async () => {
    listTablesStatusMock.mockResolvedValue(buildTablesStatus())

    renderWithProviders(<TablesPage />, { me: deviceMe({ "pos.tables": true }) })

    await waitFor(() => expect(screen.getByText("Mesa 1")).toBeInTheDocument())
    expect(screen.getByRole("button", { name: /mesa 1, libre/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /mesa 2, ocupada/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /mesa 3, por cobrar/i })).toBeInTheDocument()
  })

  it("abrir una mesa libre crea la comanda dine_in y navega a la comanda", async () => {
    listTablesStatusMock.mockResolvedValue(buildTablesStatus())
    const created: OrderOut = buildOrder({ id: 999, channel: "dine_in" })
    createOrderMock.mockResolvedValue(created)

    const user = userEvent.setup()
    renderWithProviders(<TablesPage />, { me: deviceMe({ "pos.tables": true }) })

    await waitFor(() => expect(screen.getByText("Mesa 1")).toBeInTheDocument())
    await user.click(screen.getByRole("button", { name: /mesa 1, libre/i }))

    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByRole("button", { name: /abrir mesa/i }))

    await waitFor(() => expect(createOrderMock).toHaveBeenCalledWith(expect.objectContaining({ channel: "dine_in", table_ids: [1] })))
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/pos/comanda/999"))
  })
})
