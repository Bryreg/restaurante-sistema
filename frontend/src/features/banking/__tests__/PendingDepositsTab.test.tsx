import { screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { PendingDepositOut } from "@/api/banking"
import { renderWithProviders } from "@/test/utils"

import { PendingDepositsTab } from "../PendingDepositsTab"

const { getPendingDepositsMock } = vi.hoisted(() => ({ getPendingDepositsMock: vi.fn() }))

vi.mock("@/api/banking", async () => {
  const actual = await vi.importActual<typeof import("@/api/banking")>("@/api/banking")
  return { ...actual, getPendingDeposits: getPendingDepositsMock }
})

const CLOSED_WITHOUT_COUNT: PendingDepositOut = {
  shift_id: 9,
  business_date: "2026-09-18",
  to_deposit: null,
  reason: "El turno cerró sin conteo de efectivo",
  deposited: null,
  outstanding: null,
}

const WITH_BALANCE: PendingDepositOut = {
  shift_id: 10,
  business_date: "2026-09-19",
  to_deposit: 150000,
  deposited: 50000,
  outstanding: 100000,
}

describe("PendingDepositsTab — Shift.to_deposit se LEE, nunca se recalcula, y null no es 0", () => {
  it('un turno cerrado sin conteo se pinta "sin datos" con su motivo, nunca $0', async () => {
    getPendingDepositsMock.mockResolvedValue([CLOSED_WITHOUT_COUNT])
    renderWithProviders(<PendingDepositsTab storeId={1} />)

    expect(await screen.findByText("Sin datos")).toBeInTheDocument()
    expect(screen.getByText("El turno cerró sin conteo de efectivo")).toBeInTheDocument()
    // La regla completa: ni un "$0" mudo en toda la fila de ese turno.
    expect(screen.queryByText(/\$\s*0\b/)).not.toBeInTheDocument()
  })

  it("un turno con saldo pendiente ofrece «Consignar» preseleccionado a ese turno", async () => {
    getPendingDepositsMock.mockResolvedValue([WITH_BALANCE])
    renderWithProviders(<PendingDepositsTab storeId={1} />)

    await waitFor(() => expect(screen.getByText("$ 100.000")).toBeInTheDocument())
    expect(screen.getByRole("button", { name: "Consignar" })).toBeInTheDocument()
  })

  it("un turno sin saldo pendiente no ofrece la acción de consignar", async () => {
    getPendingDepositsMock.mockResolvedValue([{ ...WITH_BALANCE, outstanding: 0 }])
    renderWithProviders(<PendingDepositsTab storeId={1} />)

    await waitFor(() => expect(screen.getByText("#10")).toBeInTheDocument())
    expect(screen.queryByRole("button", { name: "Consignar" })).not.toBeInTheDocument()
  })
})
