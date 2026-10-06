import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { PnlOut } from "@/api/expenses"
import type { ManagementOut, ReliabilityOut, TodayMonthOut } from "@/api/reports"
import { buildMe, renderWithProviders } from "@/test/utils"

import { BannerConfiabilidad } from "../gestion/Confiabilidad"
import { EstadoResultados } from "../gestion/EstadoResultados"
import { GestionDelPeriodo } from "../gestion/Gestion"
import { MesEnCurso } from "../hoy/MesEnCurso"

const { getTodayMonthMock, getMonthlyPnlMock, putPnlBudgetMock } = vi.hoisted(() => ({
  getTodayMonthMock: vi.fn(),
  getMonthlyPnlMock: vi.fn(),
  putPnlBudgetMock: vi.fn(),
}))

vi.mock("@/api/reports", async () => {
  const actual = await vi.importActual<typeof import("@/api/reports")>("@/api/reports")
  return { ...actual, getTodayMonth: getTodayMonthMock }
})
vi.mock("@/api/expenses", async () => {
  const actual = await vi.importActual<typeof import("@/api/expenses")>("@/api/expenses")
  return { ...actual, getMonthlyPnl: getMonthlyPnlMock, putPnlBudget: putPnlBudgetMock }
})

const texto = (s: string): string => s.replace(/\s+/g, " ")

const CONFIABLE: ReliabilityOut = { date_from: "2026-03-01", date_to: "2026-03-10", reliable: true, items: [] }

const DUDOSO: ReliabilityOut = {
  date_from: "2026-03-01",
  date_to: "2026-03-10",
  reliable: false,
  items: [
    {
      key: "payroll_no_tables",
      severity: "critical",
      title: "No hay tabla de recargos de nómina",
      detail: "Sin ella la nómina no se calcula.",
      affects: "Nómina, costo primo, utilidad",
      count: null,
    },
    {
      key: "inventory_stale",
      severity: "warning",
      title: "El inventario no se cuenta hace 20 días",
      detail: "El costo real se aleja.",
      affects: "Stock, costo real",
      count: 20,
    },
  ],
}

const GESTION: ManagementOut = {
  store_id: 1,
  date_from: "2026-03-10",
  date_to: "2026-03-10",
  reliability: CONFIABLE,
  turnover: {
    seats: 8,
    tables: 2,
    services: 1,
    open_hours: "11.00",
    seat_hours: "88.00",
    dine_in_orders: 1,
    dine_in_covers: 4,
    orders_per_table_service_bp: 5000,
    covers_per_seat_service_bp: 5000,
    turnover_reason: null,
    net_sales: 23_148,
    revpash: 263,
    revpash_reason: null,
  },
  prime_cost: {
    date_from: "2026-03-10",
    date_to: "2026-03-10",
    net_sales: 23_148,
    cost_of_goods: 1_000,
    cost_basis: "theoretical",
    cost_theoretical: 1_000,
    cost_real: null,
    cost_real_reason: "No hay dos conteos completos.",
    cost_reason: null,
    labor: null,
    labor_reason: "La sede no lleva la nómina en el sistema.",
    prime_cost: null,
    prime_cost_pct_bp: null,
    cost_pct_bp: 432,
    labor_pct_bp: null,
    reason: "La sede no lleva la nómina en el sistema.",
  },
  labor_by_hour: {
    available: true,
    reason: null,
    labor_total: 80_000,
    worked_hours_total: "8.00",
    hours: [
      { hour: 7, label: "07:00", net: 0, worked_hours: "1.00", labor: 10_000, labor_pct_bp: null, outside: true },
      { hour: 11, label: "11:00", net: 23_148, worked_hours: "2.00", labor: 20_000, labor_pct_bp: 8640, outside: false },
    ],
  },
  controls: {
    rows: [
      {
        employee_id: 4,
        employee_name: "Operator",
        voids_count: 1,
        voids_amount: 25_000,
        discounts_count: 1,
        discounts_amount: 1_250,
        courtesies_count: 1,
        courtesies_amount: 25_000,
        total_count: 3,
        total_amount: 51_250,
        authorizers: [
          { name: "Admin", count: 1, amount: 25_000 },
          { name: "Sin autorización", count: 2, amount: 26_250 },
        ],
      },
    ],
    by_authorizer: [],
    total_count: 3,
    total_amount: 51_250,
    net_sales: 23_148,
    total_pct_of_sales_bp: null,
  },
}

