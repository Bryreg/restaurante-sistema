/**
 * H-9 (ronda 2): antes, `RegisterPaymentForm` armaba el cuerpo del pago con
 * `amount: amount ?? 0` — «null dibujado como 0» (AGENTS.md). Hoy eso nunca
 * disparaba porque el `PinPad` queda `disabled` mientras `amount` es `null`
 * (`amountValid`), pero esa es una guarda DISTINTA, escrita 74 líneas más
 * abajo del `mutationFn`: un refactor que tocara sólo el `disabled` del
 * `PinPad` habría mandado un pago de $0 sin que nada del `mutationFn` lo
 * impidiera.
 *
 * Este archivo prueba la guarda real — la de adentro del `mutationFn` — de
 * forma aislada de esa otra defensa: mockea `PinPad` para que dispare
 * `onSubmit` igual, SIN mirar `disabled` (exactamente lo que haría el
 * refactor que rompería la guarda vieja). Si el `mutationFn` no tuviera su
 * propio `if (amount === null) return` antes de armar el cuerpo, este test
 * vería un `createPayment` llamado con `amount: 0`.
 */
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { PayableOut } from "@/api/purchases"
import { renderWithProviders } from "@/test/utils"

import { PayableDetailDialog } from "../PayableDetailDialog"

const { createPaymentMock } = vi.hoisted(() => ({
  createPaymentMock: vi.fn(),
}))

vi.mock("@/api/purchases", async () => {
  const actual = await vi.importActual<typeof import("@/api/purchases")>("@/api/purchases")
  return { ...actual, createPayment: createPaymentMock }
})

// Simula "un refactor que mueva la guarda": este PinPad de prueba IGNORA
// `disabled` y ofrece un botón que siempre dispara `onSubmit`, tal como lo
// haría un `PinPad` real si alguien le quitara el `disabled={!amountValid}`
// de `RegisterPaymentForm`. Lo que este test verifica es que, aun así, no
// sale ningún pago.
vi.mock("@/components/PinPad", () => ({
  PinPad: ({ onSubmit, label }: { onSubmit: (pin: string) => void; label: string }) => (
    <button type="button" onClick={() => onSubmit("1234")}>
      {`Enviar (${label}) ignorando disabled`}
    </button>
  ),
}))

const APPROVED: PayableOut = {
  id: 7,
  store_id: 1,
  supplier_id: 3,
  reception_id: 42,
  amount: 120000,
  balance: 120000,
  status: "approved",
  due_date: "2026-10-01",
  overdue: false,
  approved_at: "2026-09-16T11:00:00Z",
  approved_by_employee_name: "Admin",
  business_date: "2026-09-16",
}

describe("RegisterPaymentForm — el mutationFn no envía un pago con amount null (H-9, ronda 2)", () => {
  it("con el monto en null, disparar el PinPad (aunque ignore `disabled`) no llama a createPayment", async () => {
    const user = userEvent.setup()
    renderWithProviders(<PayableDetailDialog payable={APPROVED} supplierLabel="Avícola del Valle" />)

    await user.click(screen.getByRole("button", { name: "Ver" }))
    await screen.findByRole("dialog")

    // Nunca se tocó el campo "Monto": `amount` sigue en `null` en el estado
    // del formulario.
    expect(screen.getByLabelText("Monto")).toHaveValue("")

    // Dispara el PinPad de pago directamente, sin pasar por el `disabled`
    // real (el mock lo ignora a propósito).
    await user.click(screen.getByRole("button", { name: /Enviar \(PIN de administrador para pagar\)/ }))

    // El envío ni siquiera ocurre: la única defensa que queda es el
    // `mutationFn`, y esa alcanza.
    expect(createPaymentMock).not.toHaveBeenCalled()
  })
})
