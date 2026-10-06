/**
 * «Informe del contador» igual que café-sistema (decisión del dueño 2026-09),
 * con meta mensual y sin nómina. La pantalla sólo pinta lo que manda
 * `GET /admin/accountant-report`: ni promedios, ni porcentajes, ni deltas, ni
 * el avance de la meta se calculan acá.
 */
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { AccountantReportOut } from "@/api/reports"
import { formatPct } from "@/lib/format"
import { buildMe, renderWithProviders } from "@/test/utils"

import { AccountantReportPage } from "../AccountantReportTab"

/** Testing Library compara el texto normalizado a espacios comunes; `formatPct` usa espacio fino. */
const norm = (t: string): string => t.replace(/\s+/g, " ")

const stores = [
  { id: 1, name: "Sede Centro" },
  { id: 2, name: "Sede Norte" },
]
vi.mock("@/app/storeContext", () => ({
  useStoreSelection: () => ({ stores, loading: false, activeStoreId: 1, setActiveStoreId: vi.fn() }),
}))

const { getAccountantReportMock, putSalesGoalMock } = vi.hoisted(() => ({
  getAccountantReportMock: vi.fn(),
  putSalesGoalMock: vi.fn(),
}))

vi.mock("@/api/reports", async () => {
  const actual = await vi.importActual<typeof import("@/api/reports")>("@/api/reports")
  return { ...actual, getAccountantReport: getAccountantReportMock, putSalesGoal: putSalesGoalMock }
})

const sinMeta = {
  year: 2026, month: 3, amount: null, source: null, inherited_from: null,
  progress_bp: null, bar_bp: null, remaining: null, met: null, editable: true,
} as const

function informe(extra: Partial<AccountantReportOut> = {}): AccountantReportOut {
  return {
    store_id: 1, all_stores: false, year: 2026, period_kind: "month", period: 3,
    date_from: "2026-03-01", date_to: "2026-03-31",
    rows: [], totals_by_method: [],
    documents_total_base: 69_444, documents_total_tax: 5_556, notes_total_base: 0, notes_total_tax: 0, tips_total: 2_000,
    days: [
      {
        business_date: "2026-03-03", cash: 25_000, card: 25_000, transfer: 0, other: 0, total: 50_000,
        cumulative: 50_000, documents_count: 2, orders_count: 2, avg_ticket: 23_148, base: 46_296, tax: 3_704, credit_notes: 0, tips: 2_000,
      },
      {
        business_date: "2026-03-10", cash: 25_000, card: 0, transfer: 0, other: 0, total: 25_000,
        cumulative: 75_000, documents_count: 1, orders_count: 1, avg_ticket: 23_148, base: 23_148, tax: 1_852, credit_notes: 0, tips: 0,
      },
    ],
    summary: {
      total: 75_000, cash: 50_000, card: 25_000, transfer: 0, other: 0, documents_count: 3, orders_count: 3,
      days_with_sales: 2, days_in_period: 31, avg_daily_with_sales: 37_500, avg_daily_calendar: 2_419,
      avg_ticket: 23_148, base: 69_444, tax: 5_556, credit_notes: 0, tips: 2_000,
      shares: [
        { method: "cash", label: "Efectivo", amount: 50_000, share_bp: 6_667 },
        { method: "card", label: "Tarjeta", amount: 25_000, share_bp: 3_333 },
        { method: "transfer", label: "Transferencia", amount: 0, share_bp: 0 },
        { method: "other", label: "Otros", amount: 0, share_bp: 0 },
      ],
      best_day: { business_date: "2026-03-03", total: 50_000 },
      worst_day: { business_date: "2026-03-10", total: 25_000 },
      tax_by_rate: [{ rate: 8, base: 69_444, tax: 5_556 }],
    },
    comparison: {
      previous_year: 2026, previous_period: 2, previous_label: "Febrero 2026",
      total: { previous: 25_000, pct: 200 },
      avg_daily_calendar: { previous: 893, pct: 171 },
      avg_daily_with_sales: { previous: 25_000, pct: 50 },
      avg_ticket: { previous: 23_148, pct: 0 },
    },
    goal: { ...sinMeta },
    ...extra,
  }
}

