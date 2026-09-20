import { screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { VarianceByDishOut } from "@/api/analytics"
import { renderWithProviders } from "@/test/utils"

import { VarianceByDishTab } from "../VarianceByDishTab"

const { getVarianceByDishMock } = vi.hoisted(() => ({ getVarianceByDishMock: vi.fn() }))

vi.mock("@/api/analytics", async () => {
  const actual = await vi.importActual<typeof import("@/api/analytics")>("@/api/analytics")
  return { ...actual, getVarianceByDish: getVarianceByDishMock }
})

describe("VarianceByDishTab — SPEC-NEGOCIO §5.4: sólo estimación PRORRATEADA, mostrado en pantalla", () => {
  it('muestra el método "prorated" en pantalla, no sólo en la respuesta', async () => {
    const data: VarianceByDishOut = {
      method: "prorated",
      available: true,
      reason: null,
      rows: [{ product_id: 1, product_name: "Hamburguesa", theoretical_consumption_share_bp: 3200, variance_value: 4500, ingredients_involved: 2 }],
    }
    getVarianceByDishMock.mockResolvedValue(data)
    renderWithProviders(<VarianceByDishTab storeId={1} />)

    await waitFor(() => expect(screen.getByText("prorated", { exact: false })).toBeInTheDocument())
    expect(screen.getByText(/ESTIMACIÓN prorrateada/)).toBeInTheDocument()
    expect(screen.getByText("Hamburguesa")).toBeInTheDocument()
    expect(screen.getByText("32 %")).toBeInTheDocument()
    expect(getVarianceByDishMock).toHaveBeenCalledWith({ storeId: 1 })
  })

  it("sin conteos completos, dice el motivo en vez de una tabla vacía muda", async () => {
    const unavailable: VarianceByDishOut = {
      method: "prorated",
      available: false,
      reason: "Hacen falta dos conteos completos aplicados y consecutivos.",
      rows: [],
    }
    getVarianceByDishMock.mockResolvedValue(unavailable)
    renderWithProviders(<VarianceByDishTab storeId={1} />)

    expect(await screen.findByText("Varianza por plato no disponible")).toBeInTheDocument()
    expect(screen.getByText("Hacen falta dos conteos completos aplicados y consecutivos.")).toBeInTheDocument()
  })
})
