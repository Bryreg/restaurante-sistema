import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { DrawerExpenseMovementOut, ObligationOut, ObligationPaymentOut } from "@/api/expenses"
import { renderWithProviders } from "@/test/utils"

import { ObligationsTab } from "../ObligationsTab"

const {
  getObligationsMock,
  addObligationPaymentMock,
  getDrawerExpenseMovementsMock,
  getObligationPaymentsMock,
  voidObligationPaymentMock,
} = vi.hoisted(() => ({
  getObligationsMock: vi.fn(),
  addObligationPaymentMock: vi.fn(),
  getDrawerExpenseMovementsMock: vi.fn(),
  getObligationPaymentsMock: vi.fn(),
  voidObligationPaymentMock: vi.fn(),
}))

vi.mock("@/api/expenses", async () => {
  const actual = await vi.importActual<typeof import("@/api/expenses")>("@/api/expenses")
  return {
    ...actual,
    getObligations: getObligationsMock,
    addObligationPayment: addObligationPaymentMock,
    getDrawerExpenseMovements: getDrawerExpenseMovementsMock,
    getObligationPayments: getObligationPaymentsMock,
    voidObligationPayment: voidObligationPaymentMock,
  }
})

const PENDING: ObligationOut = {
  id: 7,
  store_id: 1,
  description: "Arriendo de octubre",
  category: "rent",
  due_date: "2099-10-05",
  amount: 2_000_000,
  paid_amount: 0,
  pending_amount: 2_000_000,
  status: "pending",
  overdue: false,
  cancelled_at: null,
}

const PARTIAL: ObligationOut = { ...PENDING, status: "partial", paid_amount: 500_000, pending_amount: 1_500_000 }

const PAYMENT: ObligationPaymentOut = {
  id: 91,
  obligation_id: 7,
  amount: 500_000,
  paid_on: "2026-10-01",
  source: "bank",
  cash_movement_id: null,
  note: null,
  created_by_employee_name: "Dueña",
  created_at: "2026-10-01T15:00:00Z",
  voided_at: null,
  voided_reason: null,
  voided_by_employee_name: null,
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

async function openPay(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Pagar" }))
  return screen.findByRole("dialog")
}

describe("ObligationsTab — pagar elige de dónde salió la plata (u4) y admite abonos (c5)", () => {
  beforeEach(() => {
    getObligationsMock.mockReset().mockResolvedValue([PENDING])
    addObligationPaymentMock.mockReset().mockResolvedValue({ ...PENDING, status: "paid" })
    getDrawerExpenseMovementsMock.mockReset().mockResolvedValue([MOVEMENT])
    getObligationPaymentsMock.mockReset().mockResolvedValue([])
    voidObligationPaymentMock.mockReset().mockResolvedValue(PENDING)
  })

  it("por defecto paga el saldo que publica el servidor, con source: bank", async () => {
    const user = userEvent.setup()
    renderWithProviders(<ObligationsTab storeId={1} />)

    const dialog = await openPay(user)
    await user.click(within(dialog).getByRole("button", { name: "Confirmar pago" }))

    await waitFor(() => expect(addObligationPaymentMock).toHaveBeenCalledTimes(1))
    expect(addObligationPaymentMock.mock.calls[0]![0]).toBe(7)
    expect(addObligationPaymentMock.mock.calls[0]![1]).toEqual({
      amount: 2_000_000,
      source: "bank",
      cash_movement_id: null,
    })
    expect(getDrawerExpenseMovementsMock).not.toHaveBeenCalled()
  })

  it("desde el cajón exige elegir el egreso ya registrado y lo manda como cash_movement_id", async () => {
    const user = userEvent.setup()
    renderWithProviders(<ObligationsTab storeId={1} />)

    const dialog = await openPay(user)
    await user.click(within(dialog).getByRole("combobox", { name: "¿De dónde salió la plata?" }))
    await user.click(await screen.findByRole("option", { name: /Cajón/ }))

    const confirm = within(dialog).getByRole("button", { name: "Confirmar pago" })
    expect(confirm).toBeDisabled()

    await user.click(await within(dialog).findByRole("combobox", { name: "Egreso del cajón que la pagó" }))
    await user.click(await screen.findByRole("option", { name: /Pago al plomero/ }))
    expect(getDrawerExpenseMovementsMock).toHaveBeenCalledWith(1)

    expect(confirm).toBeEnabled()
    await user.click(confirm)

    await waitFor(() => expect(addObligationPaymentMock).toHaveBeenCalledTimes(1))
    expect(addObligationPaymentMock.mock.calls[0]![1]).toMatchObject({ source: "cash_drawer", cash_movement_id: 55 })
  })

  it("sin egresos del cajón disponibles, lo dice y no deja confirmar", async () => {
    getDrawerExpenseMovementsMock.mockResolvedValue([])
    const user = userEvent.setup()
    renderWithProviders(<ObligationsTab storeId={1} />)

    const dialog = await openPay(user)
    await user.click(within(dialog).getByRole("combobox", { name: "¿De dónde salió la plata?" }))
    await user.click(await screen.findByRole("option", { name: /Cajón/ }))

    expect(await within(dialog).findByText(/No hay egresos del cajón sin usar/)).toBeInTheDocument()
    expect(within(dialog).getByRole("button", { name: "Confirmar pago" })).toBeDisabled()
  })

  it("con abonos muestra lo que falta y deja anular un abono con motivo", async () => {
    getObligationsMock.mockResolvedValue([PARTIAL])
    getObligationPaymentsMock.mockResolvedValue([PAYMENT])
    const user = userEvent.setup()
    renderWithProviders(<ObligationsTab storeId={1} />)

    expect(await screen.findByText("Con abonos")).toBeInTheDocument()
    const dialog = await openPay(user)
    expect(within(dialog).getByText(/Falta/)).toBeInTheDocument()

    await user.click(await within(dialog).findByRole("button", { name: "Anular abono" }))
    const confirm = within(dialog).getByRole("button", { name: "Confirmar anulación" })
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByLabelText("Motivo de la anulación"), "Transferencia rebotada")
    await user.click(confirm)

    await waitFor(() => expect(voidObligationPaymentMock).toHaveBeenCalledTimes(1))
    expect(voidObligationPaymentMock.mock.calls[0]!.slice(0, 3)).toEqual([7, 91, "Transferencia rebotada"])
  })
})
