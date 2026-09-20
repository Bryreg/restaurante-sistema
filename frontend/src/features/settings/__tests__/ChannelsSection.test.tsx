import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { buildMe, renderWithProviders } from "@/test/utils"
import type { PlatformOut } from "@/api/channels"

import { ChannelsSection } from "../ChannelsSection"

const { listPlatformsMock, createPlatformMock, updatePlatformMock, deactivatePlatformMock } = vi.hoisted(() => ({
  listPlatformsMock: vi.fn(),
  createPlatformMock: vi.fn(),
  updatePlatformMock: vi.fn(),
  deactivatePlatformMock: vi.fn(),
}))

vi.mock("@/api/channels", async () => {
  const actual = await vi.importActual<typeof import("@/api/channels")>("@/api/channels")
  return {
    ...actual,
    listPlatforms: listPlatformsMock,
    createPlatform: createPlatformMock,
    updatePlatform: updatePlatformMock,
    deactivatePlatform: deactivatePlatformMock,
  }
})

const RAPPI: PlatformOut = {
  id: 1,
  store_id: 1,
  name: "Rappi",
  code: "rappi",
  commission_bp: 1800,
  active: true,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
}

const ENABLED_ME = buildMe({ features: { "pos.platforms": true } })

describe("ChannelsSection — Configuración → Canales y plataformas (§9.3, pedido 2c)", () => {
  it("sin sede elegida pide elegir una sede y no pide plataformas", () => {
    renderWithProviders(<ChannelsSection storeId={null} />, { me: ENABLED_ME })

    expect(screen.getByText(/elegí una sede/i)).toBeInTheDocument()
    expect(listPlatformsMock).not.toHaveBeenCalled()
  })

  it("con pos.platforms apagada, la sección de plataformas no aparece (EmptyState en su lugar)", () => {
    renderWithProviders(<ChannelsSection storeId={1} />, { me: buildMe({ features: { "pos.platforms": false } }) })

    expect(screen.getByText(/plataformas no está habilitado/i)).toBeInTheDocument()
    expect(listPlatformsMock).not.toHaveBeenCalled()
  })

  it("lista las plataformas con la comisión formateada en % (100 = 1 %, nunca bp crudo)", async () => {
    listPlatformsMock.mockResolvedValue([RAPPI])

    renderWithProviders(<ChannelsSection storeId={1} />, { me: ENABLED_ME })

    await waitFor(() => expect(screen.getByText("Rappi")).toBeInTheDocument())
    expect(screen.getByText("18 %")).toBeInTheDocument()
    expect(listPlatformsMock).toHaveBeenCalledWith(1, { active: true })
  })

  it("crear una plataforma convierte el % tecleado a puntos básicos enteros (18 → 1800)", async () => {
    listPlatformsMock.mockResolvedValue([])
    createPlatformMock.mockResolvedValue(RAPPI)

    const user = userEvent.setup()
    renderWithProviders(<ChannelsSection storeId={1} />, { me: ENABLED_ME })

    await waitFor(() => expect(screen.getByText(/todavía no hay plataformas/i)).toBeInTheDocument())

    await user.click(screen.getByRole("button", { name: /nueva plataforma/i }))
    await user.type(screen.getByLabelText(/^nombre$/i), "Rappi")
    await user.type(screen.getByLabelText(/^código$/i), "rappi")
    await user.type(screen.getByLabelText(/comisión/i), "18")
    await user.click(screen.getByRole("button", { name: /^crear$/i }))

    await waitFor(() =>
      expect(createPlatformMock).toHaveBeenCalledWith(1, { name: "Rappi", code: "rappi", commission_bp: 1800 }),
    )
  })

  it("desactivar es baja lógica: llama deactivatePlatform, nunca borra la fila", async () => {
    listPlatformsMock.mockResolvedValue([RAPPI])
    deactivatePlatformMock.mockResolvedValue({ ...RAPPI, active: false })

    const user = userEvent.setup()
    renderWithProviders(<ChannelsSection storeId={1} />, { me: ENABLED_ME })

    await waitFor(() => expect(screen.getByText("Rappi")).toBeInTheDocument())
    await user.click(screen.getByRole("button", { name: /desactivar/i }))

    await waitFor(() => expect(deactivatePlatformMock).toHaveBeenCalledWith(1, 1))
  })

  it("señala dónde se activan mesa/para llevar/mostrador y dónde domicilio/plataforma, sin duplicar la casilla", () => {
    listPlatformsMock.mockResolvedValue([])
    renderWithProviders(<ChannelsSection storeId={1} />, { me: ENABLED_ME })

    expect(screen.getByText(/pos\.delivery/)).toBeInTheDocument()
    expect(screen.getByText(/pos\.platforms/)).toBeInTheDocument()
  })

  it("apunta a la pestaña Ventas para estaciones, cursos y tiempos objetivo — no construye una segunda pantalla", () => {
    listPlatformsMock.mockResolvedValue([])
    renderWithProviders(<ChannelsSection storeId={1} />, { me: ENABLED_ME })

    expect(screen.getByText(/estaciones, cursos y tiempos objetivo/i)).toBeInTheDocument()
    expect(screen.getByText(/ya se editan en la pestaña/i)).toBeInTheDocument()
  })
})
