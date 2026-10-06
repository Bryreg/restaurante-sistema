import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { MiseOut } from "@/api/recipes"
import { buildMe, renderWithProviders } from "@/test/utils"

import { MiseEnPlace } from "../MiseEnPlace"

const { getMiseEnPlaceMock } = vi.hoisted(() => ({ getMiseEnPlaceMock: vi.fn() }))
vi.mock("@/api/recipes", async () => {
  const actual = await vi.importActual<typeof import("@/api/recipes")>("@/api/recipes")
  return { ...actual, getMiseEnPlace: getMiseEnPlaceMock }
})

const DATA: MiseOut = {
  business_date: "2026-10-06",
  window_from: "2026-09-22",
  window_to: "2026-10-05",
  to_produce_count: 1,
  rows: [
    {
      preparation_id: 1, name: "Caldo", unit: "g", stock: "300", par: "3000", avg_daily_use: "50",
      days_of_cover: "6.0", to_produce: "2700", batches: 3, batch_yield: "1000", suggested_par: "60",
      shelf_life_days: 3, status: "producir",
    },
    {
      preparation_id: 2, name: "Sofrito", unit: "g", stock: "720", par: null, avg_daily_use: "20",
      days_of_cover: "36.0", to_produce: null, batches: null, batch_yield: "1000", suggested_par: "24",
      shelf_life_days: null, status: "sin_par",
    },
  ],
}

describe("MiseEnPlace", () => {
  it("dice qué producir y en cuántas tandas, y sugiere un par donde no lo hay", async () => {
    getMiseEnPlaceMock.mockResolvedValue(DATA)
    renderWithProviders(<MiseEnPlace storeId={1} />, { me: buildMe({}) })

    expect(await screen.findByText("Producir 2700 g · 3 tandas de 1000 g")).toBeInTheDocument()
    expect(screen.getByText("1 por producir")).toBeInTheDocument()
    expect(screen.getByText("Sin par · sugerido 24 g")).toBeInTheDocument()
  })
})