beforeEach(() => {
  getAccountantReportMock.mockReset()
  putSalesGoalMock.mockReset()
})

describe("Informe del contador (como café-sistema)", () => {
  it("pinta la cabecera, las pastillas de sede, las tarjetas y la tabla diaria con su TOTAL, tal cual del servidor", async () => {
    getAccountantReportMock.mockResolvedValue(informe())
    renderWithProviders(<AccountantReportPage />, { me: buildMe() })

    await screen.findByText("Total del mes")
    // Cabecera: Mes, Año, Excel (CSV del servidor) y PDF (impresión).
    expect(screen.getByLabelText("Mes")).toBeInTheDocument()
    expect(screen.getByLabelText("Año")).toBeInTheDocument()
    const excel = screen.getByRole("link", { name: /Excel/ })
    expect(excel.getAttribute("href")).toContain("format=csv")
    expect(excel.getAttribute("href")).toContain("store_id=1")
    expect(screen.getByRole("button", { name: /PDF/ })).toBeEnabled()

    // Sedes: «Todas» y una pastilla por sede.
    const sedes = screen.getByRole("group", { name: "Sede del informe" })
    expect(within(sedes).getByRole("button", { name: "Todas" })).toBeInTheDocument()
    expect(within(sedes).getByRole("button", { name: "Sede Centro" })).toHaveAttribute("aria-pressed", "true")

    // Las cifras llegan hechas: promedios, participación y deltas.
    expect(screen.getAllByText("$ 75.000").length).toBeGreaterThan(0)
    expect(screen.getByText("$ 2.419")).toBeInTheDocument()
    expect(screen.getByText("$ 37.500")).toBeInTheDocument()
    expect(screen.getByText(norm(`▲ ${formatPct(20_000, 0)}`))).toBeInTheDocument()
    expect(screen.getByText(norm(`${formatPct(6_667, 0)} / ${formatPct(3_333, 0)}`))).toBeInTheDocument()
    expect(screen.getByText("03/03 · $ 50.000")).toBeInTheDocument()
    expect(screen.getByText("10/03 · $ 25.000")).toBeInTheDocument()
    // El ticket promedio es el de «Hoy»: neto sin impuesto ni propina ÷ comandas.
    expect(screen.getByText("sin impuesto ni propina · 3 comandas")).toBeInTheDocument()

    // Tabla diaria con tfoot TOTAL.
    const tabla = screen.getByRole("table", { name: /por día operativo/ })
    const filas = within(tabla).getAllByRole("row")
    expect(filas).toHaveLength(4) // cabecera + 2 días + TOTAL
    expect(within(filas[3]!).getByText("TOTAL")).toBeInTheDocument()
    expect(within(filas[3]!).getByText("$ 75.000")).toBeInTheDocument()

    // Lo fiscal que café no tenía sigue a la vista.
    expect(screen.getByText("Base de documentos")).toBeInTheDocument()
    expect(screen.getByText("Propinas del período (informativo)")).toBeInTheDocument()
    // La nota del PDF (sólo impresa) dice el eje de agrupación.
    expect(screen.getByText(/Agrupado por día operativo/)).toBeInTheDocument()
  })

  it("«Todas» pide store_id=all y la meta suma no se edita", async () => {
    getAccountantReportMock.mockResolvedValue(informe())
    const user = userEvent.setup()
    renderWithProviders(<AccountantReportPage />, { me: buildMe() })
    await screen.findByText("Total del mes")

    getAccountantReportMock.mockResolvedValue(
      informe({
        store_id: null, all_stores: true,
        goal: { ...sinMeta, amount: 150_000, source: "sum", progress_bp: 5_000, bar_bp: 5_000, remaining: 75_000, met: false, editable: false },
      }),
    )
    await user.click(screen.getByRole("button", { name: "Todas" }))
    await screen.findByText("(suma de las metas de cada sede)")
    expect(getAccountantReportMock).toHaveBeenLastCalledWith(expect.objectContaining({ storeId: "all" }))
    expect(screen.queryByRole("button", { name: "Editar meta" })).not.toBeInTheDocument()
  })

  it("sin ventas dice «sin documentos», nunca pinta ceros", async () => {
    getAccountantReportMock.mockResolvedValue(
      informe({
        days: [],
        summary: { ...informe().summary, total: 0, avg_ticket: null, best_day: null, worst_day: null },
      }),
    )
    renderWithProviders(<AccountantReportPage />, { me: buildMe() })
    await screen.findByText("Sin documentos en este período")
    expect(screen.getByRole("button", { name: /PDF/ })).toBeDisabled()
  })
})

