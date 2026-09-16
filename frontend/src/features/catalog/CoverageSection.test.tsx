import { screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders } from "@/test/utils"

import { CoverageSection } from "./CoverageSection"

const { getRecipeCoverageMock } = vi.hoisted(() => ({ getRecipeCoverageMock: vi.fn() }))

vi.mock("@/api/recipes", async () => {
  const actual = await vi.importActual<typeof import("@/api/recipes")>("@/api/recipes")
  return { ...actual, getRecipeCoverage: getRecipeCoverageMock }
})

describe("CoverageSection", () => {
  it("lista los platos que se vendieron sin descontar nada", async () => {
    getRecipeCoverageMock.mockResolvedValue([
      { product_id: 3, product_name: "Gaseosa", items_sold: 12, qty_sold: 14 },
    ])
    renderWithProviders(<CoverageSection storeId={1} />)

    await waitFor(() => expect(screen.getByText("Gaseosa")).toBeInTheDocument())
    expect(screen.getByText("12")).toBeInTheDocument()
    expect(screen.getByText("14")).toBeInTheDocument()
    expect(getRecipeCoverageMock).toHaveBeenCalledWith(1, { dateFrom: undefined, dateTo: undefined })
  })

  it("sin filas dice que todo lo vendido descontó algo, no dibuja una tabla vacía como si fuera cero", async () => {
    getRecipeCoverageMock.mockResolvedValue([])
    renderWithProviders(<CoverageSection storeId={1} />)

    await waitFor(() =>
      expect(screen.getByText("Todo lo que se vendió en el período descontó algo")).toBeInTheDocument(),
    )
  })
})
