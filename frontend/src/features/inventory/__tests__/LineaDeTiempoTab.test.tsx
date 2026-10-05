import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { TimelineOut, TimelineRowOut } from "@/api/inventory"
import { buildMe, renderWithProviders } from "@/test/utils"

import { LineaDeTiempoTab } from "../LineaDeTiempoTab"

function fila(over: Partial<TimelineRowOut>): TimelineRowOut {
  return {
    ingredient_id: 1,
    name: "Pollo",
    base_unit: "g",
    key_item: false,
    min_stock: "1000",
    cost: "10",
    start_qty: "2000",
    in_qty: "3000",
    out_qty: "-2100",
    count_adjustment_qty: "0",
    end_qty: "2900",
    by_cause: [],
    value_out: 21000,
    value_out_partial: false,
    value_count_adjustment: null,
    seconds_below_min: 8 * 3600,
    seconds_at_zero: 2 * 3600,
    first_zero_at: "2026-01-14T18:00:00Z",
    points: [
      { at: "2026-01-14T12:00:00Z", qty: "500" },
      { at: "2026-01-14T18:00:00Z", qty: "-100" },
      { at: "2026-01-14T20:00:00Z", qty: "2900" },
    ],
    arrivals: [{ at: "2026-01-14T20:00:00Z", cause: "purchase", qty: "3000" }],
    counts: [
      {
        at: "2026-01-14T15:00:00Z",
        kind: "full",
        label: "Conteo completo",
        employee_name: "Admin",
        counted: "400",
        expected: "500",
        diff: "-100",
        diff_value: -1000,
      },
    ],
    ...over,
  }
}

const DATA: TimelineOut = {
  store_id: 1,
  date_from: "2026-01-14",
  date_to: "2026-01-14",
  start_at: "2026-01-14T11:00:00Z",
  end_at: "2026-01-15T11:00:00Z",
  now_at: "2026-01-15T11:00:00Z",
  summary: {
    ingredients: 2,
    with_movement: 1,
    value_out: 21000,
    value_out_partial: false,
    value_out_by_cause: [{ cause: "sale", movements: 1, qty: "-1500", value: 15000, uncosted: 0 }],
    value_count_shortage: -1000,
    value_count_surplus: 0,
    counts: 1,
    below_min: 1,
    hit_zero: 1,
    negative_now: 0,
  },
  rows: [
    fila({}),
    fila({
      ingredient_id: 2,
      name: "Arroz",
      value_out: null,
      out_qty: "0",
      seconds_at_zero: 0,
      seconds_below_min: 0,
      points: [],
      arrivals: [],
      counts: [],
    }),
  ],
}

const { getInventoryTimelineMock } = vi.hoisted(() => ({ getInventoryTimelineMock: vi.fn() }))

vi.mock("@/api/inventory", async () => {
  const actual = await vi.importActual<typeof import("@/api/inventory")>("@/api/inventory")
  return { ...actual, getInventoryTimeline: getInventoryTimelineMock }
})

describe("LineaDeTiempoTab", () => {
  it("dibuja el titular, una barra por insumo y lo que el servidor calculó, sin sumar nada", async () => {
    getInventoryTimelineMock.mockResolvedValue(DATA)
    renderWithProviders(<LineaDeTiempoTab storeId={1} />, { me: buildMe({}) })

    expect(await screen.findByText("Salió del estante")).toBeInTheDocument()
    expect(getInventoryTimelineMock).toHaveBeenCalledWith(expect.objectContaining({ storeId: 1, criticalOnly: false }))
    const pollo = document.querySelector('[data-insumo="1"]') as HTMLElement
    // El orden por defecto es la plata que salió: Pollo primero.
    expect(document.querySelector("[data-insumo]")).toBe(pollo)
    expect(within(pollo).getByText("2 h en cero")).toBeInTheDocument()
    expect(within(pollo).getByText("8 h bajo mín.")).toBeInTheDocument()
    expect(pollo.querySelectorAll('[data-tramo="cero"]').length).toBe(1)
    expect(pollo.querySelectorAll("[data-conteo]").length).toBe(1)
    expect(pollo.querySelectorAll("[data-llegada]").length).toBe(1)
    expect(within(pollo).getByRole("img").getAttribute("aria-label")).toMatch(/estuvo 2 h en cero/)

    // Lo que no se movió no dice «$ 0».
    const arroz = document.querySelector('[data-insumo="2"]') as HTMLElement
    expect(within(arroz).getByText("No salió")).toBeInTheDocument()
  })

  it("filtra lo que ya llegó y pasa a la tabla con la misma respuesta", async () => {
    getInventoryTimelineMock.mockResolvedValue(DATA)
    const user = userEvent.setup()
    renderWithProviders(<LineaDeTiempoTab storeId={1} />, { me: buildMe({}) })
    await screen.findByText("Salió del estante")

    await user.click(screen.getByRole("button", { name: "Se quedaron en cero" }))
    expect(document.querySelectorAll("[data-insumo]").length).toBe(1)

    await user.click(screen.getByRole("button", { name: "Tabla" }))
    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument())
    expect(screen.getByRole("link", { name: "Pollo" })).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Arroz" })).not.toBeInTheDocument()
  })
})
