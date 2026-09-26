import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { describe, expect, it } from "vitest"

import { DenominationKeypad } from "../DenominationKeypad"
import type { Denomination } from "../DenominationsInput"
import { DENOMINATIONS } from "@/lib/money"

function Harness({ onValue }: { onValue?: (v: Denomination[]) => void }): React.JSX.Element {
  const [value, setValue] = useState<Denomination[]>(DENOMINATIONS.map((v) => ({ value: v, count: 0 })))
  return (
    <>
      <input aria-label="Otro campo" />
      <DenominationKeypad
        value={value}
        legend="Efectivo contado"
        onChange={(next) => {
          setValue(next)
          onValue?.(next)
        }}
      />
    </>
  )
}

function piezas(value: Denomination[]): Record<number, number> {
  return Object.fromEntries(value.filter((d) => d.count > 0).map((d) => [d.value, d.count]))
}

describe("DenominationKeypad — contar plata sin el teclado del sistema", () => {
  it("el primer dígito reemplaza, los siguientes agregan, y «Siguiente» avanza de denominación", async () => {
    let last: Denomination[] = []
    const user = userEvent.setup()
    render(<Harness onValue={(v) => (last = v)} />)

    await user.click(screen.getByRole("button", { name: "1" }))
    await user.click(screen.getByRole("button", { name: "2" }))
    expect(piezas(last)).toEqual({ 100000: 12 })
    await user.click(screen.getByRole("button", { name: "Borrar un dígito" }))
    expect(piezas(last)).toEqual({ 100000: 1 })

    await user.click(screen.getByRole("button", { name: "Siguiente denominación" }))
    await user.click(screen.getByRole("button", { name: "3" }))
    expect(piezas(last)).toEqual({ 100000: 1, 50000: 3 })

    // Volver a una denominación: el próximo dígito reemplaza lo que había.
    await user.click(screen.getByRole("button", { name: /^\$ 100\.000: 1 billete$/ }))
    await user.click(screen.getByRole("button", { name: "5" }))
    expect(piezas(last)).toEqual({ 100000: 5, 50000: 3 })
    expect(screen.getByText("8 piezas")).toBeInTheDocument()
  })

  it("−/+ suman o quitan una pieza, y nunca bajan de cero", async () => {
    let last: Denomination[] = []
    const user = userEvent.setup()
    render(<Harness onValue={(v) => (last = v)} />)

    expect(screen.getByRole("button", { name: "Quitar una moneda de $ 500" })).toBeDisabled()
    await user.click(screen.getByRole("button", { name: "Sumar una moneda de $ 500" }))
    await user.click(screen.getByRole("button", { name: "Sumar una moneda de $ 500" }))
    await user.click(screen.getByRole("button", { name: "Quitar una moneda de $ 500" }))
    expect(piezas(last)).toEqual({ 500: 1 })
  })

  it("el teclado físico escribe sólo con el foco adentro: no se come las teclas de otro campo", async () => {
    let last: Denomination[] = []
    const user = userEvent.setup()
    render(<Harness onValue={(v) => (last = v)} />)

    await user.click(screen.getByLabelText("Otro campo"))
    await user.keyboard("42")
    expect(piezas(last)).toEqual({})
    expect(screen.getByLabelText("Otro campo")).toHaveValue("42")

    await user.click(screen.getByRole("button", { name: /^\$ 20\.000: sin contar$/ }))
    await user.keyboard("7{Enter}2")
    expect(piezas(last)).toEqual({ 20000: 7, 10000: 2 })
  })
})
