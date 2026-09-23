import { describe, expect, it } from "vitest"

import type { SustainedHealthOut, SustainedWindowOut, VarianceByDishOut } from "@/api/analytics"

import { sustainedTitular, varianceByDishTitular } from "../titulares"

function ventana(i: number, gap_bp: number, exceeds_red: boolean): SustainedWindowOut {
  return { window_index: i, gap_bp, exceeds_red, real_pct_bp: 3300 + gap_bp, theoretical_pct_bp: 3300 }
}

describe("varianceByDishTitular — el neto del servidor y el faltante más grande", () => {
  const base: VarianceByDishOut = {
    method: "prorated",
    available: true,
    reason: null,
    rows: [
      { product_id: 11, product_name: "Pechuga a la plancha", variance_value: 33021, direction: "shortage" },
      { product_id: 17, product_name: "Gaseosa", variance_value: -167500, direction: "surplus" },
    ],
  }

  it("neto negativo: «Sobran», sin el signo pegado", () => {
    expect(varianceByDishTitular({ ...base, total_variance_value: -146772 })).toBe(
      "Sobran $ 146.772 netos en la ventana; el faltante más grande es Pechuga a la plancha, $ 33.021",
    )
  })

  it("neto positivo: «Faltan»", () => {
    expect(varianceByDishTitular({ ...base, total_variance_value: 52000 })).toMatch(/^Faltan \$ 52\.000 netos en la ventana;/)
  })

  it("usa el total del servidor, no suma las filas", () => {
    // Las filas suman −134.479; el servidor dice otra cosa (hay varianza sin atribuir) y manda el servidor.
    expect(varianceByDishTitular({ ...base, total_variance_value: -146772 })).toContain("$ 146.772")
  })

  it("sin faltantes no nombra ninguno", () => {
    expect(varianceByDishTitular({ ...base, rows: [base.rows![1]!], total_variance_value: -167500 })).toBe(
      "Sobran $ 167.500 netos en la ventana",
    )
  })
})

describe("sustainedTitular — concluye contra la regla del umbral rojo", () => {
  it("sostenida en rojo: cuenta cuántas de las últimas 3 pasan (contar, no calcular)", () => {
    const d: SustainedHealthOut = {
      sustained_red: true,
      windows_evaluated: 4,
      reason: null,
      red_threshold_bp: 300,
      windows: [ventana(1, 100, false), ventana(2, 450, true), ventana(3, 200, false), ventana(4, 510, true)],
    }
    expect(sustainedTitular(d)).toBe("Brecha sostenida en rojo: 2 de las últimas 3 ventanas pasan el umbral (3,0 puntos)")
  })

  it("última ventana por encima sin estar sostenida: lo dice con `exceeds_red` del servidor", () => {
    const d: SustainedHealthOut = {
      sustained_red: false,
      windows_evaluated: 3,
      reason: null,
      red_threshold_bp: 300,
      windows: [ventana(1, 100, false), ventana(2, 200, false), ventana(3, 450, true)],
    }
    expect(sustainedTitular(d)).toBe("La brecha está en 4,5 puntos, por encima del rojo (3,0 puntos)")
  })
})
