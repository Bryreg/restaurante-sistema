/**
 * «Costo con origen, nunca un cero mudo» — probado en la pantalla, no en el
 * comentario.
 *
 * Auditor del pedido 2a. `AGENTS.md` y `docs/SPEC-NEGOCIO.md §4.1`: todo costo
 * viaja con su origen y **`null` no es `0`**. El backend cumple su mitad
 * (`cost = null` con `cost_source = "none"`, nunca un `0`); esta es la otra
 * mitad, la que el dueño del restaurante de verdad lee.
 *
 * Los costos de esta fase son **por unidad base** (por gramo, por mililitro),
 * así que son fracciones de peso por diseño: la pechuga a $14,5/g, la sal a
 * $0,003/g. Un formateador de pesos enteros convierte los dos en un número que
 * no es el costo — y al segundo lo convierte en el cero mudo que la regla
 * prohíbe, esta vez del lado del cliente.
 */

import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { CostValue } from "@/components/CostValue"

describe("CostValue: null nunca se pinta como 0", () => {
  it("un costo nulo dice «Sin costo» y su origen, nunca $0", () => {
    render(<CostValue cost={null} costSource="none" />)
    expect(screen.getByText("Sin costo")).toBeInTheDocument()
    expect(screen.queryByText(/\$\s*0\b/)).not.toBeInTheDocument()
  })

  it("un costo nulo con un origen distinto de none sigue siendo «Sin costo»", () => {
    // Defensivo: `null` manda sobre lo que diga `cost_source`. El backend no
    // debería mandar esa combinación (`record_movement` la rechaza), pero el
    // cliente no confía en eso.
    render(<CostValue cost={null} costSource="estimated" />)
    expect(screen.getByText("Sin costo")).toBeInTheDocument()
  })

  it("un costo por unidad base menor a un peso no se muestra como $0", () => {
    // Caso real y no hipotético: el seed de desarrollo carga "Sal de mesa"
    // con `estimated_cost = "0.003"` ($3.000 el bulto de 25 kg). Una base
    // recién sembrada abre Admin → Inventario → Insumos y lee un costo que
    // existe, es correcto y está escrito "$ 0".
    //
    // Es el cero mudo exacto que §4.1 prohíbe, con el agravante de que acá
    // viene con un badge que dice "estimado": la pantalla afirma que sabe el
    // costo y a la vez lo muestra en cero.
    const { container } = render(<CostValue cost="0.003" costSource="estimated" />)
    const texto = container.textContent ?? ""
    expect(
      /\$\s*0(\D|$)/.test(texto),
      `un costo de $0,003 por gramo se pintó como «${texto.trim()}»: ` +
        "un costo real mostrado en cero es indistinguible de «no hay costo»",
    ).toBe(false)
  })

  it("un costo fraccionario por unidad base no se redondea al peso", () => {
    // La pechuga del seed: `official_cost = "14.5"` ($14.500/kg). Mostrar
    // "$ 15" es el frontend decidiendo una cifra de plata que el backend no
    // mandó (§11.13, «una sola matemática»), y sobre el costo por gramo un
    // redondeo del 3,4 % se multiplica por cada gramo de cada ficha.
    const { container } = render(<CostValue cost="14.5" costSource="official" />)
    const texto = container.textContent ?? ""
    expect(
      texto.includes("14,5") || texto.includes("14.5"),
      `un costo de $14,5 por gramo se pintó como «${texto.trim()}»`,
    ).toBe(true)
  })

  it("un costo entero con origen se ve con su badge", () => {
    render(<CostValue cost={4500} costSource="official" />)
    expect(screen.getByText("oficial")).toBeInTheDocument()
  })
})
