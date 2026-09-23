import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import { BarList, ChartFrame } from "@/components/charts"
import { formatCOP } from "@/lib/money"

const TABLA = {
  columnas: [
    { key: "canal", header: "Canal" },
    { key: "neto", header: "Venta neta", align: "right" as const },
  ],
  filas: [
    { canal: "Mesa", neto: "$ 1.200.000" },
    { canal: "Domicilio", neto: "$ 300.000" },
  ],
}

describe("ChartFrame", () => {
  it("pone el titular como nombre de la figura y alterna gráfico y tabla con aria-pressed", async () => {
    const user = userEvent.setup()
    render(
      <ChartFrame titular="La mesa vende cuatro veces más que el domicilio" detalle="Venta neta por canal" tabla={TABLA}>
        <div data-testid="grafico">gráfico</div>
      </ChartFrame>,
    )
    expect(screen.getByRole("figure", { name: "La mesa vende cuatro veces más que el domicilio" })).toBeInTheDocument()
    expect(screen.getByTestId("grafico")).toBeVisible()
    expect(screen.queryByRole("table")).not.toBeInTheDocument()

    const boton = screen.getByRole("button", { name: "Ver tabla" })
    expect(boton).toHaveAttribute("aria-pressed", "false")
    await user.click(boton)

    const volver = screen.getByRole("button", { name: "Ver gráfico" })
    expect(volver).toHaveAttribute("aria-pressed", "true")
    const tabla = screen.getByRole("table")
    expect(within(tabla).getByRole("columnheader", { name: "Venta neta" })).toHaveClass("text-right")
    expect(within(tabla).getByText("$ 300.000")).toBeInTheDocument()
    expect(screen.getByTestId("grafico")).not.toBeVisible()

    await user.click(volver)
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
    expect(screen.getByTestId("grafico")).toBeVisible()
  })

  it("con n menor al mínimo marca «Muestra chica» y dice por qué", () => {
    render(
      <ChartFrame titular="t" tabla={TABLA} muestra={{ n: 18, unidad: "unidades vendidas", ventana: "16 h" }}>
        <div />
      </ChartFrame>,
    )
    const marca = screen.getByText(/Muestra chica: 18 unidades vendidas/)
    expect(marca.closest("[data-muestra]")).toHaveAttribute("data-muestra", "chica")
    expect(marca.closest("[data-muestra]")).toHaveTextContent(/Con menos de 20 unidades vendidas/)
    expect(marca.closest("[data-muestra]")).toHaveTextContent(/16 h/)
  })

  it("con muestra suficiente sólo informa la base, y respeta un mínimo propio", () => {
    const { rerender } = render(
      <ChartFrame titular="t" tabla={TABLA} muestra={{ n: 456, unidad: "comandas", ventana: "8 al 21 sep" }}>
        <div />
      </ChartFrame>,
    )
    expect(screen.queryByText(/Muestra chica/)).not.toBeInTheDocument()
    expect(screen.getByText(/Base: 456 comandas · 8 al 21 sep/)).toBeInTheDocument()

    rerender(
      <ChartFrame titular="t" tabla={TABLA} muestra={{ n: 2, unidad: "días", minimo: 3 }}>
        <div />
      </ChartFrame>,
    )
    expect(screen.getByText(/Muestra chica: 2 días/)).toBeInTheDocument()
  })

  it("«y N más» de un BarList adentro abre la tabla gemela", async () => {
    const user = userEvent.setup()
    const datos = Array.from({ length: 10 }, (_, i) => ({ key: `p${i}`, etiqueta: `Plato ${i}`, valor: (i + 1) * 1000 }))
    render(
      <ChartFrame titular="t" tabla={TABLA}>
        <BarList datos={datos} formato={formatCOP} />
      </ChartFrame>,
    )
    await user.click(screen.getByRole("button", { name: "y 3 más" }))
    expect(screen.getByRole("table")).toHaveFocus()
    expect(screen.getByRole("button", { name: "Ver gráfico" })).toHaveAttribute("aria-pressed", "true")
  })
})
