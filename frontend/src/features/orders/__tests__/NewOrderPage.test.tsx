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

// CONTRATO C7: `@/api/channels` lo publica `frontend-kds-config`. Se mockea
// acá con la forma acordada (declarada en el entregable de este agente) para
// no depender de esa ruta real en este test de territorio.
const { listDevicePlatformsMock } = vi.hoisted(() => ({ listDevicePlatformsMock: vi.fn() }))
vi.mock("@/api/channels", () => ({ listDevicePlatforms: listDevicePlatformsMock }))

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

  it("domicilio exige dirección, teléfono y domiciliario, y manda el cargo lo pone el servidor", async () => {
    const created: OrderOut = buildOrder({ id: 91, channel: "delivery" })
    createOrderMock.mockResolvedValue(created)

    const user = userEvent.setup()
    renderWithProviders(<NewOrderPage />, { me: deviceMe({ "pos.delivery": true, "pos.takeout": true }) })

    await user.click(screen.getByRole("radio", { name: "Domicilio" }))
    await user.click(screen.getByRole("button", { name: /crear comanda/i }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/dirección y el teléfono/i)
    expect(createOrderMock).not.toHaveBeenCalled()

    await user.type(screen.getByLabelText("Dirección"), "Calle 10 # 20-30")
    await user.type(screen.getByLabelText("Teléfono"), "3001234567")
    await user.click(screen.getByRole("button", { name: /crear comanda/i }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/quién reparte/i)

    await user.click(screen.getByRole("button", { name: "Domiciliario" }))
    await user.click(screen.getByRole("button", { name: /crear comanda/i }))

    await waitFor(() =>
      expect(createOrderMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "delivery",
          delivery: { address: "Calle 10 # 20-30", phone: "3001234567", courier_employee_id: 77 },
        }),
      ),
    )
    // El cargo de domicilio no se manda como campo: no hay ni un monto ni
    // una plata en el body — lo agrega el servidor como ítem al crear.
    const [body] = createOrderMock.mock.calls[0]
    expect(body).not.toHaveProperty("delivery_fee")
    expect(body).not.toHaveProperty("delivery_charge")
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/pos/comanda/91"))
  })

  it("plataforma exige elegir plataforma y external_id, con el selector consumido de @/api/channels (C7)", async () => {
    listDevicePlatformsMock.mockResolvedValue([
      { id: 3, name: "Rappi", code: "rappi" },
      { id: 4, name: "Didi Food", code: "didi" },
    ])
    const created: OrderOut = buildOrder({ id: 92, channel: "platform" })
    createOrderMock.mockResolvedValue(created)

    const user = userEvent.setup()
    renderWithProviders(<NewOrderPage />, { me: deviceMe({ "pos.platforms": true }) })

    await user.click(screen.getByRole("radio", { name: "Plataforma" }))
    await user.click(screen.getByRole("button", { name: /crear comanda/i }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/elegí la plataforma/i)
    expect(createOrderMock).not.toHaveBeenCalled()

    await user.click(await screen.findByLabelText("Plataforma"))
    await user.click(await screen.findByRole("option", { name: "Rappi" }))
    await user.click(screen.getByRole("button", { name: /crear comanda/i }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/número del pedido/i)

    await user.type(screen.getByLabelText("Número de pedido en la plataforma"), "RP-778899")
    await user.click(screen.getByRole("button", { name: /crear comanda/i }))

    await waitFor(() =>
      expect(createOrderMock).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "platform", platform: { platform_id: 3, external_id: "RP-778899" } }),
      ),
    )
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/pos/comanda/92"))
  })
})
