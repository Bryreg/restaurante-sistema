/**
 * C5/H-6 (iteración 2): antes, el monto de la consignación salía de sumar
 * `allocations` (`const total = validAllocations.reduce(...)`) y
 * `canSubmit` exigía `validAllocations.length > 0` — la mano del dueño
 * (retira plata, la guarda, y la consigna días después sin turno al que
 * imputarla todavía) no se podía registrar, porque `unallocated_amount`
 * nunca podía ser distinto de cero.
 *
 * Este archivo prueba la guarda real, en el `mutationFn`: el body del POST
 * lleva SIEMPRE el monto que la persona tipeó en su propio campo, nunca la
 * suma de las imputaciones — con imputaciones y sin ninguna.
 */
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders } from "@/test/utils"

import { CreateDepositDialog } from "../CreateDepositDialog"

const { createDepositMock } = vi.hoisted(() => ({ createDepositMock: vi.fn() }))

vi.mock("@/api/banking", async () => {
  const actual = await vi.importActual<typeof import("@/api/banking")>("@/api/banking")
  return { ...actual, createDeposit: createDepositMock }
})

// La mecánica de `FileReader`/`<input type="file">` no es lo que este
// archivo prueba — la cubre `PhotoCaptureField` por su cuenta. Un stub que
// llama a `onChange` con un *data URL* fijo alcanza; mismo patrón que
// `purchases/__tests__/PayableDetailDialog.paymentAmountGuard.test.tsx`
// mockea `PinPad` para aislar la guarda que sí importa acá.
vi.mock("@/components/PhotoCaptureField", () => ({
  PhotoCaptureField: ({ onChange }: { onChange: (dataUrl: string | null) => void }) => (
    <button type="button" onClick={() => onChange("data:image/png;base64,xyz")}>
      Adjuntar comprobante (stub)
    </button>
  ),
}))

async function openDialog(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole("button", { name: "Abrir formulario" }))
  // Regla de los portales: el `Dialog` (Base UI) monta su contenido en un
  // portal — esperar un campo de adentro con `findBy` antes de interactuar,
  // nunca una consulta síncrona.
  await screen.findByLabelText("Monto consignado (el que dice el comprobante del banco)")
}

describe("CreateDepositDialog — C5/H-6: el monto nunca sale de sumar allocations", () => {
  it("registra la mano del dueño (sin ninguna imputación): el body lleva el monto tipeado y allocations: []", async () => {
    createDepositMock.mockResolvedValue({ id: 1, unallocated_amount: 500_000 })
    const user = userEvent.setup()
    renderWithProviders(<CreateDepositDialog storeId={1} triggerLabel="Abrir formulario" />)

    await openDialog(user)

    // Ninguna fila de turno se toca: la única fila por defecto queda con
    // el id de turno vacío, que se descarta sin bloquear el guardado (era
    // el punto 5 del arreglo).
    await user.type(screen.getByLabelText("Monto consignado (el que dice el comprobante del banco)"), "500000")
    await user.click(screen.getByRole("button", { name: "Adjuntar comprobante (stub)" }))

    const submitButton = screen.getByRole("button", { name: "Registrar consignación" })
    expect(submitButton).toBeEnabled()
    await user.click(submitButton)

    expect(createDepositMock).toHaveBeenCalledTimes(1)
    const [, body] = createDepositMock.mock.calls[0]!
    expect(body.amount).toBe(500_000)
    expect(body.allocations).toEqual([])
  })

  it("con imputaciones: el body lleva el monto TIPEADO, no la suma de las imputaciones", async () => {
    createDepositMock.mockResolvedValue({ id: 2, unallocated_amount: 300_000 })
    const user = userEvent.setup()
    renderWithProviders(<CreateDepositDialog storeId={1} triggerLabel="Abrir formulario" />)

    await openDialog(user)

    await user.type(screen.getByLabelText("Monto consignado (el que dice el comprobante del banco)"), "500000")
    await user.type(screen.getByLabelText("Id de turno"), "11")
    await user.type(screen.getByLabelText("Monto de este turno"), "200000")
    await user.click(screen.getByRole("button", { name: "Adjuntar comprobante (stub)" }))

    // El remanente que se ve en pantalla es una ayuda de captura del
    // cliente, nunca la cifra del sistema (`unallocated_amount` sale del
    // servidor) — pero mientras es >= 0 no bloquea el envío.
    expect(screen.getByText(/Remanente sin imputar/)).toHaveTextContent("$ 300.000")

    const submitButton = screen.getByRole("button", { name: "Registrar consignación" })
    expect(submitButton).toBeEnabled()
    await user.click(submitButton)

    expect(createDepositMock).toHaveBeenCalledTimes(1)
    const [, body] = createDepositMock.mock.calls[0]!
    expect(body.amount).toBe(500_000)
    expect(body.allocations).toEqual([{ shift_id: 11, amount: 200_000 }])
  })

  it("si las imputaciones superan el monto consignado, bloquea el envío con mensaje propio (el servidor sigue siendo la autoridad)", async () => {
    const user = userEvent.setup()
    renderWithProviders(<CreateDepositDialog storeId={1} triggerLabel="Abrir formulario" />)

    await openDialog(user)

    await user.type(screen.getByLabelText("Monto consignado (el que dice el comprobante del banco)"), "100000")
    await user.type(screen.getByLabelText("Id de turno"), "11")
    await user.type(screen.getByLabelText("Monto de este turno"), "200000")
    await user.click(screen.getByRole("button", { name: "Adjuntar comprobante (stub)" }))

    expect(screen.getByRole("alert")).toHaveTextContent(/imputaciones suman más que el monto consignado/i)
    expect(screen.getByRole("button", { name: "Registrar consignación" })).toBeDisabled()
    expect(createDepositMock).not.toHaveBeenCalled()
  })
})
