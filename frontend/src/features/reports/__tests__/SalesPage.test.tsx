import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { formatPct } from "@/lib/format"
import { buildMe, renderWithProviders } from "@/test/utils"

/** Testing Library compara el texto normalizado a espacios comunes; `formatPct` usa espacio fino. */
const norm = (t: string): string => t.replace(/\s+/g, " ")

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
          theoretical_cost: 30000, gross_margin: 62593, costed_pct: 40,
        },
      ],
      total: {
        key: "total", label: "total", gross: 100000, net: 92593, tax: 7407, tips: 9000, orders: 5, covers: 12,
        avg_ticket: 18519, avg_per_cover: 7716,
        theoretical_cost: 30000, gross_margin: 62593, costed_pct: 40,
      },
    })

    renderWithProviders(<SalesPage />, { me: buildMe() })

    await waitFor(() => expect(screen.getAllByText("$ 30.000").length).toBeGreaterThan(0))
    expect(screen.getAllByText("$ 62.593").length).toBeGreaterThan(0)
    // 40% < 50%: cobertura baja, el margen de al lado se avisa como no representativo.
    // `costed_pct` 40 (por ciento entero) se escribe «40 %», como todo porcentaje.
    expect(screen.getAllByText(norm(formatPct(4000, 0))).length).toBeGreaterThan(0)
    expect(screen.getByText(/no representan toda la venta/i)).toBeInTheDocument()
  })

  it("costo/margen/cobertura `null` se muestran «sin costo»/«—», nunca $0 ni 0%", async () => {
    const bucket = {
      key: "2026-09-15", label: "2026-09-15", gross: 0, net: 0, tax: 0, tips: 0, orders: 0, covers: null,
      avg_ticket: null, avg_per_cover: null, theoretical_cost: null, gross_margin: null, costed_pct: null,
    }
    getSalesMock.mockResolvedValue({
      store_id: 1, date_from: "2026-09-09", date_to: "2026-09-15", group_by: "business_date", rows: [bucket], total: bucket,
    })

    renderWithProviders(<SalesPage />, { me: buildMe() })

    await waitFor(() => expect(screen.getByText("Cobertura de receta")).toBeInTheDocument())
    expect(screen.queryByText("0%")).not.toBeInTheDocument()
    expect(screen.queryByText(norm(formatPct(0, 0)))).not.toBeInTheDocument()
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

  // ---------------------------------------------------------------------
  // Revisión de datos (sep. 2026): comparación con el período anterior,
  // días sin abrir, la forma del gráfico según la agrupación, por plato.
  // ---------------------------------------------------------------------

  const day = (key: string, net: number, extra: Record<string, unknown> = {}) => ({
    key, label: key, gross: net, net, tax: 0, tips: 0, orders: net > 0 ? 10 : 0, covers: null,
    avg_ticket: null, avg_per_cover: null, share_bp: null, operated: true, ...extra,
  })
  const totalOf = (extra: Record<string, unknown> = {}) => ({
    key: "total", label: "total", gross: 5000000, net: 5000000, tax: 0, tips: 0, orders: 80, covers: null,
    avg_ticket: 62500, avg_per_cover: null, ...extra,
  })

  it("la cifra rectora se compara con el período anterior tal como lo manda el servidor (▼ y el neto de entonces)", async () => {
    getSalesMock.mockResolvedValue({
      store_id: 1, date_from: "2026-09-15", date_to: "2026-09-21", group_by: "business_date",
      rows: [day("2026-09-15", 5000000)],
      total: totalOf({
        previous_period: {
          date_from: "2026-09-08", date_to: "2026-09-14", net: 14494988, orders: 229, avg_ticket: 63297,
          delta_bp: -517, orders_delta_bp: -87, avg_ticket_delta_bp: -434, partial: false, null_reason: null,
        },
      }),
    })
    renderWithProviders(<SalesPage />, { me: buildMe() })

    await screen.findByText("Contra el período anterior (8 al 14 sep)")
    expect(screen.getByText(norm(`▼ ${formatPct(517)}`))).toBeInTheDocument()
    expect(screen.getByText("antes $ 14.494.988")).toBeInTheDocument()
  })

  it("sin período anterior con qué comparar, dice el motivo del servidor y nunca «0 %»", async () => {
    getSalesMock.mockResolvedValue({
      store_id: 1, date_from: "2026-09-15", date_to: "2026-09-21", group_by: "business_date",
      rows: [day("2026-09-15", 5000000)],
      total: totalOf({
        previous_period: {
          date_from: "2026-09-08", date_to: "2026-09-14", net: null, orders: null, avg_ticket: null,
          delta_bp: null, orders_delta_bp: null, avg_ticket_delta_bp: null, partial: false,
          null_reason: "La sede todavía no operaba en el período anterior: no hay contra qué comparar.",
        },
      }),
    })
    renderWithProviders(<SalesPage />, { me: buildMe() })

    const motivo = await screen.findByText(/La sede todavía no operaba en el período anterior/)
    const banda = motivo.closest("section") as HTMLElement
    expect(within(banda).getByText("Sin dato")).toBeInTheDocument()
    expect(banda.textContent).not.toMatch(/▲|▼|%/)
  })

  it("por día: columnas con «vie 18», el día pico en el titular y un día sin abrir como hueco (no como $ 0)", async () => {
    getSalesMock.mockResolvedValue({
      store_id: 1, date_from: "2026-09-17", date_to: "2026-09-20", group_by: "business_date",
      rows: [
        day("2026-09-17", 1254618, { share_bp: 2530 }),
        day("2026-09-18", 2218507, { share_bp: 4474 }),
        day("2026-09-19", 0, { share_bp: 0, operated: false }),
        day("2026-09-20", 0, { share_bp: 0, operated: true }),
        // `net` ausente (servidor viejo): sin dato, nunca una columna en 0.
        { key: "2026-09-21", label: "2026-09-21", gross: 0, tax: 0, tips: 0, orders: 0, covers: null, operated: true },
      ],
      total: totalOf({ share_bp: null }),
    })
    const { container } = renderWithProviders(<SalesPage />, { me: buildMe() })

    await screen.findByRole("heading", {
      name: `El vie 18 sep fue el día más fuerte: $ 2.218.507, ${formatPct(4474)} del período`,
    })
    expect(screen.getAllByText("vie 18").length).toBeGreaterThan(0)
    // Día que no abrió: hueco rayado; día que abrió y vendió $ 0: columna (0 es un hecho).
    expect(container.querySelector('[data-hueco="2026-09-19"]')).not.toBeNull()
    expect(container.querySelector('[data-columna="2026-09-19"]')).toBeNull()
    expect(container.querySelector('[data-columna="2026-09-20"]')).not.toBeNull()
    expect(container.querySelector('[data-hueco="2026-09-21"]')).not.toBeNull()
    expect(container.querySelector('[data-columna="2026-09-21"]')).toBeNull()
    expect(screen.getByText(/Rayado: un día que la sede no abrió/)).toBeInTheDocument()
    expect(screen.getAllByText("No abrió").length).toBeGreaterThan(0)
    // El gráfico va arriba de las tarjetas.
    const titular = screen.getByRole("heading", { name: /fue el día más fuerte/ })
    const tarjeta = screen.getByText("Ticket promedio")
    expect(titular.compareDocumentPosition(tarjeta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("por medio de pago: barra 100 % con la participación del servidor y los medios con mayúscula («Nequi»)", async () => {
    const m = (key: string, net: number, share_bp: number, payments: number) => ({
      key, label: key, gross: net, net, tax: 0, tips: 0, orders: payments, payments, covers: null,
      avg_ticket: null, avg_per_cover: null, costed_pct: null, share_bp,
    })
    getSalesMock.mockResolvedValue({
      store_id: 1, date_from: "2026-09-15", date_to: "2026-09-21", group_by: "method",
      rows: [m("cash", 6653000, 4842, 111), m("card", 3181918, 2316, 58), m("nequi", 2408320, 1752, 40), m("bre_b", 1500000, 1090, 12)],
      total: totalOf({ payments: 221 }),
    })
    const user = userEvent.setup()
    const { container } = renderWithProviders(<SalesPage />, { me: buildMe() })
    await screen.findByText("Ventas netas del período")

    await user.click(screen.getByRole("combobox", { name: "Agrupar por" }))
    await user.click(await screen.findByRole("option", { name: "Por medio de pago" }))

    await screen.findByRole("heading", { name: `Efectivo se lleva el ${formatPct(4842)} de la venta neta` })
    expect(getSalesMock).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: "method" }))
    expect(container.querySelectorAll("[data-segmento]")).toHaveLength(4)
    expect(screen.getAllByText("Nequi").length).toBeGreaterThan(0)
    expect(screen.queryByText("nequi")).not.toBeInTheDocument()
    expect(screen.getAllByText("Bre b").length).toBeGreaterThan(0)
    // Por medio cuenta pagos, no comandas.
    expect(screen.getByText(/Base: 221 pagos/)).toBeInTheDocument()
  })

  it("por plato: pide `group_by=product`, barras con las 7 más grandes y «y N más», unidades y sin columna de propinas", async () => {
    const p = (i: number, net: number) => ({
      key: String(i), label: `Plato ${i}`, gross: net, net, tax: 0, tips: null, orders: 5, covers: null,
      avg_ticket: null, avg_per_cover: null, share_bp: 1000, units: 12,
    })
    getSalesMock.mockResolvedValue({
      store_id: 1, date_from: "2026-09-15", date_to: "2026-09-21", group_by: "product",
      rows: Array.from({ length: 10 }, (_, i) => p(i + 1, 100000 * (10 - i))),
      total: totalOf({ units: 120 }),
    })
    const user = userEvent.setup()
    const { container } = renderWithProviders(<SalesPage />, { me: buildMe() })
    await screen.findByText("Ventas netas del período")

    await user.click(screen.getByRole("combobox", { name: "Agrupar por" }))
    await user.click(await screen.findByRole("option", { name: "Por plato" }))

    await screen.findByRole("heading", { name: `Plato 1 es el plato que más vende: ${formatPct(1000)} de la venta neta` })
    expect(getSalesMock).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: "product" }))
    expect(container.querySelectorAll("[data-barra]")).toHaveLength(7)
    expect(screen.getByRole("button", { name: "y 3 más" })).toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: "Unidades" })).toBeInTheDocument()
    expect(screen.queryByRole("columnheader", { name: "Propinas" })).not.toBeInTheDocument()
  })

  it("por categoría también se puede elegir (`group_by=category`)", async () => {
    getSalesMock.mockResolvedValue({
      store_id: 1, date_from: "2026-09-15", date_to: "2026-09-21", group_by: "category",
      rows: [{ key: "3", label: "Platos Fuertes", gross: 8558304, net: 8558304, tax: 0, tips: null, orders: 164, covers: null, avg_ticket: null, avg_per_cover: null, share_bp: 6229, units: 283 }],
      total: totalOf(),
    })
    const user = userEvent.setup()
    renderWithProviders(<SalesPage />, { me: buildMe() })
    await screen.findByText("Ventas netas del período")

    await user.click(screen.getByRole("combobox", { name: "Agrupar por" }))
    await user.click(await screen.findByRole("option", { name: "Por categoría" }))

    await screen.findByRole("heading", { name: `Platos Fuertes hace el ${formatPct(6229)} de la venta neta` })
    expect(getSalesMock).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: "category" }))
  })
})
