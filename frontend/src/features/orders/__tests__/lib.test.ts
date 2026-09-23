import { describe, expect, it } from "vitest"

import { findMergeableLine, groupByCourse, nextRoundNo, productNeedsOptions, unsentItemCount, unsentQtyByProduct } from "../lib"
import { buildCatalogProduct, buildOrderItem } from "./fixtures"

describe("conteos de la ronda sin enviar (unidades, nunca plata)", () => {
  const items = [
    buildOrderItem({ id: 1, product_id: 10, qty: 2 }),
    buildOrderItem({ id: 2, product_id: 10, qty: 1, note: "sin hielo" }),
    buildOrderItem({ id: 3, product_id: 11, qty: 4, status: "sent", round_no: 1 }),
    buildOrderItem({ id: 4, product_id: null, combo_id: 20, qty: 1 }),
    buildOrderItem({ id: 5, product_id: 12, qty: 1, status: "voided" }),
  ]

  it("unsentQtyByProduct suma qty pendiente por producto y por combo", () => {
    const { products, combos } = unsentQtyByProduct(items)
    expect(products.get(10)).toBe(3)
    expect(products.has(11)).toBe(false)
    expect(products.has(12)).toBe(false)
    expect(combos.get(20)).toBe(1)
  })

  it("unsentItemCount es la suma de qty pendiente", () => {
    expect(unsentItemCount(items)).toBe(4)
    expect(unsentItemCount([])).toBe(0)
  })

  it("nextRoundNo es una más que la última ronda enviada", () => {
    expect(nextRoundNo([{ round_no: 1 }, { round_no: 2 }], [])).toBe(3)
    expect(nextRoundNo(undefined, items)).toBe(2)
    expect(nextRoundNo([], [])).toBe(1)
  })
})

describe("toque rápido", () => {
  it("productNeedsOptions sólo con un grupo obligatorio y pos.modifiers encendida", () => {
    const group = { id: 1, product_id: 10, name: "Término", sort_order: 1, options: [], max: 1 }
    const required = buildCatalogProduct({ modifier_groups: [{ ...group, required: true, min: 1 }] })
    const optional = buildCatalogProduct({ modifier_groups: [{ ...group, required: false, min: 0 }] })
    expect(productNeedsOptions(required, true)).toBe(true)
    expect(productNeedsOptions(required, false)).toBe(false)
    expect(productNeedsOptions(optional, true)).toBe(false)
  })

  it("findMergeableLine no suma sobre una línea con nota, modificadores, asiento, descuento, cortesía u otro curso", () => {
    const product = buildCatalogProduct({ id: 10, default_course: "beverage" })
    const plain = buildOrderItem({ id: 9, product_id: 10 })
    expect(findMergeableLine([plain], product)).toBe(plain)
    for (const override of [
      { note: "sin hielo" },
      { modifiers: [{ option_id: 1, name: "Hielo", price_delta: 0 }] },
      { seat: 2 },
      { discount: 500 },
      { courtesy: { reason: "complaint" as const, note: null, authorized_by: { id: 1, name: "Admin" }, at: "2026-09-15T18:00:00Z" } },
      { course: "dessert" },
      { status: "sent" as const },
    ]) {
      expect(findMergeableLine([buildOrderItem({ product_id: 10, ...override })], product)).toBeUndefined()
    }
  })
})

describe("groupByCourse", () => {
  it("ordena por salida (bebida, entrada, fuerte, postre) y deja lo desconocido al final", () => {
    const groups = groupByCourse([
      { id: 1, course: "dessert" },
      { id: 2, course: "otro" },
      { id: 3, course: "main" },
      { id: 4, course: "beverage" },
      { id: 5, course: "main" },
    ])
    expect(groups.map((g) => g.course)).toEqual(["beverage", "main", "dessert", "otro"])
    expect(groups[1].items.map((i) => i.id)).toEqual([3, 5])
  })
})
