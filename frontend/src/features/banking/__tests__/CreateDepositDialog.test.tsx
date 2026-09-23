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

    const submitButton = screen.getByRole("button", { name: /^Consignar \$\s?500\.000$/ })
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

    // La pantalla NO muestra ningún remanente calculado acá: `unallocated_amount`
    // lo publica el servidor en `DepositOut`. Ver el test de abajo.
    expect(screen.queryByText(/Remanente sin imputar/)).not.toBeInTheDocument()

    const submitButton = screen.getByRole("button", { name: /^Consignar \$\s?500\.000$/ })
    expect(submitButton).toBeEnabled()
    await user.click(submitButton)

    expect(createDepositMock).toHaveBeenCalledTimes(1)
    const [, body] = createDepositMock.mock.calls[0]!
    expect(body.amount).toBe(500_000)
    expect(body.allocations).toEqual([{ shift_id: 11, amount: 200_000 }])
  })

  it("si las imputaciones superan el monto consignado, la pantalla NO decide: manda y muestra el rechazo del servidor", async () => {
    // Antes, el cliente restaba `amount - Σ allocations`, mostraba el
    // remanente y deshabilitaba el botón cuando daba negativo. El invariante
    // `src/audit/money-after-drawer.test.ts` lo marcó y tenía razón: una
    // diferencia de plata restada en el cliente es una segunda matemática por
    // más que se la rotule «ayuda de captura» (AGENTS.md § "una sola
    // matemática, en el backend"). La autoridad es `ALLOCATION_EXCEEDS_DEPOSIT`,
    // que nombra las dos cifras, y la pantalla muestra ESE mensaje.
    createDepositMock.mockRejectedValue(
      new Error("Las imputaciones suman $200000 pero la consignación es de $100000"),
    )
    const user = userEvent.setup()
    renderWithProviders(<CreateDepositDialog storeId={1} triggerLabel="Abrir formulario" />)

    await openDialog(user)

    await user.type(screen.getByLabelText("Monto consignado (el que dice el comprobante del banco)"), "100000")
    await user.type(screen.getByLabelText("Id de turno"), "11")
    await user.type(screen.getByLabelText("Monto de este turno"), "200000")
    await user.click(screen.getByRole("button", { name: "Adjuntar comprobante (stub)" }))

    const submitButton = screen.getByRole("button", { name: /^Consignar \$\s?100\.000$/ })
    expect(submitButton).toBeEnabled()
    await user.click(submitButton)

    expect(createDepositMock).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Las imputaciones suman \$200000 pero la consignación es de \$100000/,
    )
  })
})
