import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { DateRangeFilter } from "../DateRangeFilter"

describe("DateRangeFilter", () => {
  it("expone exactamente {from, to, onChange} y avisa el rango completo en cada cambio", () => {
    const onChange = vi.fn()
    render(<DateRangeFilter from="2026-09-01" to="2026-09-15" onChange={onChange} />)

    const fromInput = screen.getByLabelText("Desde")
    expect(fromInput).toHaveValue("2026-09-01")
    expect(screen.getByLabelText("Hasta")).toHaveValue("2026-09-15")

    // `type="date"` no se puede tipear carácter a carácter de forma confiable
    // con `userEvent`: un date picker real dispara un único `change` con el
    // valor completo, así que se simula igual.
    fireEvent.change(fromInput, { target: { value: "2026-09-05" } })

    expect(onChange).toHaveBeenCalledWith({ from: "2026-09-05", to: "2026-09-15" })
  })

  it("dos instancias en la misma pantalla no chocan de id (idPrefix)", () => {
    render(
      <>
        <DateRangeFilter idPrefix="a" from="2026-09-01" to="2026-09-02" onChange={() => {}} />
        <DateRangeFilter idPrefix="b" from="2026-09-03" to="2026-09-04" onChange={() => {}} />
      </>,
    )
    expect(screen.getAllByLabelText("Desde")).toHaveLength(2)
  })
})
