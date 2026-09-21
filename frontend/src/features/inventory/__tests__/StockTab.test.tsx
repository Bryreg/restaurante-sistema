import { screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders } from "@/test/utils"

import { StockTab } from "../StockTab"

const { getInventoryStockMock } = vi.hoisted(() => ({ getInventoryStockMock: vi.fn() }))

vi.mock("@/api/inventory", async () => {
  const actual = await vi.importActual<typeof import("@/api/inventory")>("@/api/inventory")
  return { ...actual, getInventoryStock: getInventoryStockMock }
})

describe("StockTab — «negativo» y «bajo mínimo» son alertas distintas (SPEC-NEGOCIO §5.2)", () => {
  it("un insumo negativo se ve distinto (rojo, «deuda de registro») de uno sólo bajo mínimo (ámbar, «reponé»)", async () => {
    getInventoryStockMock.mockResolvedValue([
      {
        ingredient_id: 1,
        name: "Helado de vainilla",
        base_unit: "g",
        qty_base: "-400",
        min_stock: "2000",
        below_min: true,
        negative: true,
        negative_since: "2026-06-15T00:00:00Z",
        cost: null,
        cost_source: "none",
        key_item: false,
      },
      {
        ingredient_id: 2,
        name: "Papa criolla",
        base_unit: "g",
        qty_base: "500",
        min_stock: "1000",
        below_min: true,
        negative: false,
        negative_since: null,
        cost: "3500",
        cost_source: "estimated",
        key_item: true,
      },
      {
        ingredient_id: 3,
        name: "Arroz",
        base_unit: "g",
        qty_base: "5000",
        min_stock: "1000",
        below_min: false,
        negative: false,
        negative_since: null,
        cost: "2000",
        cost_source: "official",
        key_item: false,
      },
    ])

    renderWithProviders(<StockTab storeId={1} />)

    await waitFor(() => expect(screen.getByText("Helado de vainilla")).toBeInTheDocument())

    const rows = screen.getAllByRole("row")
    const heladoRow = within(rows.find((r) => r.textContent?.includes("Helado de vainilla"))!)
    const papaRow = within(rows.find((r) => r.textContent?.includes("Papa criolla"))!)
    const arrozRow = within(rows.find((r) => r.textContent?.includes("Arroz"))!)

    // La fila dice LA PALABRA; el significado vive en la leyenda del pie, una
    // sola vez (`docs/PATRONES-ADMIN.md` § 8d) en vez de repetirse en cada
    // renglón — que era lo que hacía crecer la fila por encima de los 34 px.
    // Lo que esta prueba defiende es que las dos NO se confundan.
    expect(heladoRow.getByText("Negativo")).toBeInTheDocument()
    expect(heladoRow.queryByText(/agotado/i)).not.toBeInTheDocument()

    // Bajo mínimo (sin ser negativo): palabra DISTINTA, y sin la de negativo.
    expect(papaRow.getByText("Bajo mínimo")).toBeInTheDocument()
    expect(papaRow.queryByText("Negativo")).not.toBeInTheDocument()

    // Al día: sin ninguna de las dos alertas.
    expect(arrozRow.getByText("Al día")).toBeInTheDocument()

    // La leyenda sostiene la distinción, y la sostiene ENTERA: deuda de
    // registro (no bloquea la venta) contra reposición.
    const legend = within(screen.getByRole("table").parentElement!.parentElement!)
    expect(legend.getByText(/deuda de registro/i)).toBeInTheDocument()
    expect(legend.getByText(/no bloquea la venta/i)).toBeInTheDocument()
    expect(legend.getByText(/reposición/i)).toBeInTheDocument()

    // Costo null se dice "Sin costo", nunca $0.
    expect(heladoRow.getByText("Sin costo")).toBeInTheDocument()
    expect(within(screen.getByRole("table")).queryByText("$ 0")).not.toBeInTheDocument()
  })

  it("los filtros críticos/bajo mínimo/negativos se mandan al servidor, nunca se cruzan en el cliente", async () => {
    getInventoryStockMock.mockResolvedValue([])
    renderWithProviders(<StockTab storeId={7} initialNegative initialBelowMin />)

    await waitFor(() =>
      expect(getInventoryStockMock).toHaveBeenCalledWith(
        expect.objectContaining({ storeId: 7, negative: true, belowMin: true, criticalOnly: false }),
      ),
    )
  })
})
