import { describe, expect, it } from "vitest"

import type { ZoneStatusOut } from "@/api/orders"

import { mergeAlerts, newlyReady, readyCountsOf } from "../readyAlerts"

function zones(counts: Record<number, number>): ZoneStatusOut[] {
  return [
    {
      id: 1,
      name: "Salón",
      tables: Object.entries(counts).map(([id, n]) => ({ id: Number(id), number: id, order_id: 100 + Number(id), ready_count: n })),
    },
  ]
}

describe("aviso de plato listo", () => {
  it("la primera lectura es la base: no avisa lo que ya estaba listo", () => {
    expect(newlyReady(null, zones({ 1: 2 }))).toEqual([])
  })

  it("avisa sólo la mesa cuyo conteo de listos subió, con el número del servidor", () => {
    const prev = readyCountsOf(zones({ 1: 1, 2: 0, 3: 2 }))
    const alerts = newlyReady(prev, zones({ 1: 1, 2: 1, 3: 1 }))
    expect(alerts).toEqual([{ tableId: 2, tableNumber: "2", orderId: 102, readyCount: 1 }])
  })

  it("una mesa tiene un solo aviso, y se va solo cuando ya no tiene nada listo", () => {
    const current = [
      { tableId: 1, tableNumber: "1", orderId: 101, readyCount: 1 },
      { tableId: 2, tableNumber: "2", orderId: 102, readyCount: 1 },
    ]
    const incoming = [{ tableId: 1, tableNumber: "1", orderId: 101, readyCount: 2 }]
    const merged = mergeAlerts(current, incoming, readyCountsOf(zones({ 1: 2, 2: 0 })))
    expect(merged).toEqual([{ tableId: 1, tableNumber: "1", orderId: 101, readyCount: 2 }])
  })
})
