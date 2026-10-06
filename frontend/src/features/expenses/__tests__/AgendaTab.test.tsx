import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { AgendaOut } from "@/api/expenses"
import { renderWithProviders } from "@/test/utils"

import { AgendaTab } from "../AgendaTab"

const { getAgendaMock } = vi.hoisted(() => ({ getAgendaMock: vi.fn() }))

vi.mock("@/api/expenses", async () => {
  const actual = await vi.importActual<typeof import("@/api/expenses")>("@/api/expenses")
  return { ...actual, getAgenda: getAgendaMock }
})

const AGENDA: AgendaOut = {
  store_id: 1,
  today: "2026-03-10",
  days: 30,
  horizon: "2026-04-09",
  items: [
    {
      obligation_id: 1,
      description: "Energía de diciembre",
      category: "utilities",
      due_date: "2025-12-01",
      amount: 500_000,
      paid_amount: 0,
      pending_amount: 500_000,
      status: "pending",
      overdue: true,
      days_until_due: -99,
    },
    {
      obligation_id: 2,
      description: "INC enero – febrero 2026",
      category: "consumption_tax",
      due_date: "2026-03-25",
      amount: 800_000,
      paid_amount: 300_000,
      pending_amount: 500_000,
      status: "partial",
      overdue: false,
      days_until_due: 15,
    },
  ],
  overdue_count: 1,
  overdue_total: 500_000,
  upcoming_total: 500_000,
  total_pending: 1_000_000,
  not_generated: [
    {
      template_id: 4,
      description: "Arriendo",
      category: "rent",
      amount: 3_000_000,
      due_date: "2026-04-05",
      period_month: "2026-04-01",
      obligation_id: null,
      cancelled: false,
    },
  ],
}

describe("AgendaTab (c5)", () => {
  beforeEach(() => {
    getAgendaMock.mockReset().mockResolvedValue(AGENDA)
  })

  it("pinta los totales del servidor, resalta lo vencido y lista lo que falta armar", async () => {
    renderWithProviders(<AgendaTab storeId={1} />)

    expect(await screen.findByText("venció hace 99 días")).toBeInTheDocument()
    expect(screen.getByText("en 15 días")).toBeInTheDocument()
    expect(screen.getByText("Vencido")).toBeInTheDocument()
    expect(screen.getByText("Recurrentes que todavía no se armaron")).toBeInTheDocument()
    expect(screen.getByText(/Arriendo ·/)).toBeInTheDocument()
    expect(getAgendaMock).toHaveBeenCalledWith(1, 30)
  })

  it("cambia la ventana a 60 días", async () => {
    const user = userEvent.setup()
    renderWithProviders(<AgendaTab storeId={1} />)
    await screen.findByText("venció hace 99 días")

    await user.click(screen.getByRole("button", { name: "60 días" }))
    await waitFor(() => expect(getAgendaMock).toHaveBeenCalledWith(1, 60))
  })
})
