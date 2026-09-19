import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { describe, expect, it } from "vitest"

import {
  ComponentLinesEditor,
  draftsToComponentLines,
  emptyLine,
  type LineDraft,
} from "./ComponentLinesEditor"

const INGREDIENTS = [
  { id: 1, name: "Pechuga de pollo", base_unit: "g" as const },
  { id: 2, name: "Leche entera", base_unit: "ml" as const },
]
const PREPARATIONS = [{ id: 9, name: "Hogao", standard_yield_unit: "g" }]

function Harness() {
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()])
  return (
    <div>
      <ComponentLinesEditor
        idPrefix="test"
        lines={lines}
        onChange={setLines}
        ingredients={INGREDIENTS}
        preparations={PREPARATIONS}
      />
      <pre data-testid="out">{JSON.stringify(draftsToComponentLines(lines))}</pre>
    </div>
  )
}

describe("ComponentLinesEditor", () => {
  it("cada línea es insumo XOR preparación: elegir un insumo la manda como ingredient_id, nunca los dos", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole("combobox", { name: "Insumo" }))
    await user.click(await screen.findByRole("option", { name: "Pechuga de pollo (g)" }))
    await user.type(screen.getByLabelText("Cantidad"), "180")

    const out = JSON.parse(screen.getByTestId("out").textContent ?? "[]")
    expect(out).toEqual([{ ingredient_id: 1, preparation_id: undefined, qty: "180", unit: "g" }])
  })

  it("la unidad se acota a las compatibles con la unidad base del componente elegido", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole("combobox", { name: "Insumo" }))
    await user.click(await screen.findByRole("option", { name: "Leche entera (ml)" }))

    await user.click(screen.getByRole("combobox", { name: "Unidad" }))
    expect(screen.getByRole("option", { name: "ml" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "l" })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: "g" })).not.toBeInTheDocument()
    expect(screen.queryByRole("option", { name: "kg" })).not.toBeInTheDocument()
  })

  it("cambiar el tipo a «Preparación» ofrece las preparaciones, no los insumos", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole("combobox", { name: "Tipo" }))
    await user.click(await screen.findByRole("option", { name: "Preparación" }))

    await user.click(screen.getByRole("combobox", { name: "Preparación" }))
    // El popup vive en un portal: con los 89 entornos jsdom compitiendo por
    // CPU todavía no está montado cuando un `getByRole` síncrono pregunta, y
    // el test pasa solo pero falla en la suite. Tercera vez que aparece este
    // patrón en el proyecto (WastePage, MovementsPanel): siempre `find*`.
    expect(await screen.findByRole("option", { name: "Hogao" })).toBeInTheDocument()
  })

  it("una línea sin cantidad no se manda: no cuenta como línea completa", () => {
    render(<Harness />)
    const out = JSON.parse(screen.getByTestId("out").textContent ?? "[]")
    expect(out).toEqual([])
  })

  it("«Agregar línea» agrega una fila más, y «Quitar línea» la saca", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole("button", { name: "Agregar línea" }))
    expect(screen.getAllByLabelText("Cantidad")).toHaveLength(2)

    await user.click(screen.getAllByRole("button", { name: "Quitar línea" })[0]!)
    expect(screen.getAllByLabelText("Cantidad")).toHaveLength(1)
  })
})
