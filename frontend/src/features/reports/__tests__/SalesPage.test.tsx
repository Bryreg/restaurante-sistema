import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { buildMe, renderWithProviders } from "@/test/utils"

import { SalesPage } from "../SalesPage"

vi.mock("@/app/storeContext", () => ({
  useStoreSelection: () => ({ stores: [{ id: 1, name: "Sede Centro" }], loading: false, activeStoreId: 1, setActiveStoreId: vi.fn() }),
}))

const { getSalesMock, getAccountantReportMock, getUnavailableLogMock } = vi.hoisted(() => ({
  getSalesMock: vi.fn(),
  getAccountantReportMock: vi.fn(),
  getUnavailableLogMock: vi.fn(),
}))

vi.mock("@/api/reports", async () => {
  const actual = await vi.importActual<typeof import("@/api/reports")>("@/api/reports")
  return {
    ...actual,
    getSales: getSalesMock,
    getAccountantReport: getAccountantReportMock,
    getUnavailableLog: getUnavailableLogMock,
  }
})

describe("SalesPage", () => {
  it("la pestaña «Ventas» muestra los totales del backend tal cual, sin recalcular nada", async () => {
    getSalesMock.mockResolvedValue({
      store_id: 1,
      date_from: "2026-09-09",
      date_to: "2026-09-15",
      group_by: "business_date",
      rows: [
        { key: "2026-09-15", label: "2026-09-15", gross: 100000, net: 92593, tax: 7407, tips: 9000, orders: 5, covers: 12, avg_ticket: 18519, avg_per_cover: 7716 },
      ],
      total: { key: "total", label: "total", gross: 100000, net: 92593, tax: 7407, tips: 9000, orders: 5, covers: 12, avg_ticket: 18519, avg_per_cover: 7716 },
    })

    renderWithProviders(<SalesPage />, { me: buildMe() })

    await waitFor(() => expect(screen.getAllByText("$ 92.593").length).toBeGreaterThan(0))
    expect(getSalesMock).toHaveBeenCalledWith(expect.objectContaining({ storeId: 1, groupBy: "business_date" }))
  })

  it("pedido 2a: costo teórico, margen bruto y cobertura de receta se pintan tal cual llegan, sin recalcular", async () => {
    getSalesMock.mockResolvedValue({
      store_id: 1,
      date_from: "2026-09-09",
      date_to: "2026-09-15",
      group_by: "business_date",
      rows: [
        {
          key: "2026-09-15", label: "2026-09-15", gross: 100000, net: 92593, tax: 7407, tips: 9000, orders: 5,
          covers: 12, avg_ticket: 18519, avg_per_cover: 7716,
          theoretical_value: 30000, gross_contribution: 62593, recipe_coverage_pct: 40,
        },
      ],
      total: {
        key: "total", label: "total", gross: 100000, net: 92593, tax: 7407, tips: 9000, orders: 5, covers: 12,
        avg_ticket: 18519, avg_per_cover: 7716,
        theoretical_value: 30000, gross_contribution: 62593, recipe_coverage_pct: 40,
      },
    })

    renderWithProviders(<SalesPage />, { me: buildMe() })

    await waitFor(() => expect(screen.getAllByText("$ 30.000").length).toBeGreaterThan(0))
    expect(screen.getAllByText("$ 62.593").length).toBeGreaterThan(0)
    // 40% < 50%: cobertura baja, el margen de al lado se avisa como no representativo.
    expect(screen.getAllByText("40%").length).toBeGreaterThan(0)
    expect(screen.getByText(/no representan toda la venta/i)).toBeInTheDocument()
  })

  it("costo/margen/cobertura `null` se muestran «sin costo»/«—», nunca $0 ni 0%", async () => {
    const bucket = {
      key: "2026-09-15", label: "2026-09-15", gross: 0, net: 0, tax: 0, tips: 0, orders: 0, covers: null,
      avg_ticket: null, avg_per_cover: null, theoretical_value: null, gross_contribution: null, recipe_coverage_pct: null,
    }
    getSalesMock.mockResolvedValue({
      store_id: 1, date_from: "2026-09-09", date_to: "2026-09-15", group_by: "business_date", rows: [bucket], total: bucket,
    })

    renderWithProviders(<SalesPage />, { me: buildMe() })

    await waitFor(() => expect(screen.getByText("Cobertura de receta")).toBeInTheDocument())
    expect(screen.queryByText("0%")).not.toBeInTheDocument()
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("cambiar de pestaña carga el informe del contador (una sola matemática: se pinta tal cual)", async () => {
    getSalesMock.mockResolvedValue({
      store_id: 1, date_from: "2026-09-09", date_to: "2026-09-15", group_by: "business_date", rows: [],
      total: { key: "total", label: "total", gross: 0, net: 0, tax: 0, tips: 0, orders: 0, covers: null, avg_ticket: null, avg_per_cover: null },
    })
    getAccountantReportMock.mockResolvedValue({
      store_id: 1, year: 2026, period_kind: "month", period: 9, date_from: "2026-09-01", date_to: "2026-09-30",
      rows: [], totals_by_method: [], documents_total_base: 500000, documents_total_tax: 40000,
      notes_total_base: 0, notes_total_tax: 0, tips_total: 20000,
    })

    const user = userEvent.setup()
    renderWithProviders(<SalesPage />, { me: buildMe() })

    await user.click(screen.getByRole("tab", { name: "Informe del contador" }))

    await waitFor(() => expect(screen.getByText("$ 500.000")).toBeInTheDocument())
  })
})
