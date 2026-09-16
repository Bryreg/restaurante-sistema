import { screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { buildMe, renderWithProviders } from "@/test/utils"

import { TodayPage } from "../TodayPage"

vi.mock("@/app/storeContext", () => ({
  useStoreSelection: () => ({ stores: [{ id: 1, name: "Sede Centro" }], loading: false, activeStoreId: 1, setActiveStoreId: vi.fn() }),
}))

const { getTodayMock } = vi.hoisted(() => ({ getTodayMock: vi.fn() }))

vi.mock("@/api/reports", async () => {
  const actual = await vi.importActual<typeof import("@/api/reports")>("@/api/reports")
  return { ...actual, getToday: getTodayMock }
})

function baseToday(overrides: Partial<Awaited<ReturnType<typeof getTodayMock>>> = {}) {
  return {
    store_id: 1,
    business_date: "2026-09-15",
    sales_by_hour: [{ hour: 12, gross: 100000, net: 92593 }],
    gross: 100000,
    net: 92593,
    tax: 7407,
    tips_total: 9000,
    tips_by_method: [{ method: "cash", amount: 9000 }],
    orders: 5,
    covers: 12,
    avg_ticket: 18519,
    avg_per_cover: 7716,
    tables_occupied: 2,
    tables_total: 8,
    open_orders: [],
    unsent_count: 0,
    unpaid_count: 0,
    expected_cash: 250000,
    unavailable_products: [],
    pending_refunds_count: 0,
    unreviewed_closes_count: 0,
    alerts: [],
    ingredients_below_min: [],
    ingredients_negative: [],
    preps_without_production: [],
    products_discounting_nothing: [],
    ...overrides,
  }
}

describe("TodayPage", () => {
  it("muestra el pulso del día: ventas netas grande y primero, con el resto como contexto", async () => {
    getTodayMock.mockResolvedValue(baseToday())

    renderWithProviders(<TodayPage />, { me: buildMe() })

    await waitFor(() => expect(screen.getByText("Ventas netas de hoy")).toBeInTheDocument())
    expect(screen.getAllByText("$ 92.593").length).toBeGreaterThan(0)
    expect(screen.getByText(/2\/8/)).toBeInTheDocument() // mesas ocupadas
    expect(screen.getByText("Todo al día")).toBeInTheDocument()
  })

  it("«sin turno abierto» aparece cuando expected_cash es null, nunca como $0", async () => {
    getTodayMock.mockResolvedValue(baseToday({ expected_cash: null }))

    renderWithProviders(<TodayPage />, { me: buildMe() })

    await waitFor(() => expect(screen.getAllByText("Sin turno abierto").length).toBeGreaterThan(0))
    expect(screen.queryByText("$ 0")).not.toBeInTheDocument()
  })

  it("una alerta de tipo conocido (fiscal_range_low) se lista con su enlace correctivo", async () => {
    getTodayMock.mockResolvedValue(
      baseToday({
        alerts: [
          {
            type: "fiscal_range_low",
            level: "warning",
            title: "Rango por agotarse",
            body: "El rango POS-A está al 80% de consumo.",
            created_at: "2026-09-15T12:00:00Z",
            payload: null,
          },
        ],
      }),
    )

    renderWithProviders(<TodayPage />, { me: buildMe() })

    await waitFor(() => expect(screen.getByText("Rango por agotarse")).toBeInTheDocument())
    const link = screen.getByRole("link", { name: /Rango por agotarse/i })
    expect(link).toHaveAttribute("href", "/admin/fiscal/rangos")
  })

  it("un agotado no aparece dos veces (tarjeta directa + alerta product_unavailable)", async () => {
    getTodayMock.mockResolvedValue(
      baseToday({
        unavailable_products: [{ product_id: 9, name: "Limonada", unavailable_at: "2026-09-15T10:00:00Z", by: null }],
        alerts: [
          {
            type: "product_unavailable",
            level: "info",
            title: "Producto agotado",
            body: "Limonada se marcó agotada.",
            created_at: "2026-09-15T10:00:00Z",
            payload: null,
          },
        ],
      }),
    )

    renderWithProviders(<TodayPage />, { me: buildMe() })

    await waitFor(() => expect(screen.getByText(/1 producto agotado/i)).toBeInTheDocument())
    expect(screen.queryByText("Producto agotado")).not.toBeInTheDocument()
  })

  it("insumos «bajo mínimo» y «negativos» son dos alertas distintas (pedido 2a), con enlaces distintos a Stock", async () => {
    getTodayMock.mockResolvedValue(
      baseToday({
        ingredients_below_min: [{ ingredient_id: 1, name: "Papa criolla", qty_base: 400, min_stock: 1000, base_unit: "g" }],
        ingredients_negative: [
          { ingredient_id: 2, name: "Leche entera", qty_base: -400, min_stock: 2000, base_unit: "ml", negative_since: "2026-09-01T00:00:00Z", probable_cause: null },
        ],
      }),
    )

    renderWithProviders(<TodayPage />, { me: buildMe() })

    const belowMinTitle = await screen.findByText(/1 insumo bajo el mínimo/i)
    const negativeTitle = await screen.findByText(/1 insumo en negativo/i)
    expect(belowMinTitle).toBeInTheDocument()
    expect(negativeTitle).toBeInTheDocument()

    const belowMinLink = screen.getByRole("link", { name: /1 insumo bajo el mínimo/i })
    const negativeLink = screen.getByRole("link", { name: /1 insumo en negativo/i })
    expect(belowMinLink).toHaveAttribute("href", "/admin/inventario?tab=stock&below_min=1")
    expect(negativeLink).toHaveAttribute("href", "/admin/inventario?tab=stock&negative=1")
    // "deuda de registro" (negativo) nunca se confunde con "bajo mínimo": textos propios.
    expect(screen.getByText(/deuda de registro/i)).toBeInTheDocument()
    expect(screen.getByText(/reponé pronto/i)).toBeInTheDocument()
  })

  it("preparaciones sin producir y platos sin receta llevan a Preparaciones y a Carta respectivamente", async () => {
    getTodayMock.mockResolvedValue(
      baseToday({
        preps_without_production: [{ type: "prep_no_production", preparation_id: 5, preparation_name: "Caldo base", current_stock: -200, unit: "ml" }],
        products_discounting_nothing: [{ product_id: 9, product_name: "Sopa del día", items_sold: 3, qty_sold: 3 }],
      }),
    )

    renderWithProviders(<TodayPage />, { me: buildMe() })

    const prepLink = await screen.findByRole("link", { name: /preparación por lote sin producir/i })
    expect(prepLink).toHaveAttribute("href", "/admin/preparaciones")

    const uncostedLink = screen.getByRole("link", { name: /plato vendido sin descontar nada/i })
    expect(uncostedLink).toHaveAttribute("href", "/admin/carta")
  })
})
