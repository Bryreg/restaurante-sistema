import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { PayrollRunSummaryOut } from "@/api/payroll"
import { renderWithProviders } from "@/test/utils"

import { RunsTab } from "../RunsTab"

const { getPayrollRunsMock } = vi.hoisted(() => ({ getPayrollRunsMock: vi.fn() }))

vi.mock("@/api/payroll", async () => {
  const actual = await vi.importActual<typeof import("@/api/payroll")>("@/api/payroll")
  return { ...actual, getPayrollRuns: getPayrollRunsMock }
})

const RUN: PayrollRunSummaryOut = {
  id: 2,
  store_id: 1,
  date_from: "2026-09-08",
  date_to: "2026-09-21",
  total_amount: 9_652_224,
  available: true,
  reason: null,
  computed_at: "2026-09-22T14:00:00Z",
  net_sales: 28_240_062,
  payroll_pct_of_sales_bp: 3418,
  payroll_pct_reason: null,
  previous_run_id: 1,
  previous_date_from: "2026-08-25",
  previous_date_to: "2026-09-07",
  previous_total: 9_100_000,
  delta_bp: 607,
  previous_reason: null,
}

describe("RunsTab — la liquidación en contexto (informe #14)", () => {
  it("cada liquidación dice qué parte de la venta se lleva y cómo quedó contra la anterior", async () => {
    getPayrollRunsMock.mockResolvedValue([RUN])
    renderWithProviders(<RunsTab storeId={1} />)

    expect(await screen.findByTestId("payroll-pct")).toHaveTextContent(/34,2\s% de \$ 28\.240\.062 vendidos/)
    expect(screen.getByTestId("payroll-delta")).toHaveTextContent(/▲ 6,1\s% · antes \$ 9\.100\.000 \(25 ago al 7 sep\)/)
    expect(screen.getByTestId("runs-headline")).toHaveTextContent(
      /La nómina del 8 al 21 sep se lleva el 34,2\s% de la venta y subió 6,1\s% contra la anterior/,
    )
  })

  it("sin liquidación anterior ni venta, cada cifra dice su motivo en vez de un 0", async () => {
    getPayrollRunsMock.mockResolvedValue([
      {
        ...RUN,
        payroll_pct_of_sales_bp: null,
        payroll_pct_reason: "No hubo ventas en el período.",
        delta_bp: null,
        previous_total: null,
        previous_reason: "No hay una liquidación anterior a este período.",
      },
    ])
    renderWithProviders(<RunsTab storeId={1} />)

    expect(await screen.findByText("No hubo ventas en el período.")).toBeInTheDocument()
    expect(screen.getByText("No hay una liquidación anterior a este período.")).toBeInTheDocument()
    expect(screen.queryByTestId("runs-headline")).not.toBeInTheDocument()
    expect(screen.queryByText(/0,0\s%/)).not.toBeInTheDocument()
  })
})
