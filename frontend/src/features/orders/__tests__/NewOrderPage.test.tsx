import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { OrderOut } from "@/api/orders"
import { renderWithProviders } from "@/test/utils"

import { NewOrderPage } from "../NewOrderPage"
import { buildOrder, deviceMe } from "./fixtures"

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }))

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom")
  return { ...actual, useNavigate: () => navigateMock }
})

const { createOrderMock } = vi.hoisted(() => ({ createOrderMock: vi.fn() }))

vi.mock("@/api/orders", async () => {
  const actual = await vi.importActual<typeof import("@/api/orders")>("@/api/orders")
  return { ...actual, createOrder: createOrderMock }
})

// `EmployeePicker` es territorio de `frontend-cobro`: se mockea acá tal como
// pide la misión, para no depender de `GET /device/employees` en este test.
vi.mock("@/components/EmployeePicker", () => ({
  EmployeePicker: ({ onChange, label }: { onChange: (id: number, employee: unknown) => void; label: string }) => (
    <button type="button" onClick={() => onChange(77, { id: 77, name: "Marta", role: "operator" })}>
      {label}
    </button>
  ),
}))

describe("NewOrderPage", () => {
  it("sólo ofrece los canales habilitados por flag", () => {
    renderWithProviders(<NewOrderPage />, {
      me: deviceMe({ "pos.counter": true, "pos.tables": false, "pos.takeout": false, "pos.staff_meal": false }),
    })

    expect(screen.getByRole("radio", { name: "Mostrador" })).toBeInTheDocument()
    expect(screen.queryByRole("radio", { name: "Mesa" })).not.toBeInTheDocument()
    expect(screen.queryByRole("radio", { name: "Para llevar" })).not.toBeInTheDocument()
    expect(screen.queryByRole("radio", { name: "Consumo de personal" })).not.toBeInTheDocument()
  })

  it("mostrador crea la comanda y navega a la comanda nueva", async () => {
    const created: OrderOut = buildOrder({ id: 42, channel: "counter" })
    createOrderMock.mockResolvedValue(created)

    const user = userEvent.setup()
    renderWithProviders(<NewOrderPage />, { me: deviceMe({ "pos.counter": true }) })

    await user.click(screen.getByRole("radio", { name: "Mostrador" }))
    await user.click(screen.getByRole("button", { name: /crear comanda/i }))

    await waitFor(() => expect(createOrderMock).toHaveBeenCalledWith(expect.objectContaining({ channel: "counter" })))
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/pos/comanda/42"))
  })

  it("para llevar exige nombre del cliente", async () => {
    const user = userEvent.setup()
    renderWithProviders(<NewOrderPage />, { me: deviceMe({ "pos.takeout": true }) })

    await user.click(screen.getByRole("radio", { name: "Para llevar" }))
    await user.click(screen.getByRole("button", { name: /crear comanda/i }))

    expect(await screen.findByRole("alert")).toHaveTextContent(/nombre del cliente/i)
    expect(createOrderMock).not.toHaveBeenCalled()
  })

  it("consumo de personal usa EmployeePicker para elegir quién consume", async () => {
    const created: OrderOut = buildOrder({ id: 88, channel: "staff_meal" })
    createOrderMock.mockResolvedValue(created)

    const user = userEvent.setup()
    renderWithProviders(<NewOrderPage />, { me: deviceMe({ "pos.staff_meal": true }) })

    await user.click(screen.getByRole("radio", { name: "Consumo de personal" }))
    await user.click(screen.getByRole("button", { name: /¿quién consume\?/i }))
    await user.click(screen.getByRole("button", { name: /crear comanda/i }))

    await waitFor(() =>
      expect(createOrderMock).toHaveBeenCalledWith(expect.objectContaining({ channel: "staff_meal", consumed_by_employee_id: 77 })),
    )
  })
})
