import { screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { ProfitOut, ProfitPeriodOut } from "@/api/expenses"
import { renderWithProviders } from "@/test/utils"

import { ProfitTab } from "../ProfitTab"
import { profitHeadline } from "../titulares"

const { getProfitMock } = vi.hoisted(() => ({ getProfitMock: vi.fn() }))

vi.mock("@/api/expenses", async () => {
  const actual = await vi.importActual<typeof import("@/api/expenses")>("@/api/expenses")
  return { ...actual, getProfit: getProfitMock }
})

const ANTERIOR: ProfitPeriodOut = {
  date_from: "2026-07-24",
  date_to: "2026-08-23",
  net_sales: 25_000_000,
  cost: 8_000_000,
  expenses: 1_000_000,
  obligations: 8_100_000,
  payroll: 9_000_000,
  profit: -1_100_000,
  lines: [
    { key: "net_sales", label: "Ventas netas", amount: 25_000_000, pct_of_sales_bp: 10_000 },
    { key: "cost", label: "Costo de lo vendido", amount: 8_000_000, pct_of_sales_bp: 3200 },
    { key: "payroll", label: "Nómina", amount: 9_000_000, pct_of_sales_bp: 3600 },
    { key: "obligations", label: "Obligaciones", amount: 8_100_000, pct_of_sales_bp: 3240 },
    { key: "expenses", label: "Gastos", amount: 1_000_000, pct_of_sales_bp: 400 },
    { key: "profit", label: "Utilidad", amount: -1_100_000, pct_of_sales_bp: -440 },
  ],
  available: true,
  reason: null,
}

/** La respuesta real de la simulación: pérdida de $973.428, nómina 36,07 % de la venta. */
const PERDIDA: ProfitOut = {
  store_id: 1,
  date_from: "2026-08-24",
  date_to: "2026-09-23",
  net_sales: 28_240_062,
  cost: 9_568_479,
  expenses: 1_360_000,
  obligations: 8_100_000,
  payroll: 10_185_011,
  fixed_costs: 19_645_011,
  costed_pct: 99,
  costed_pct_min: 95,
  profit: -973_428,
  lines: [
    { key: "net_sales", label: "Ventas netas", amount: 28_240_062, pct_of_sales_bp: 10_000 },
    { key: "cost", label: "Costo de lo vendido", amount: 9_568_479, pct_of_sales_bp: 3388 },
    { key: "payroll", label: "Nómina", amount: 10_185_011, pct_of_sales_bp: 3607 },
    { key: "obligations", label: "Obligaciones", amount: 8_100_000, pct_of_sales_bp: 2868 },
    { key: "expenses", label: "Gastos", amount: 1_360_000, pct_of_sales_bp: 482 },
    { key: "profit", label: "Utilidad", amount: -973_428, pct_of_sales_bp: -345 },
  ],
  previous_period: ANTERIOR,
  available: true,
  reason: null,
}

describe("ProfitTab — la utilidad concluye y se compara (informe #2)", () => {
  it("el titular nombra la pérdida y el costo que más pesa, en tono crítico", async () => {
    getProfitMock.mockResolvedValue(PERDIDA)
    renderWithProviders(<ProfitTab storeId={1} />)

    const titular = await screen.findByTestId("profit-headline")
    expect(titular).toHaveTextContent(/Perdiste \$ 973\.428: la nómina se come el 36,1\s% de la venta/)
    expect(titular).toHaveAttribute("data-tono", "critico")
    expect(titular.className).toContain("text-destructive")
  })

  it("cada renglón lleva su % de la venta y el período anterior al lado, tal como llegan", async () => {
    getProfitMock.mockResolvedValue(PERDIDA)
    renderWithProviders(<ProfitTab storeId={1} />)

    await screen.findByTestId("profit-headline")
    const tabla = screen.getByRole("table", { name: /estado de resultados/i })
    const nomina = within(tabla).getByText("Nómina").closest("tr")!
    expect(nomina).toHaveTextContent("$ 10.185.011")
    expect(nomina).toHaveTextContent(/36,1\s%/)
    expect(nomina).toHaveTextContent("$ 9.000.000")
    expect(nomina).toHaveTextContent(/36,0\s%/)

    const utilidad = within(tabla).getByText("Utilidad").closest("tr")!
    expect(utilidad).toHaveTextContent("-$ 973.428")
    expect(utilidad).toHaveTextContent(/-3,5\s%/)
    expect(utilidad).toHaveTextContent("-$ 1.100.000")
    // La cabecera nombra el período anterior en fechas cortas.
    expect(within(tabla).getByText(/Anterior \(24 jul al 23 ago\)/)).toBeInTheDocument()
  })

  it("sin datos del servidor dice el motivo, no pinta $0", async () => {
    getProfitMock.mockResolvedValue({
      ...PERDIDA,
      profit: null,
      available: false,
      reason: "Hay ventas del período sin costo teórico calculado.",
    } satisfies ProfitOut)
    renderWithProviders(<ProfitTab storeId={1} />)

    expect(await screen.findByText("Utilidad no disponible")).toBeInTheDocument()
    expect(screen.getByText("Hay ventas del período sin costo teórico calculado.")).toBeInTheDocument()
  })
})

describe("profitHeadline — con números concretos", () => {
  it("una ganancia dice cuánto de la venta queda", () => {
    expect(
      profitHeadline({
        ...PERDIDA,
        profit: 2_000_000,
        lines: PERDIDA.lines!.map((l) => (l.key === "profit" ? { ...l, amount: 2_000_000, pct_of_sales_bp: 708 } : l)),
      }),
    ).toMatch(/^Ganaste \$ 2\.000\.000: te queda el 7,1\s% de la venta$/)
  })

  it("con el costo de lo vendido como el mayor, lo nombra a él", () => {
    expect(
      profitHeadline({
        ...PERDIDA,
        lines: PERDIDA.lines!.map((l) => (l.key === "cost" ? { ...l, pct_of_sales_bp: 4100 } : l)),
      }),
    ).toMatch(/^Perdiste \$ 973\.428: el costo de lo vendido se come el 41,0\s% de la venta$/)
  })
})