describe("la meta del mes", () => {
  it("se define en el lugar: optimista, y la barra la trae el servidor", async () => {
    getAccountantReportMock.mockResolvedValue(informe())
    let resolver: (v: unknown) => void = () => {}
    putSalesGoalMock.mockReturnValue(new Promise((r) => (resolver = r)))
    const user = userEvent.setup()
    renderWithProviders(<AccountantReportPage />, { me: buildMe() })

    await screen.findByText("Sin meta: definila acá.")
    await user.type(screen.getByLabelText("Meta del mes"), "100000")
    await user.click(screen.getByRole("button", { name: "Guardar meta" }))

    expect(putSalesGoalMock).toHaveBeenCalledWith({ store_id: 1, year: expect.any(Number), month: expect.any(Number), amount: 100_000 })
    // Optimista: la meta se ve ya; el avance espera al servidor.
    await screen.findByText("$ 100.000")
    expect(screen.getByText("calculando…")).toBeInTheDocument()

    const conMeta = { ...sinMeta, amount: 100_000, source: "month" as const, progress_bp: 7_500, bar_bp: 7_500, remaining: 25_000, met: false }
    getAccountantReportMock.mockResolvedValue(informe({ goal: conMeta }))
    resolver(conMeta)
    await screen.findByText(norm(formatPct(7_500, 0)))
    expect(screen.getByText(/faltan \$ 25\.000/)).toBeInTheDocument()
    expect(screen.getByRole("progressbar", { name: "Avance de la meta" })).toHaveAttribute("aria-valuenow", "75")
  })

  it("si el servidor rechaza la meta, vuelve a la de antes y lo dice", async () => {
    const conMeta = { ...sinMeta, amount: 100_000, source: "month" as const, progress_bp: 7_500, bar_bp: 7_500, remaining: 25_000, met: false }
    getAccountantReportMock.mockResolvedValue(informe({ goal: conMeta }))
    putSalesGoalMock.mockRejectedValue(new Error("sin conexión"))
    const user = userEvent.setup()
    renderWithProviders(<AccountantReportPage />, { me: buildMe() })

    await screen.findByText("$ 100.000")
    await user.click(screen.getByRole("button", { name: "Editar meta" }))
    const campo = screen.getByLabelText("Meta del mes")
    await user.clear(campo)
    await user.type(campo, "50000")
    await user.click(screen.getByRole("button", { name: "Guardar meta" }))

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("No se guardó la meta"))
    expect(screen.getByText("$ 100.000")).toBeInTheDocument()
    expect(screen.getByText(/faltan \$ 25\.000/)).toBeInTheDocument()
  })

  it("con la meta cumplida lo dice y la barra topa en 100 %", async () => {
    getAccountantReportMock.mockResolvedValue(
      informe({ goal: { ...sinMeta, amount: 50_000, source: "month", progress_bp: 15_000, bar_bp: 10_000, remaining: 0, met: true } }),
    )
    renderWithProviders(<AccountantReportPage />, { me: buildMe() })
    await screen.findByText(/meta cumplida/)
    expect(screen.getByText(norm(formatPct(15_000, 0)))).toBeInTheDocument()
    expect(screen.getByRole("progressbar", { name: "Avance de la meta" })).toHaveAttribute("aria-valuenow", "100")
  })
})
