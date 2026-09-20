import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { TipDistributionProposalOut, TipsSettingsOut } from "@/api/payroll"
import { renderWithProviders } from "@/test/utils"

import { TipsTab } from "../TipsTab"

const { getTipsDistributionProposalMock, getTipsSettingsMock, updateTipsSettingsMock, createTipPayoutMock } = vi.hoisted(() => ({
  getTipsDistributionProposalMock: vi.fn(),
  getTipsSettingsMock: vi.fn(),
  updateTipsSettingsMock: vi.fn(),
  createTipPayoutMock: vi.fn(),
}))

vi.mock("@/api/payroll", async () => {
  const actual = await vi.importActual<typeof import("@/api/payroll")>("@/api/payroll")
  return {
    ...actual,
    getTipsDistributionProposal: getTipsDistributionProposalMock,
    getTipsSettings: getTipsSettingsMock,
    updateTipsSettings: updateTipsSettingsMock,
    createTipPayout: createTipPayoutMock,
  }
})

const SETTINGS: TipsSettingsOut = { method: "by_hours" }

const PROPOSAL: TipDistributionProposalOut = {
  method: "by_hours",
  total: 90_000,
  available: true,
  reason: null,
  rows: [
    { employee_id: 1, employee_name: "Ana", basis: "8 h", amount: 60_000 },
    { employee_id: 2, employee_name: "Beto", basis: "4 h", amount: 30_000 },
  ],
  shift_ids: [11, 12],
}

describe("TipsTab — D-3: la propuesta NUNCA mueve plata sola", () => {
  it('dice explícitamente "propuesta" y muestra el total y las filas tal como llegan', async () => {
    getTipsSettingsMock.mockResolvedValue(SETTINGS)
    getTipsDistributionProposalMock.mockResolvedValue(PROPOSAL)

    renderWithProviders(<TipsTab storeId={1} />)

    const banner = await screen.findByRole("status")
    expect(banner.textContent).toMatch(/es una\s*propuesta/i)
    expect(await screen.findByText("$ 60.000")).toBeInTheDocument()
    expect(screen.getByText("$ 90.000")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Confirmar reparto" })).toBeInTheDocument()
  })

  it('con `available: false`, muestra el motivo del servidor, nunca una tabla vacía muda', async () => {
    getTipsSettingsMock.mockResolvedValue(SETTINGS)
    getTipsDistributionProposalMock.mockResolvedValue({ ...PROPOSAL, available: false, reason: "No hay turnos cerrados en este período.", rows: [] })

    renderWithProviders(<TipsTab storeId={1} />)

    expect(await screen.findByText("Propuesta no disponible")).toBeInTheDocument()
    expect(screen.getByText("No hay turnos cerrados en este período.")).toBeInTheDocument()
  })

  it("sin shift_ids en la propuesta, no ofrece «confirmar» y lo declara como gap en pantalla", async () => {
    getTipsSettingsMock.mockResolvedValue(SETTINGS)
    getTipsDistributionProposalMock.mockResolvedValue({ ...PROPOSAL, shift_ids: undefined })

    renderWithProviders(<TipsTab storeId={1} />)

    await screen.findByText("$ 60.000")
    expect(screen.queryByRole("button", { name: "Confirmar reparto" })).not.toBeInTheDocument()
    expect(screen.getByText(/no informó los turnos que cubre/)).toBeInTheDocument()
  })

  it("confirmar el reparto llama a createTipPayout (POST /admin/tips/payouts, ya existente) con los turnos y el reparto exactos", async () => {
    getTipsSettingsMock.mockResolvedValue(SETTINGS)
    getTipsDistributionProposalMock.mockResolvedValue(PROPOSAL)
    createTipPayoutMock.mockResolvedValue({ id: 1, shift_ids: [11, 12], paid_at: "2026-09-20T10:00", method: "cash", total_amount: 90_000, created_at: "2026-09-20T10:00:00Z", distribution: [] })

    const user = userEvent.setup()
    renderWithProviders(<TipsTab storeId={1} />)

    await screen.findByText("$ 60.000")
    await user.click(screen.getByRole("button", { name: "Confirmar reparto" }))
    await user.click(screen.getByRole("button", { name: "Registrar entrega" }))

    await waitFor(() => expect(createTipPayoutMock).toHaveBeenCalledTimes(1))
    const [, body] = createTipPayoutMock.mock.calls[0]!
    expect(body.shift_ids).toEqual([11, 12])
    expect(body.distribution).toEqual([
      { employee_id: 1, amount: 60_000 },
      { employee_id: 2, amount: 30_000 },
    ])
    expect(await screen.findByText(/Entrega registrada/)).toBeInTheDocument()
  })

  it("el selector de método de reparto (portal) se abre y ofrece los tres métodos de D-3", async () => {
    getTipsSettingsMock.mockResolvedValue(SETTINGS)
    getTipsDistributionProposalMock.mockResolvedValue(PROPOSAL)

    const user = userEvent.setup()
    renderWithProviders(<TipsTab storeId={1} />)

    await user.click(await screen.findByRole("combobox", { name: "Método de reparto de propinas" }))
    // Regla de los portales: esperar la primera opción con `findByRole` antes de listar todas.
    await screen.findByRole("option", { name: "Por horas trabajadas" })
    const options = screen.getAllByRole("option")
    expect(options.map((o) => o.textContent)).toEqual(
      expect.arrayContaining(["Por horas trabajadas", "Partes iguales", "Por área"]),
    )
  })
})
