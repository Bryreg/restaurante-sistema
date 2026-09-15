import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders } from "@/test/utils"

import { DiscountDialog } from "../DiscountDialog"

/**
 * O-1 (`features/fase-1b-venta/outputs-1b-1/auditor-venta.md § 3`,
 * `DiscountDialog.tsx:62` en 1b-1): `Math.round(numericValue)` redondeaba en
 * silencio lo que la persona tecleó (un "10,6 %" se mandaba como "11 %").
 * Estos tests fijan lo contrario: un valor con decimales se RECHAZA con el
 * mensaje de siempre, nunca se redondea y nunca llega a `onConfirm`.
 */
async function fillReason(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByLabelText("Motivo"))
  await user.click(screen.getByRole("option", { name: "Promoción" }))
}

describe("DiscountDialog — O-1, enteros sin redondeo silencioso", () => {
  it("rechaza un porcentaje con decimales y no llama a onConfirm", async () => {
    const onConfirm = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(
      <DiscountDialog open title="Descuento" onConfirm={onConfirm} onOpenChange={() => {}} />,
    )

    await user.type(screen.getByLabelText("Porcentaje (%)"), "10.6")
    await fillReason(user)
    await user.click(screen.getByRole("button", { name: "Aplicar descuento" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(/entero, sin decimales/i)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("rechaza un monto fijo con decimales y no llama a onConfirm", async () => {
    const onConfirm = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(
      <DiscountDialog open title="Descuento" onConfirm={onConfirm} onOpenChange={() => {}} />,
    )

    await user.click(screen.getByLabelText("Tipo"))
    await user.click(screen.getByRole("option", { name: "Monto fijo" }))
    await user.type(screen.getByLabelText("Monto ($)"), "1500.5")
    await fillReason(user)
    await user.click(screen.getByRole("button", { name: "Aplicar descuento" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(/entero, sin decimales/i)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("acepta un entero y lo manda tal cual, sin redondear nada", async () => {
    const onConfirm = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(
      <DiscountDialog open title="Descuento" onConfirm={onConfirm} onOpenChange={() => {}} />,
    )

    await user.type(screen.getByLabelText("Porcentaje (%)"), "15")
    await fillReason(user)
    await user.click(screen.getByRole("button", { name: "Aplicar descuento" }))

    expect(onConfirm).toHaveBeenCalledWith("percent", 15, "promo", undefined)
  })
})
