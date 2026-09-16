import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { CostValue, foodCostInBand, FoodCostBadge } from "./costDisplay"

describe("CostValue", () => {
  it("nunca pinta un costo nulo como $0: dice «Sin costo» y el origen", () => {
    render(<CostValue cost={null} costSource="none" />)
    expect(screen.getByText("Sin costo")).toBeInTheDocument()
    expect(screen.getByText("origen: ninguno")).toBeInTheDocument()
    expect(screen.queryByText("$ 0")).not.toBeInTheDocument()
    expect(screen.queryByText("$0")).not.toBeInTheDocument()
  })

  it("un costo con origen oficial se ve formateado con su badge de origen", () => {
    // `cost` viaja como string decimal (ronda 2 del contrato: precisión
    // completa, no entero) — nunca lo pasamos como número acá.
    render(<CostValue cost="4500" costSource="official" />)
    expect(screen.getByText("$ 4.500")).toBeInTheDocument()
    expect(screen.getByText("oficial")).toBeInTheDocument()
  })

  it("costo null con cost_source distinto de none igual se trata como sin costo", () => {
    // Invariante defensivo: `null` manda, sin importar qué diga `cost_source`
    // (nunca debería pasar del backend, pero el frontend no confía en eso).
    render(<CostValue cost={null} costSource="estimated" />)
    expect(screen.getByText("Sin costo")).toBeInTheDocument()
  })

  it("un costo sub-peso ($0,003) con origen oficial NO se pinta como «$ 0»", () => {
    // La sal del seed: $0,003/g redondeado a peso entero publicaría "0" con
    // origen "official" — el mismo cero mudo que la spec prohíbe (ronda 2
    // del contrato, motivo por el que `unit_cost`/`total_cost`/
    // `theoretical_cost` pasaron de entero a texto decimal con precisión
    // completa). `CostValue` es de `@/components/CostValue`
    // (frontend-inventario); acá sólo confirmamos que este módulo no
    // reintroduce el redondeo pasando algo distinto del string tal cual.
    render(<CostValue cost="0.003" costSource="official" />)
    expect(screen.queryByText("$ 0")).not.toBeInTheDocument()
    expect(screen.queryByText("Sin costo")).not.toBeInTheDocument()
  })
})

describe("foodCostInBand / FoodCostBadge", () => {
  it("28-35% está dentro del rango del sector", () => {
    expect(foodCostInBand("28")).toBe(true)
    expect(foodCostInBand("35")).toBe(true)
    expect(foodCostInBand("31.5")).toBe(true)
  })

  it("fuera de 28-35% se marca fuera de rango", () => {
    expect(foodCostInBand("27.9")).toBe(false)
    expect(foodCostInBand("40")).toBe(false)
  })

  it("null no es 0 %: dice «sin datos»", () => {
    expect(foodCostInBand(null)).toBeNull()
    render(<FoodCostBadge pct={null} />)
    expect(screen.getByText("Food cost: sin datos")).toBeInTheDocument()
  })

  it("un food cost fuera de rango se ve resaltado de inmediato", () => {
    render(<FoodCostBadge pct="42.00" />)
    expect(screen.getByText("Food cost 42.00%")).toBeInTheDocument()
    expect(screen.getByText(/fuera del rango del sector/)).toBeInTheDocument()
  })
})
