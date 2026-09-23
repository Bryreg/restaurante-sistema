import { screen, waitFor, within } from "@testing-library/react"
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
    expect(screen.getByText(/^32,0\s%$/)).toBeInTheDocument()
    expect(getVarianceByDishMock).toHaveBeenCalledWith({ storeId: 1 })
  })

  it("titular con el neto y el faltante más grande, faltantes primero en las barras, y el aviso de muestra chica con el motivo del servidor", async () => {
    const data: VarianceByDishOut = {
      method: "prorated",
      available: true,
      reason: null,
      window_from: "2026-09-21T21:39:43Z",
      window_to: "2026-09-22T14:00:00Z",
      total_variance_value: -146772,
      unattributed_variance_value: 19000,
      window_hours: 16,
      window_days: 0,
      sales_in_window: 16,
      insufficient_sample: true,
      insufficient_sample_reason:
        "Muestra insuficiente: la ventana entre conteos dura 16 h (hacen falta al menos 3 días) y se cobraron 16 comandas en la ventana (hacen falta al menos 20); el reparto por plato es orientativo",
      min_window_days: 3,
      min_sales_in_window: 20,
      rows: [
        { product_id: 11, product_name: "Pechuga a la plancha", theoretical_consumption_share_bp: 4786, variance_value: 33021, ingredients_involved: 2, direction: "shortage" },
        { product_id: 6, product_name: "Ajiaco", theoretical_consumption_share_bp: 1465, variance_value: 9086, ingredients_involved: 2, direction: "shortage" },
        { product_id: 17, product_name: "Gaseosa", theoretical_consumption_share_bp: 2052, variance_value: -167500, ingredients_involved: 1, direction: "surplus" },
      ],
    }
    getVarianceByDishMock.mockResolvedValue(data)
    const { container } = renderWithProviders(<VarianceByDishTab storeId={1} />)

    expect(
      await screen.findByRole("heading", {
        name: "Sobran $ 146.772 netos en la ventana; el faltante más grande es Pechuga a la plancha, $ 33.021",
      }),
    ).toBeInTheDocument()
    // Muestra chica: el motivo del SERVIDOR, tal cual.
    expect(screen.getByText(/la ventana entre conteos dura 16 h \(hacen falta al menos 3 días\)/)).toBeInTheDocument()
    expect(screen.getByText(/Base: 16 comandas · 16 h, del lun 21 sep al mar 22 sep/)).toBeInTheDocument()

    // Barras divergentes en el orden del servidor: faltantes primero.
    const barras = container.querySelectorAll("[data-fila]")
    expect([...barras].map((b) => b.getAttribute("data-fila"))).toEqual(["11", "6", "17"])
    // Sin la doble negación: la barra del sobrante dice «$ 167.500 sobrante», no «−$ 167.500 sobrante».
    const gaseosa = container.querySelector('[data-fila="17"]')!
    expect(within(gaseosa as HTMLElement).getByText("$ 167.500")).toBeInTheDocument()
    expect(gaseosa.textContent).not.toMatch(/[-−]\s*\$/)
    expect(gaseosa.querySelector('[data-barra="sobra"]')).not.toBeNull()
    expect(container.querySelector('[data-fila="11"] [data-barra="falta"]')).not.toBeNull()
    // El signo del servidor sigue en la tabla, en su propia columna.
    const tabla = screen.getByRole("table")
    expect(within(tabla).getByText("-$ 167.500")).toBeInTheDocument()
    expect(within(tabla).getAllByText("Sobrante").length).toBe(1)
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
