import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { DrawerExpenseMovementOut, ObligationOut } from "@/api/expenses"
import { renderWithProviders } from "@/test/utils"

import { ObligationsTab } from "../ObligationsTab"

const { getObligationsMock, settleObligationMock, getDrawerExpenseMovementsMock } = vi.hoisted(() => ({
  getObligationsMock: vi.fn(),
  settleObligationMock: vi.fn(),
  getDrawerExpenseMovementsMock: vi.fn(),
}))

vi.mock("@/api/expenses", async () => {
  const actual = await vi.importActual<typeof import("@/api/expenses")>("@/api/expenses")
  return {
    ...actual,
    getObligations: getObligationsMock,
    settleObligation: settleObligationMock,
    getDrawerExpenseMovements: getDrawerExpenseMovementsMock,
  }
})

const PENDING: ObligationOut = {
  id: 7,
  store_id: 1,
  description: "Arriendo de octubre",
  category: "rent",
  due_date: "2099-10-05",
  amount: 2_000_000,
  status: "pending",
  overdue: false,
  cancelled_at: null,
}

const MOVEMENT: DrawerExpenseMovementOut = {
  id: 55,
  shift_id: 3,
  cause: "other_expense",
  amount: 40_000,
  note: "Pago al plomero",
  employee_name: "Cajera",
  at: "2026-10-05T15:00:00Z",
}

async function openSettle(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Saldar" }))
  return screen.findByRole("dialog")
}

describe("ObligationsTab — saldar elige de dónde salió la plata (u4)", () => {
  beforeEach(() => {
    getObligationsMock.mockReset().mockResolvedValue([PENDING])
    settleObligationMock.mockReset().mockResolvedValue({ ...PENDING, status: "paid" })
    getDrawerExpenseMovementsMock.mockReset().mockResolvedValue([MOVEMENT])
  })

  it("por defecto manda source: bank, nunca «other» fijo", async () => {
    const user = userEvent.setup()
    renderWithProviders(<ObligationsTab storeId={1} />)

    const dialog = await openSettle(user)
    await user.click(within(dialog).getByRole("button", { name: "Confirmar pago" }))

    await waitFor(() => expect(settleObligationMock).toHaveBeenCalledTimes(1))
    expect(settleObligationMock.mock.calls[0]![0]).toBe(7)
    expect(settleObligationMock.mock.calls[0]![1]).toEqual({ source: "bank", cash_movement_id: null })
    expect(getDrawerExpenseMovementsMock).not.toHaveBeenCalled()
  })

  it("desde el cajón exige elegir el egreso ya registrado y lo manda como cash_movement_id", async () => {
    const user = userEvent.setup()
    renderWithProviders(<ObligationsTab storeId={1} />)

    const dialog = await openSettle(user)
    await user.click(within(dialog).getByRole("combobox", { name: "¿De dónde salió la plata?" }))
    await user.click(await screen.findByRole("option", { name: /Cajón/ }))

    const confirm = within(dialog).getByRole("button", { name: "Confirmar pago" })
    expect(confirm).toBeDisabled()

    await user.click(await within(dialog).findByRole("combobox", { name: "Egreso del cajón que la pagó" }))
    await user.click(await screen.findByRole("option", { name: /Pago al plomero/ }))
    expect(getDrawerExpenseMovementsMock).toHaveBeenCalledWith(1)

    expect(confirm).toBeEnabled()
    await user.click(confirm)

    await waitFor(() => expect(settleObligationMock).toHaveBeenCalledTimes(1))
    expect(settleObligationMock.mock.calls[0]![1]).toEqual({ source: "cash_drawer", cash_movement_id: 55 })
  })

  it("sin egresos del cajón disponibles, lo dice y no deja confirmar", async () => {
    getDrawerExpenseMovementsMock.mockResolvedValue([])
    const user = userEvent.setup()
    renderWithProviders(<ObligationsTab storeId={1} />)

    const dialog = await openSettle(user)
    await user.click(within(dialog).getByRole("combobox", { name: "¿De dónde salió la plata?" }))
    await user.click(await screen.findByRole("option", { name: /Cajón/ }))

    expect(await within(dialog).findByText(/No hay egresos del cajón sin usar/)).toBeInTheDocument()
    expect(within(dialog).getByRole("button", { name: "Confirmar pago" })).toBeDisabled()
  })
})
