import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { TipDistributionProposalOut, TipPayoutOut, TipsBalanceOut, TipsSettingsOut } from "@/api/payroll"
import { renderWithProviders } from "@/test/utils"

import { TipsTab } from "../TipsTab"

const {
  getTipsDistributionProposalMock,
  getTipsSettingsMock,
  updateTipsSettingsMock,
  createTipPayoutMock,
  getTipsBalanceMock,
  getTipPayoutsMock,
  reverseTipPayoutMock,
} = vi.hoisted(() => ({
  getTipsDistributionProposalMock: vi.fn(),
  getTipsSettingsMock: vi.fn(),
  updateTipsSettingsMock: vi.fn(),
  createTipPayoutMock: vi.fn(),
  getTipsBalanceMock: vi.fn(),
  getTipPayoutsMock: vi.fn(),
  reverseTipPayoutMock: vi.fn(),
}))

vi.mock("@/api/payroll", async () => {
  const actual = await vi.importActual<typeof import("@/api/payroll")>("@/api/payroll")
  return {
    ...actual,
    getTipsDistributionProposal: getTipsDistributionProposalMock,
    getTipsSettings: getTipsSettingsMock,
    updateTipsSettings: updateTipsSettingsMock,
    createTipPayout: createTipPayoutMock,
    getTipsBalance: getTipsBalanceMock,
    getTipPayouts: getTipPayoutsMock,
    reverseTipPayout: reverseTipPayoutMock,
  }
})

const BALANCE: TipsBalanceOut = {
  date_from: "2026-09-13",
  date_to: "2026-09-20",
  collected: 50_000,
  paid: 10_000,
  pending: 40_000,
  overpaid: 0,
  fully_delivered: false,
  shifts: [],
}