describe("Informes · gestión del período", () => {
  it("pinta el costo primo sin dato con su motivo, la rotación en vueltas y el RevPASH del servidor", () => {
    renderWithProviders(<GestionDelPeriodo data={GESTION} />)
    const costo = screen.getByRole("region", { name: "Costo primo" })
    expect(within(costo).getAllByText(/La sede no lleva la nómina/).length).toBeGreaterThan(0)
    expect(within(costo).getByText("$ 1.000")).toBeInTheDocument()
    expect(within(costo).getByText(/costo teórico de las fichas/)).toBeInTheDocument()
    expect(within(costo).getByText(/Se usa el costo teórico porque el real no está/)).toBeInTheDocument()

    const mesas = screen.getByRole("region", { name: "Mesas y sillas" })
    expect(within(mesas).getByText("0,50 vueltas")).toBeInTheDocument()
    expect(within(mesas).getByText("$ 263")).toBeInTheDocument()
    expect(texto(within(mesas).getByText(/abiertas, 8 sillas/).textContent ?? "")).toContain("11,00 h abiertas")
  })

  it("compara la venta con la mano de obra hora por hora y lista los controles con su autorizador", () => {
    renderWithProviders(<GestionDelPeriodo data={GESTION} />)
    const mano = screen.getByRole("region", { name: "Mano de obra por hora" })
    expect(within(mano).getByText(/\$ 80\.000 en 8,00 h/)).toBeInTheDocument()

    const controles = screen.getByRole("region", { name: "Anulaciones, descuentos y cortesías" })
    const fila = within(controles).getByText("Operator").closest("tr") as HTMLElement
    expect(within(fila).getByText("$ 51.250")).toBeInTheDocument()
    expect(within(fila).getByText("Admin (1), Sin autorización (2)")).toBeInTheDocument()
  })

  it("el aviso de confiabilidad lleva cada cosa a la pantalla que la arregla, lo grave primero", () => {
    renderWithProviders(<BannerConfiabilidad data={DUDOSO} periodo="del período" />)
    expect(screen.getByText(/hay 2 cosas que los tuercen del período/)).toBeInTheDocument()
    const items = screen.getAllByRole("listitem")
    expect(within(items[0]!).getByText(/No hay tabla de recargos/)).toBeInTheDocument()
    expect(within(items[0]!).getByRole("link", { name: /Cargar la tabla de recargos/ })).toHaveAttribute(
      "href",
      "/admin/nomina?tab=recargos",
    )
    expect(within(items[1]!).getByRole("link", { name: /Hacer un conteo completo/ })).toHaveAttribute(
      "href",
      "/admin/inventario?tab=salud",
    )
  })

  it("sin nada pendiente, el aviso lo dice en una línea", () => {
    renderWithProviders(<BannerConfiabilidad data={CONFIABLE} periodo="del mes" />)
    expect(screen.getByText(/Sí: no hay nada pendiente que tuerza los números del mes/)).toBeInTheDocument()
  })
})

const MES: TodayMonthOut = {
  store_id: 1,
  date_from: "2026-03-01",
  date_to: "2026-03-03",
  goal_pace: {
    year: 2026,
    month: 3,
    goal: 310_000,
    goal_source: "month",
    goal_inherited_from: null,
    month_to_date: 5_000,
    closed_days: 2,
    days_elapsed: 3,
    days_in_month: 31,
    expected_to_date: 30_000,
    gap_to_expected: -25_000,
    progress_bp: 161,
    projected_month_end: 77_500,
    projected_vs_goal_bp: 2_500,
    on_track: false,
    reason: null,
    projection_reason: null,
  },
  prime_cost: { ...GESTION.prime_cost, prime_cost: 81_000, prime_cost_pct_bp: 34_993, labor: 80_000, reason: null },
  reliability: DUDOSO,
}

