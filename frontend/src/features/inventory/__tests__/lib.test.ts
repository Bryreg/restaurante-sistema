import { describe, expect, it } from "vitest"

import { COUNT_QTY_SCALE, formatBasisPoints, parseCountInput } from "../lib"

describe("parseCountInput — parser propio de conteo (SPEC-NEGOCIO §5.4: texto decimal, coma, sumas «6+8»)", () => {
  it("un entero simple es válido", () => {
    expect(parseCountInput("500")).toEqual({ valid: true, value: "500" })
  })

  it("coma como separador decimal", () => {
    expect(parseCountInput("3,5")).toEqual({ valid: true, value: "3.5" })
  })

  it("punto como separador decimal", () => {
    expect(parseCountInput("3.5")).toEqual({ valid: true, value: "3.5" })
  })

  it("resuelve una suma «6+8»", () => {
    expect(parseCountInput("6+8")).toEqual({ valid: true, value: "14" })
  })

  it("resuelve una suma con decimales y espacios sueltos", () => {
    expect(parseCountInput(" 3,5 + 2,25 ")).toEqual({ valid: true, value: "5.75" })
  })

  // El caso que motiva este parser: 0.1 + 0.2 en punto flotante da
  // 0.30000000000000004 — acá tiene que dar EXACTAMENTE "0.3" porque se
  // suma en milésimas enteras, no en `float` de JS.
  it("0,1 + 0,2 da exactamente 0.3, no un residuo de punto flotante", () => {
    expect(parseCountInput("0,1+0,2")).toEqual({ valid: true, value: "0.3" })
  })

  it("hasta tres decimales (milésimas) es válido", () => {
    expect(parseCountInput("1,255")).toEqual({ valid: true, value: "1.255" })
  })

  it("más de tres decimales es inválido — mismo límite que el servidor (QTY_SCALE)", () => {
    expect(parseCountInput("1,2555")).toEqual({ valid: false, value: null })
  })

  it("vacío es inválido", () => {
    expect(parseCountInput("")).toEqual({ valid: false, value: null })
    expect(parseCountInput("   ")).toEqual({ valid: false, value: null })
  })

  it("texto no numérico es inválido y no se manda", () => {
    expect(parseCountInput("abc")).toEqual({ valid: false, value: null })
    expect(parseCountInput("12kg")).toEqual({ valid: false, value: null })
  })

  it("un signo negativo es inválido — un conteo físico no es negativo", () => {
    expect(parseCountInput("-5")).toEqual({ valid: false, value: null })
  })

  it("un término vacío en la suma («6+») es inválido", () => {
    expect(parseCountInput("6+")).toEqual({ valid: false, value: null })
    expect(parseCountInput("+6")).toEqual({ valid: false, value: null })
  })

  it("no interpreta resta ni multiplicación — sólo sumas, nunca eval genérico", () => {
    expect(parseCountInput("6-2")).toEqual({ valid: false, value: null })
    expect(parseCountInput("6*2")).toEqual({ valid: false, value: null })
  })

  it("propiedad: 1.000 sumas aleatorias de hasta 3 decimales no acumulan error de float", () => {
    for (let i = 0; i < 1000; i++) {
      const a = Math.floor(Math.random() * 100000)
      const b = Math.floor(Math.random() * 100000)
      const aText = (a / 1000).toString()
      const bText = (b / 1000).toString()
      const result = parseCountInput(`${aText}+${bText}`)
      expect(result.valid).toBe(true)
      const expectedMillis = a + b
      const expectedWhole = Math.floor(expectedMillis / 1000)
      const expectedFrac = expectedMillis % 1000
      const expectedFracStr = expectedFrac === 0 ? "" : String(expectedFrac).padStart(3, "0").replace(/0+$/, "")
      const expected = expectedFracStr ? `${expectedWhole}.${expectedFracStr}` : `${expectedWhole}`
      expect(result.value).toBe(expected)
    }
  })
})

describe("COUNT_QTY_SCALE — espejo declarado de QTY_SCALE del servidor (Ronda 2, H-7)", () => {
  it("es 1.000 (milésimas), la misma escala que backend/app/core/quantity.py::QTY_SCALE", () => {
    expect(COUNT_QTY_SCALE).toBe(1000)
  })

  it("un término con exactamente 3 decimales (el borde de COUNT_QTY_SCALE) es válido", () => {
    expect(parseCountInput("0,001")).toEqual({ valid: true, value: "0.001" })
  })

  it("un término con 4 decimales excede COUNT_QTY_SCALE y se rechaza — nunca se manda al servidor", () => {
    expect(parseCountInput("0,0001")).toEqual({ valid: false, value: null })
    expect(parseCountInput("1,2555")).toEqual({ valid: false, value: null })
  })
})

describe("formatBasisPoints — la ÚNICA función que sabe que 100 = 1 % (VarianceRowOut, WasteKpiOut, FoodCostOut, ControlHealthOut, InventorySettingsOut)", () => {
  it("null es «—», nunca 0 %", () => {
    expect(formatBasisPoints(null)).toBe("—")
    expect(formatBasisPoints(undefined)).toBe("—")
  })

  it("200 bp = 2 % (default de industria del umbral amarillo)", () => {
    expect(formatBasisPoints(200)).toBe("2 %")
  })

  it("400 bp = 4 % (default de industria del umbral rojo)", () => {
    expect(formatBasisPoints(400)).toBe("4 %")
  })

  it("250 bp = 2,5 %", () => {
    expect(formatBasisPoints(250)).toBe("2,5 %")
  })

  it("437 bp = 4,37 %", () => {
    expect(formatBasisPoints(437)).toBe("4,37 %")
  })

  it("205 bp = 2,05 % (no pierde el cero significativo del medio)", () => {
    expect(formatBasisPoints(205)).toBe("2,05 %")
  })

  it("0 bp = 0 % (distinto de null — hay dato, y es cero)", () => {
    expect(formatBasisPoints(0)).toBe("0 %")
  })

  it("negativo conserva el signo (food cost real puede dar negativo)", () => {
    expect(formatBasisPoints(-250)).toBe("-2,5 %")
  })
})