beforeEach(() => {
  getTipsBalanceMock.mockReset()
  getTipPayoutsMock.mockReset()
  reverseTipPayoutMock.mockReset()
  getTipsBalanceMock.mockResolvedValue(BALANCE)
  getTipPayoutsMock.mockResolvedValue([])
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

    // Desde c3 hay otros avisos vivos en la pestaña (el historial cuenta
    // repartos): se busca el de la propuesta entre ellos.
    const banners = await screen.findAllByRole("status")
    expect(banners.some((b) => /es una\s*propuesta/i.test(b.textContent ?? ""))).toBe(true)
    expect(await screen.findByText("$ 60.000")).toBeInTheDocument()
    // El total del servidor, dos veces y el mismo: como cifra protagonista
    // arriba de la tabla y en su pie.
    expect(screen.getByTestId("tips-total")).toHaveTextContent("$ 90.000")
    expect(screen.getAllByText("$ 90.000")).toHaveLength(2)
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

describe("A-3 — de dónde salió la plata de un reparto en efectivo", () => {
  it("con efectivo lo pregunta, y el body lo manda", async () => {
    // Sin este dato, `owner_hand` restaba de la mano del dueño una plata que
    // ya había salido por el `to_deposit` del turno: la misma plata dos veces.
    getTipsSettingsMock.mockResolvedValue(SETTINGS)
    getTipsDistributionProposalMock.mockResolvedValue(PROPOSAL)
    createTipPayoutMock.mockResolvedValue({
      id: 1, shift_ids: [11, 12], paid_at: "2026-09-20T10:00", method: "cash",
      paid_from: "drawer", total_amount: 90_000, created_at: "2026-09-20T10:00:00Z", distribution: [],
    })

    const user = userEvent.setup()
    renderWithProviders(<TipsTab storeId={1} />)
    await screen.findByText("$ 60.000")
    await user.click(screen.getByRole("button", { name: "Confirmar reparto" }))

    // El método arranca en efectivo, así que la pregunta tiene que estar.
    const origen = screen.getByLabelText("¿De dónde salió la plata?")
    expect(origen).toBeInTheDocument()

    await user.click(origen)
    await user.click(await screen.findByRole("option", { name: /Del cajón/i }))
    await user.click(screen.getByRole("button", { name: "Registrar entrega" }))

    await waitFor(() => expect(createTipPayoutMock).toHaveBeenCalledTimes(1))
    const [, body] = createTipPayoutMock.mock.calls[0]!
    expect(body.paid_from).toBe("drawer")
    expect(body.method).toBe("cash")
  })

  it("con transferencia NO lo pregunta: ahí no significa nada", async () => {
    getTipsSettingsMock.mockResolvedValue(SETTINGS)
    getTipsDistributionProposalMock.mockResolvedValue(PROPOSAL)

    const user = userEvent.setup()
    renderWithProviders(<TipsTab storeId={1} />)
    await screen.findByText("$ 60.000")
    await user.click(screen.getByRole("button", { name: "Confirmar reparto" }))

    await user.click(screen.getByLabelText("Método"))
    await user.click(await screen.findByRole("option", { name: /Transferencia/i }))

    expect(screen.queryByLabelText("¿De dónde salió la plata?")).not.toBeInTheDocument()
  })
})

describe("c3 — recogido, entregado y pendiente, con la prueba del 100 % entregado", () => {
  const PAYOUT: TipPayoutOut = {
    id: 7,
    shift_ids: [11],
    paid_at: "2026-09-20T20:00:00Z",
    method: "cash",
    paid_from: "owner_hand",
    total_amount: 10_000,
    created_at: "2026-09-20T20:00:00Z",
    distribution: [{ employee_id: 1, employee_name: "Ana", amount: 10_000 }],
    reversed_at: null,
  }

  it("pinta las tres cifras tal como llegan y dice cuánto falta entregar", async () => {
    getTipsSettingsMock.mockResolvedValue(SETTINGS)
    getTipsDistributionProposalMock.mockResolvedValue(PROPOSAL)
    renderWithProviders(<TipsTab storeId={1} />)

    expect(await screen.findByText("$ 50.000")).toBeInTheDocument()
    expect(screen.getAllByText("$ 40.000").length).toBeGreaterThan(0)
    expect(screen.getByTestId("tips-delivered-check")).toHaveTextContent(/Falta entregar/)
  })

  it("con todo entregado muestra el «100 % entregado» y no ofrece confirmar otra vez", async () => {
    getTipsSettingsMock.mockResolvedValue(SETTINGS)
    getTipsDistributionProposalMock.mockResolvedValue(PROPOSAL)
    getTipsBalanceMock.mockResolvedValue({ ...BALANCE, paid: 50_000, pending: 0, fully_delivered: true })
    renderWithProviders(<TipsTab storeId={1} />)

    expect(await screen.findByTestId("tips-delivered-check")).toHaveTextContent("100 % entregado")
    await screen.findByText("$ 60.000")
    expect(screen.queryByRole("button", { name: "Confirmar reparto" })).not.toBeInTheDocument()
  })

  it("sin turnos cerrados no afirma nada: null no es «entregado»", async () => {
    getTipsSettingsMock.mockResolvedValue(SETTINGS)
    getTipsDistributionProposalMock.mockResolvedValue(PROPOSAL)
    getTipsBalanceMock.mockResolvedValue({ ...BALANCE, collected: 0, paid: 0, pending: 0, fully_delivered: null })
    renderWithProviders(<TipsTab storeId={1} />)

    const check = await screen.findByTestId("tips-delivered-check")
    expect(check).toHaveTextContent(/No hay turnos cerrados/)
    expect(check).not.toHaveTextContent("100 % entregado")
  })

  it("el historial permite reversar un reparto con motivo", async () => {
    getTipsSettingsMock.mockResolvedValue(SETTINGS)
    getTipsDistributionProposalMock.mockResolvedValue(PROPOSAL)
    getTipPayoutsMock.mockResolvedValue([PAYOUT])
    reverseTipPayoutMock.mockResolvedValue({ ...PAYOUT, reversed_at: "2026-09-21T10:00:00Z", reversed_reason: "Duplicado" })

    const user = userEvent.setup()
    renderWithProviders(<TipsTab storeId={1} />)

    await user.click(await screen.findByRole("button", { name: "Reversar" }))
    const confirm = await screen.findByRole("button", { name: "Reversar reparto" })
    expect(confirm).toBeDisabled()
    await user.type(screen.getByLabelText("Motivo"), "Duplicado")
    await user.click(confirm)

    await waitFor(() => expect(reverseTipPayoutMock).toHaveBeenCalledTimes(1))
    const [storeId, payoutId, body, key] = reverseTipPayoutMock.mock.calls[0]!
    expect([storeId, payoutId, body]).toEqual([1, 7, { reason: "Duplicado" }])
    expect(typeof key).toBe("string")
  })
})
