import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { ApiError } from "@/api/client"
import type { PayableDetailOut } from "@/api/expenses"
import { renderWithProviders } from "@/test/utils"

import { PayablesApprovalTab } from "../PayablesApprovalTab"

const { getPayableDetailMock, approvePayableMock } = vi.hoisted(() => ({
  getPayableDetailMock: vi.fn(),
  approvePayableMock: vi.fn(),
}))

vi.mock("@/api/expenses", async () => {
  const actual = await vi.importActual<typeof import("@/api/expenses")>("@/api/expenses")
  return { ...actual, getPayableDetail: getPayableDetailMock, approvePayable: approvePayableMock }
})

const PENDING: PayableDetailOut = {
  id: 42,
  amount: 500_000,
  status: "pending_review",
  due_date: "2026-09-25",
  invoice_total: 520_000,
  invoice_discrepancy: 20_000,
}

async function typePin(user: ReturnType<typeof userEvent.setup>) {
  for (const digit of "1234") {
    await user.click(screen.getByRole("button", { name: `Dígito ${digit}` }))
  }
}

async function search(user: ReturnType<typeof userEvent.setup>, id = "42") {
  await user.type(screen.getByLabelText("Buscar cuenta por pagar por id"), id)
  await user.click(screen.getByRole("button", { name: "Buscar" }))
}

describe("PayablesApprovalTab — D-2: 409 INVOICE_DISCREPANCY exige confirmación explícita con las dos cifras", () => {
  it("sin confirm_discrepancy, el 409 muestra las DOS cifras y no aprueba sola", async () => {
    getPayableDetailMock.mockResolvedValue(PENDING)
    approvePayableMock.mockRejectedValueOnce(
      new ApiError(409, "INVOICE_DISCREPANCY", "La factura ($520.000) no coincide con lo calculado ($500.000)"),
    )

    const user = userEvent.setup()
    renderWithProviders(<PayablesApprovalTab storeId={1} />)

    await search(user)
    expect(await screen.findByText("Pendiente de revisión")).toBeInTheDocument()

    await typePin(user)

    await waitFor(() => expect(approvePayableMock).toHaveBeenCalledTimes(1))
    expect(approvePayableMock.mock.calls[0]![1]).toEqual({ authorizer_pin: "1234", confirm_discrepancy: false })

    expect(await screen.findByText("La factura no coincide con lo calculado")).toBeInTheDocument()
    // Las dos cifras, no sólo la diferencia (aparecen dos veces: en el
    // resumen de arriba y en el cuadro de confirmación).
    expect(screen.getAllByText("$ 520.000").length).toBeGreaterThan(0)
    expect(screen.getAllByText("$ 500.000").length).toBeGreaterThan(0)
  })

  it("confirmando explícitamente, reenvía con confirm_discrepancy: true y aprueba", async () => {
    getPayableDetailMock.mockResolvedValueOnce(PENDING).mockResolvedValueOnce({ ...PENDING, status: "approved" })
    approvePayableMock
      .mockRejectedValueOnce(new ApiError(409, "INVOICE_DISCREPANCY", "Diferencia de $20.000"))
      .mockResolvedValueOnce({ ...PENDING, status: "approved" })

    const user = userEvent.setup()
    renderWithProviders(<PayablesApprovalTab storeId={1} />)

    await search(user)
    await screen.findByText("Pendiente de revisión")
    await typePin(user)
    // El código decide, nunca el `message` crudo del servidor (AGENTS.md § "los
    // errores se deciden por `code`, nunca por `message`") — por eso lo que se
    // verifica es el título fijo que arma la pantalla, no el texto del 409.
    await screen.findByText("La factura no coincide con lo calculado")

    await typePin(user)

    await waitFor(() => expect(approvePayableMock).toHaveBeenCalledTimes(2))
    expect(approvePayableMock.mock.calls[1]![1]).toEqual({ authorizer_pin: "1234", confirm_discrepancy: true })
    expect(await screen.findByText("Esta cuenta no está pendiente de revisión.")).toBeInTheDocument()
  })
})
