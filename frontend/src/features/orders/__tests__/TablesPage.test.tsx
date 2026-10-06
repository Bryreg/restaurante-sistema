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

  it("una mesa con platos listos lo dice en el mapa («N listos»), con el conteo del servidor", async () => {
    const base = buildTablesStatus()
    const zone = base.zones![0]!
    listTablesStatusMock.mockResolvedValue({
      zones: [
        {
          ...zone,
          tables: (zone.tables ?? []).map((t) => (t.id === 2 ? { ...t, ready_count: 2 } : { ...t, ready_count: 0 })),
        },
      ],
    })

    renderWithProviders(<TablesPage />, { me: deviceMe({ "pos.tables": true }) })

    const mesa = await screen.findByRole("button", { name: /mesa 2, ocupada, 2 listos para servir/i })
    expect(within(mesa).getByText("2 listos")).toBeInTheDocument()
    expect(screen.queryByText(/0 listos/)).not.toBeInTheDocument()
  })

  it("aviso de plato listo: cuando a una mesa le llega algo nuevo de cocina sale arriba, con botón para ir", async () => {
    const base = buildTablesStatus()
    const zone = base.zones![0]!
    const withReady = (n: number) => ({
      zones: [{ ...zone, tables: (zone.tables ?? []).map((t) => ({ ...t, ready_count: t.id === 2 ? n : 0 })) }],
    })
    // La primera lectura es la base: lo que ya estaba listo no avisa.
    listTablesStatusMock.mockResolvedValue(withReady(1))

    const user = userEvent.setup()
    renderWithProviders(<TablesPage />, { me: deviceMe({ "pos.tables": true }) })
    await screen.findByRole("button", { name: /mesa 2, ocupada, 1 listo para servir/i })
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()

    // La lectura siguiente (Mesas consulta cada 5 s) trae uno más.
    listTablesStatusMock.mockResolvedValue(withReady(2))
    const aviso = await screen.findByRole("alert", {}, { timeout: 8000 })
    expect(aviso).toHaveTextContent("Mesa 2: 2 platos listos para servir")
    const orderId = (zone.tables ?? []).find((t) => t.id === 2)?.order_id
    await user.click(within(aviso).getByRole("button", { name: "Ir a la mesa 2" }))
    expect(navigateMock).toHaveBeenCalledWith(`/pos/comanda/${orderId}`)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  }, 15_000)

  it("una mesa con ítems sin enviar lo dice en el mapa, con iniciales de quien la atiende y fondo por estado", async () => {
    const base = buildTablesStatus()
    const zone = base.zones![0]!
    listTablesStatusMock.mockResolvedValue({
      zones: [
        {
          ...zone,
          tables: (zone.tables ?? []).map((t) =>
            t.id === 2 ? { ...t, unsent_count: 3, opened_by: { id: 2, name: "Ana María" } } : t,
          ),
        },
      ],
    })

    renderWithProviders(<TablesPage />, { me: deviceMe({ "pos.tables": true }) })

    const mesa = await screen.findByRole("button", { name: /mesa 2, ocupada, 3 sin enviar, atiende ana maría/i })
    expect(within(mesa).getByText("3 sin enviar")).toBeInTheDocument()
    expect(within(mesa).getByText("AM")).toBeInTheDocument()
    // Motivo del cambio: el handoff (`PosMesas`) fija la ocupada en `primary`
    // al 12 % con borde al 45 % (antes 10 % / 40 %). Sigue siendo el token
    // del tema, nunca un color crudo.
    expect(mesa.className).toMatch(/bg-primary\/12/)
    expect(mesa.className).toMatch(/border-primary\/45/)
    expect(screen.getByRole("button", { name: /mesa 3, por cobrar/i }).className).toMatch(/bg-warning/)
    expect(screen.getByRole("button", { name: /mesa 1, libre/i }).className).toMatch(/bg-card/)
  })

  it("la leyenda cuenta las mesas por estado y cada tarjeta dice su estado con palabra, comensales · minutos y total", async () => {
    listTablesStatusMock.mockResolvedValue(buildTablesStatus())

    renderWithProviders(<TablesPage />, { me: deviceMe({ "pos.tables": true }) })

    await screen.findByRole("button", { name: /mesa 1, libre/i })
    expect(screen.getByText("Libre 1")).toBeInTheDocument()
    expect(screen.getByText("Ocupada 1")).toBeInTheDocument()
    expect(screen.getByText("Por cobrar 1")).toBeInTheDocument()

    const libre = screen.getByRole("button", { name: /mesa 1, libre/i })
    expect(within(libre).getByText("Libre")).toBeInTheDocument()
    expect(within(libre).getByText("4 puestos")).toBeInTheDocument()
    expect(libre.className).toMatch(/min-h-\[128px\]/)

    const ocupada = screen.getByRole("button", { name: /mesa 2, ocupada/i })
    expect(within(ocupada).getByText("Ocupada")).toBeInTheDocument()
    // El total es el del servidor, tal cual.
    expect(within(ocupada).getByText("$ 25.000")).toBeInTheDocument()
    expect(within(ocupada).getByText(/^2 · \d+ (h \d+ )?min$/)).toBeInTheDocument()
  })

  it("«Mover / unir» es un solo botón que ofrece las dos cosas", async () => {
    listTablesStatusMock.mockResolvedValue(buildTablesStatus())
    const user = userEvent.setup()

    renderWithProviders(<TablesPage />, { me: deviceMe({ "pos.tables": true }) })

    await screen.findByRole("button", { name: /mesa 1, libre/i })
    await user.click(screen.getByRole("button", { name: /mover \/ unir/i }))
    await user.click(await screen.findByRole("menuitem", { name: "Unir mesas" }))

    expect(await screen.findByText(/tocá las mesas ocupadas que querés unir/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /mesa 2, ocupada/i })).toHaveAttribute("aria-pressed", "false")
  })

  it("«Mis mesas» deja las que abrió quien está identificado, más las libres", async () => {
    const base = buildTablesStatus()
    const zone = base.zones![0]!
    listTablesStatusMock.mockResolvedValue({
      zones: [
        {
          ...zone,
          tables: (zone.tables ?? []).map((t) =>
            t.id === 2 ? { ...t, opened_by: { id: 2, name: "Ana" } } : t.id === 3 ? { ...t, opened_by: { id: 8, name: "Beto" } } : t,
          ),
        },
      ],
    })

    const user = userEvent.setup()
    renderWithProviders(<TablesPage />, { me: deviceMe({ "pos.tables": true }) })

    await screen.findByRole("button", { name: /mesa 3, por cobrar/i })
    const filtro = screen.getByRole("button", { name: "Mis mesas" })
    await user.click(filtro)

    expect(filtro).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: /mesa 1, libre/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /mesa 2, ocupada/i })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /mesa 3/i })).not.toBeInTheDocument()
  })
})
