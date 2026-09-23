import { describe, expect, it } from "vitest"

import { formatCantidad, formatDuracion, formatFechaCorta, formatPct } from "../format"

const FINO = " "

describe("formatPct — puntos básicos a «12,3 %» (es-CO)", () => {
  it("coma decimal y espacio fino antes del %", () => {
    expect(formatPct(1234)).toBe(`12,3${FINO}%`)
    expect(formatPct(1250, 0)).toBe(`13${FINO}%`)
    expect(formatPct(333, 2)).toBe(`3,33${FINO}%`)
    expect(formatPct(10000)).toBe(`100,0${FINO}%`)
  })

  it("cero es 0,0 %, y null/undefined es «—», nunca 0", () => {
    expect(formatPct(0)).toBe(`0,0${FINO}%`)
    expect(formatPct(null)).toBe("—")
    expect(formatPct(undefined)).toBe("—")
    expect(formatPct(Number.NaN)).toBe("—")
  })

  it("negativo conserva el signo", () => {
    expect(formatPct(-7775, 2)).toBe(`-77,75${FINO}%`)
  })
})

describe("formatDuracion", () => {
  it("horas y minutos, nunca «968 min»", () => {
    expect(formatDuracion(968)).toBe("16 h 8 min")
    expect(formatDuracion(120)).toBe("2 h")
    expect(formatDuracion(45)).toBe("45 min")
  })

  it("menos de un minuto no es «0 min»", () => {
    expect(formatDuracion(29 / 60)).toBe("< 1 min")
    expect(formatDuracion(0)).toBe("0 min")
    expect(formatDuracion(null)).toBe("—")
  })
})

describe("formatCantidad", () => {
  it("números es-CO con la unidad", () => {
    expect(formatCantidad(0.024, "unidad")).toBe("0,024 unidad")
    expect(formatCantidad(10000, "g")).toBe("10.000 g")
    expect(formatCantidad(1222.5, "ml")).toBe("1.222,5 ml")
  })

  it("acepta el texto decimal del backend y null es «—»", () => {
    expect(formatCantidad("0.024", "unidad")).toBe("0,024 unidad")
    expect(formatCantidad(null, "g")).toBe("—")
    expect(formatCantidad("", "g")).toBe("—")
  })
})

describe("formatFechaCorta", () => {
  it("«vie 18 sep» sin correrse de zona horaria", () => {
    expect(formatFechaCorta("2026-09-18")).toBe("vie 18 sep")
    expect(formatFechaCorta("2026-09-21")).toBe("lun 21 sep")
    expect(formatFechaCorta("2026-09-20T23:30:00-05:00")).toBe("dom 20 sep")
  })

  it("una fecha ilegible es «—»", () => {
    expect(formatFechaCorta("ayer")).toBe("—")
    expect(formatFechaCorta(null)).toBe("—")
  })
})