describe("Hoy · el mes hasta hoy", () => {
  it("muestra lo cobrado contra lo esperado a hoy y la proyección del servidor", async () => {
    getTodayMonthMock.mockResolvedValue(MES)
    renderWithProviders(<MesEnCurso storeId={1} />, { me: buildMe() })
    const burbuja = await screen.findByRole("region", { name: "El mes hasta hoy" })
    expect(within(burbuja).getByText("$ 5.000")).toBeInTheDocument()
    expect(within(burbuja).getByText("$ 30.000")).toBeInTheDocument()
    expect(within(burbuja).getByText(/faltan \$ 25\.000 para ir al día/)).toBeInTheDocument()
    expect(within(burbuja).getByText("$ 77.500")).toBeInTheDocument()
    expect(within(burbuja).getByText("Debajo del ritmo")).toBeInTheDocument()
    expect(texto(within(burbuja).getByText(/de la meta, al ritmo/).textContent ?? "")).toContain("25 %")
    expect(within(burbuja).getByText(/costo teórico/)).toBeInTheDocument()
  })

  it("sin meta dice dónde ponerla, y lo cobrado igual se ve", async () => {
    getTodayMonthMock.mockResolvedValue({
      ...MES,
      goal_pace: {
        ...MES.goal_pace,
        goal: null,
        goal_source: null,
        expected_to_date: null,
        gap_to_expected: null,
        progress_bp: null,
        projected_vs_goal_bp: null,
        on_track: null,
        reason: "Este mes no tiene meta de ventas: ponela en Informe del contador.",
      },
    })
    renderWithProviders(<MesEnCurso storeId={1} />, { me: buildMe() })
    expect(await screen.findByText(/ponela en Informe del contador/)).toBeInTheDocument()
    expect(screen.getByText("$ 5.000")).toBeInTheDocument()
  })
})

const PNL: PnlOut = {
  store_id: 1,
  months: [
    {
      year: 2026,
      month: 2,
      label: "feb 2026",
      date_from: "2026-02-01",
      date_to: "2026-02-28",
      in_progress: false,
      available: true,
      reason: null,
      cost_basis: "theoretical",
      cost_real: null,
      cost_real_reason: "Sin conteos.",
      profit_with_real_cost: null,
    },
    {
      year: 2026,
      month: 3,
      label: "mar 2026",
      date_from: "2026-03-01",
      date_to: "2026-03-20",
      in_progress: true,
      available: true,
      reason: null,
      cost_basis: "theoretical",
      cost_real: null,
      cost_real_reason: "Sin conteos.",
      profit_with_real_cost: null,
    },
  ],
  rows: [
    {
      key: "obligations",
      label: "Obligaciones",
      budgetable: true,
      cells: [
        { amount: 0, budget: null, variance: null, variance_bp: null, outside: null },
        { amount: 2_000_000, budget: 1_500_000, variance: 500_000, variance_bp: 3333, outside: true },
      ],
      total: { amount: 2_000_000, budget: null, variance: null, variance_bp: null, outside: null },
    },
    {
      key: "profit",
      label: "Utilidad",
      budgetable: false,
      cells: [
        { amount: 0, budget: null, variance: null, variance_bp: null, outside: null },
        { amount: -2_000_000, budget: null, variance: null, variance_bp: null, outside: null },
      ],
      total: { amount: -2_000_000, budget: null, variance: null, variance_bp: null, outside: null },
    },
  ],
}

describe("Informes · estado de resultados", () => {
  it("pinta cada mes con su presupuesto y la desviación que manda el servidor", async () => {
    getMonthlyPnlMock.mockResolvedValue(PNL)
    renderWithProviders(<EstadoResultados storeId={1} year={2026} month={3} />, { me: buildMe() })
    const tabla = await screen.findByRole("table")
    const fila = within(tabla).getByRole("row", { name: /Obligaciones/ })
    expect(within(fila).getByText(/pres\. \$ 1\.500\.000/)).toHaveTextContent("▼")
    expect(within(tabla).getByText("en curso")).toBeInTheDocument()
    expect(screen.getByText(/todavía no hay costo real para comparar/)).toBeInTheDocument()
  })

  it("guarda un presupuesto y vuelve a pedir el estado de resultados", async () => {
    getMonthlyPnlMock.mockResolvedValue(PNL)
    putPnlBudgetMock.mockResolvedValue({ store_id: 1, year: 2026, month: 3, line: "net_sales", amount: 1_000_000 })
    renderWithProviders(<EstadoResultados storeId={1} year={2026} month={3} />, { me: buildMe() })
    await screen.findByRole("table")
    await userEvent.click(screen.getByRole("button", { name: "Presupuesto" }))
    const monto = screen.getByLabelText("Presupuesto")
    await userEvent.type(monto, "1000000")
    await userEvent.tab()
    await userEvent.click(screen.getByRole("button", { name: "Guardar presupuesto" }))
    await waitFor(() =>
      expect(putPnlBudgetMock).toHaveBeenCalledWith(1, { year: 2026, month: 3, line: "net_sales", amount: 1_000_000 }),
    )
    await waitFor(() => expect(getMonthlyPnlMock).toHaveBeenCalledTimes(2))
  })
})
