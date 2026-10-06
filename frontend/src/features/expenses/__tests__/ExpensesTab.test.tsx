import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders } from "@/test/utils"

import { ExpensesTab } from "../ExpensesTab"

const { getExpensesMock, createExpenseMock } = vi.hoisted(() => ({
  getExpensesMock: vi.fn(),
  createExpenseMock: vi.fn(),
}))

vi.mock("@/api/expenses", async () => {
  const actual = await vi.importActual<typeof import("@/api/expenses")>("@/api/expenses")
  return { ...actual, getExpenses: getExpensesMock, createExpense: createExpenseMock }
})

describe("ExpensesTab — c9: un gasto pagado de la mano del dueño", () => {
  it("el formulario pregunta de dónde salió la plata y manda `owner_hand`", async () => {
    getExpensesMock.mockResolvedValue([])
    createExpenseMock.mockResolvedValue({ id: 1 })

    const user = userEvent.setup()
    renderWithProviders(<ExpensesTab storeId={1} />)

    await user.click(await screen.findByRole("button", { name: "Registrar gasto" }))
    await user.type(screen.getByLabelText("Monto"), "12000")
    await user.type(screen.getByLabelText("Descripción"), "Hielo")

    await user.click(screen.getByLabelText("¿De dónde salió la plata?"))
    await user.click(await screen.findByRole("option", { name: /De la mano del dueño/ }))
    expect(screen.getByText(/Se resta de/)).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Guardar gasto" }))
    await waitFor(() => expect(createExpenseMock).toHaveBeenCalledTimes(1))
    const [storeId, body] = createExpenseMock.mock.calls[0]!
    expect(storeId).toBe(1)
    expect(body.source).toBe("owner_hand")
    expect(body.description).toBe("Hielo")
  })

  it("no ofrece «Cajón»: un gasto del cajón entra primero como egreso del turno", async () => {
    getExpensesMock.mockResolvedValue([])
    const user = userEvent.setup()
    renderWithProviders(<ExpensesTab storeId={1} />)

    await user.click(await screen.findByRole("button", { name: "Registrar gasto" }))
    await user.click(screen.getByLabelText("¿De dónde salió la plata?"))
    await screen.findByRole("option", { name: /De la mano del dueño/ })
    expect(screen.queryByRole("option", { name: /Cajón/ })).not.toBeInTheDocument()
  })
})
