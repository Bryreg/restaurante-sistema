import { describe, expect, it } from "vitest"

import type { FoodCostOut, VarianceOut, VarianceParetoRowOut } from "@/api/inventory"

import { formatPuntos, textoVentana } from "../lib"
import { foodCostTitular, insumosHasta80, varianceDetalle, varianceTitular } from "../titulares"

/** El espacio fino que `formatPct` pone antes del «%». */
const F = "\u202f"

function foodCost(overrides: Partial<FoodCostOut>): FoodCostOut {
  return {
    available: true,
    reason: null,
    opening_count_id: 2,
    closing_count_id: 5,
    window_from: "2026-09-14T14:00:00Z",
    window_to: "2026-09-21T14:00:00Z",
    opening_value: 500000,
    purchases_value: 200000,
    closing_value: 320000,
    net_sales: 1000000,
    pct_bp: 3800,
    window_hours: 168,
    window_days: 7,
    orders_in_window: 120,
    theoretical_pct_bp: 3300,
    theoretical_reason: null,
    costed_pct_bp: 9800,
    gap_bp: 500,
    min_window_days: 1,
    min_costed_pct_bp: 8000,
    ...overrides,
  }
}

function fila(o: Partial<VarianceParetoRowOut>): VarianceParetoRowOut {
  return {
    ingredient_id: 1,
    ingredient_name: "Gaseosa",
    variance_value: -167500,
    abs_value: 167500,
    direction: "surplus",
    share_bp: 5060,
    cumulative_bp: 5060,
    level: "yellow",
    ...o,
  }
}

function varianza(o: Partial<VarianceOut>): VarianceOut {
  return {
    count_id: 5,
    opening_count_id: 2,
    window_from: "2026-09-21T21:39:43Z",
    window_to: "2026-09-22T14:00:00Z",
    available: true,
    reason: null,
    rows: [],
    yellow_threshold_bp: 200,
    red_threshold_bp: 400,
    latest_applied_count_id: 5,
    pareto: [
      fila({}),
      fila({ ingredient_id: 9, ingredient_name: "Limón", variance_value: -67416, abs_value: 67416, share_bp: 2036, cumulative_bp: 7096 }),
      fila({ ingredient_id: 1, ingredient_name: "Pechuga", variance_value: 45108, abs_value: 45108, direction: "shortage", share_bp: 1363, cumulative_bp: 8458, level: "red" }),
      fila({ ingredient_id: 2, ingredient_name: "Leche", variance_value: 28035, abs_value: 28035, direction: "shortage", share_bp: 1542, cumulative_bp: 10000, level: "red" }),
    ],
    total_abs_variance_value: 331058,
    shortage_value: 92143,
    surplus_value: -238915,
    net_variance_value: -146772,
    unvalued_rows: 0,
    ...o,
  }
}

describe("titular del food cost: real contra teórico con la brecha del servidor (analista #1)", () => {
  it("brecha positiva: «se pierden Z puntos» con los números del servidor", () => {
    expect(foodCostTitular(foodCost({}))).toBe(`Real 38,0${F}% vs teórico 33,0${F}%: se pierden 5,0 puntos`)
  })

  it("brecha negativa: se dice «por debajo», nunca «se pierden −15 puntos»", () => {
    const t = foodCostTitular(foodCost({ pct_bp: 1901, theoretical_pct_bp: 3421, gap_bp: -1520 }))
    expect(t).toBe(`Real 19,0${F}% vs teórico 34,2${F}%: el real queda 15,2 puntos por debajo`)
    expect(t).not.toMatch(/[-−]15/)
  })

  it("usa `gap_bp` tal como llega: no la recalcula restando real − teórico", () => {
    // Inconsistente a propósito: 38 − 33 = 5, pero el servidor dice 4,1.
    expect(foodCostTitular(foodCost({ gap_bp: 410 }))).toMatch(/se pierden 4,1 puntos$/)
  })

  it("sin food cost real (null) no hay titular: la pantalla dice el motivo", () => {
    expect(foodCostTitular(foodCost({ pct_bp: null, gap_bp: null }))).toBeNull()
  })

  it("sin teórico lo dice, no inventa la comparación", () => {
    expect(foodCostTitular(foodCost({ theoretical_pct_bp: null, gap_bp: null }))).toBe(
      `Food cost real 38,0${F}%; sin teórico con qué compararlo`,
    )
  })
})

describe("titular de la varianza: el total y cuántos insumos explican el 80 % (analista #12, científico #9)", () => {
  it("cuenta hasta el primer acumulado del servidor que llega a 80 %", () => {
    const v = varianza({})
    expect(insumosHasta80(v.pareto)).toBe(3)
    expect(varianceTitular(v)).toBe("$ 331.058 de varianza entre faltantes y sobrantes: 3 insumos explican el 80 %")
  })

  it("el sobrante se dice con palabra, sin el signo pegado (sin doble negación)", () => {
    expect(varianceDetalle(varianza({}))).toBe("$ 92.143 de faltante y $ 238.915 de sobrante")
  })

  it("los renglones sin costo se dicen «N sin costo, no entran»", () => {
    expect(varianceDetalle(varianza({ unvalued_rows: 2 }))).toBe(
      "$ 92.143 de faltante y $ 238.915 de sobrante · 2 insumos sin costo, no entran",
    )
  })

  it("un solo insumo dominante", () => {
    const v = varianza({ pareto: [fila({ cumulative_bp: 10000, share_bp: 10000 })], total_abs_variance_value: 167500 })
    expect(varianceTitular(v)).toBe("$ 167.500 de varianza entre faltantes y sobrantes: un solo insumo explica el 80 %")
  })

  it("sin renglones valorizados no inventa un $ 0", () => {
    expect(varianceTitular(varianza({ pareto: [], total_abs_variance_value: null }))).toBe(
      "Sin varianza valorizada entre estos dos conteos",
    )
  })
})

describe("formatos de la brecha y de la ventana", () => {
  it("puntos: la brecha entre porcentajes no lleva «%»", () => {
    expect(formatPuntos(210)).toBe("2,1 puntos")
    expect(formatPuntos(100)).toBe("1,0 punto")
    expect(formatPuntos(-1520)).toBe("−15,2 puntos")
    expect(formatPuntos(-1520, { sinSigno: true })).toBe("15,2 puntos")
    expect(formatPuntos(400, { corto: true })).toBe("4,0 pts")
    expect(formatPuntos(null)).toBe("—")
  })

  it("ventana: horas si no llega a un día, días completos si llega; fechas de Bogotá", () => {
    expect(textoVentana(16, 0, "2026-09-21T21:39:43Z", "2026-09-22T14:00:00Z")).toBe("16 h, del lun 21 sep al mar 22 sep")
    expect(textoVentana(480, 20, "2026-09-01T21:39:43Z", "2026-09-21T21:39:43Z")).toBe("20 días, del mar 1 sep al lun 21 sep")
    // 02:00 Z del 22 es todavía el 21 en Bogotá.
    expect(textoVentana(24, 1, "2026-09-20T02:00:00Z", "2026-09-22T02:00:00Z")).toBe("1 día, del sáb 19 sep al lun 21 sep")
    expect(textoVentana(null, null, null, null)).toBeUndefined()
  })
})
