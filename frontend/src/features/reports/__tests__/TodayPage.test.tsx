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
})
