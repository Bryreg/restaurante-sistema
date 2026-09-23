import { screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { BreakEvenOut } from "@/api/expenses"
import { renderWithProviders } from "@/test/utils"

import { BreakEvenTab } from "../BreakEvenTab"
import { breakEvenHeadline } from "../titulares"

const { getBreakEvenMock } = vi.hoisted(() => ({ getBreakEvenMock: vi.fn() }))

vi.mock("@/api/expenses", async () => {
  const actual = await vi.importActual<typeof import("@/api/expenses")>("@/api/expenses")
  return { ...actual, getBreakEven: getBreakEvenMock }
})

/** La respuesta real de la simulación (24 ago al 23 sep): el período termina hoy y faltan $1.472.273. */
const DISPONIBLE: BreakEvenOut = {
  store_id: 1,
  date_from: "2026-08-24",
  date_to: "2026-09-23",
  fixed_costs: 19_645_011,
  fixed_costs_source: "automatic",
  fixed_costs_breakdown: [
    { label: "Arriendo", amount: 6_500_000, source: "obligations" },
    { label: "Servicios públicos", amount: 1_600_000, source: "obligations" },
    { label: "Nómina", amount: 10_185_011, source: "payroll" },
    { label: "Gastos de mantenimiento", amount: 280_000, source: "expenses" },
  ],
  net_sales: 28_240_062,
  costed_pct: 99,
  costed_pct_min: 95,
  contribution_margin_pct_bp: 6612,
  break_even_amount: 29_712_335,
  progress_bp: 9504,
  gap_amount: 1_472_273,
  days_to_break_even_at_current_pace: 2,
  days_elapsed: 31,
  days_in_period: 31,
  available: true,
  reason: null,
}

describe("BreakEvenTab — sin costos fijos, null con motivo, nunca $0 (checklist de la fase)", () => {
  it("sin costos fijos registrados muestra el motivo, no una cifra en cero", async () => {
    const unavailable: BreakEvenOut = {
      fixed_costs: null,
      contribution_margin_pct_bp: null,
      break_even_amount: null,
      available: false,
      reason: "Cargá los costos fijos del período en Gastos para poder calcularlo.",
    }
    getBreakEvenMock.mockResolvedValue(unavailable)
    renderWithProviders(<BreakEvenTab storeId={1} />)

    expect(await screen.findByText("Punto de equilibrio no disponible")).toBeInTheDocument()
    expect(screen.getByText("Cargá los costos fijos del período en Gastos para poder calcularlo.")).toBeInTheDocument()
    expect(screen.queryByText(/\$\s*0\b/)).not.toBeInTheDocument()
  })

  it("con datos, las tres cifras llegan tal como las manda el servidor", async () => {
    getBreakEvenMock.mockResolvedValue(DISPONIBLE)
    renderWithProviders(<BreakEvenTab storeId={1} />)

    await waitFor(() => expect(screen.getByText("$ 19.645.011")).toBeInTheDocument())
    expect(screen.getByText(/^66,1\s%$/)).toBeInTheDocument()
    // El equilibrio aparece en el medidor y en su tarjeta.
    expect(screen.getAllByText("$ 29.712.335").length).toBeGreaterThanOrEqual(2)
  })
})

describe("BreakEvenTab — el medidor y el titular que concluye (informe #2)", () => {
  it("dice cuánto falta y no promete «lo pasás en 2 días» cuando el período termina hoy", async () => {
    getBreakEvenMock.mockResolvedValue(DISPONIBLE)
    renderWithProviders(<BreakEvenTab storeId={1} />)

    expect(await screen.findByTestId("break-even-headline")).toHaveTextContent(
      "Te faltan $ 1.472.273 para el punto de equilibrio; a este ritmo harían falta 2 días más y el período termina hoy",
    )
    // «Llevás $X de $Y (Z %)» con el avance que manda el backend (9504 bp).
    const medidor = screen.getByRole("img", { name: /^Llevás \$ 28\.240\.062 de \$ 29\.712\.335 \(95,0\s%\)\.$/ })
    expect(medidor).toBeInTheDocument()
  })

  it("los costos fijos no se escriben a mano: sale el desglose con su origen y dónde se cargan", async () => {
    getBreakEvenMock.mockResolvedValue(DISPONIBLE)
    renderWithProviders(<BreakEvenTab storeId={1} />)

    await screen.findByTestId("break-even-headline")
    expect(screen.queryByRole("button", { name: /guardar costos fijos/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    expect(screen.getByText(/lo que más pesa es nómina \(\$ 10\.185\.011\)/)).toBeInTheDocument()
    expect(screen.getByText("Arriendo")).toBeInTheDocument()

    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"))
    expect(hrefs).toContain("/admin/gastos?tab=obligaciones")
    expect(hrefs).toContain("/admin/gastos?tab=gastos")
    expect(hrefs).toContain("/admin/nomina?tab=liquidaciones")
  })

  it("con poca venta costeada avisa la cobertura y no dibuja el medidor", async () => {
    getBreakEvenMock.mockResolvedValue({
      ...DISPONIBLE,
      costed_pct: 80,
      contribution_margin_pct_bp: null,
      break_even_amount: null,
      progress_bp: null,
      gap_amount: null,
      days_to_break_even_at_current_pace: null,
      available: false,
      reason: "Sólo el 80 % de la venta neta del período tiene costo teórico.",
    } satisfies BreakEvenOut)
    renderWithProviders(<BreakEvenTab storeId={1} />)

    expect(await screen.findByText(/de la venta tiene ficha técnica con costo/)).toHaveTextContent(/Sólo el 80\s%/)
    expect(screen.getByText("Punto de equilibrio no disponible")).toBeInTheDocument()
    expect(screen.queryByRole("img", { name: /^Llevás/ })).not.toBeInTheDocument()
  })
})

describe("breakEvenHeadline — cada caso con números concretos", () => {
  it("pasado el equilibrio lo dice", () => {
    expect(breakEvenHeadline({ ...DISPONIBLE, gap_amount: 0, progress_bp: 10_450, days_to_break_even_at_current_pace: 0 })).toBe(
      "Ya pasaste el punto de equilibrio: el período ya cubre sus $ 19.645.011 de costos fijos",
    )
  })

  it("con días de sobra, a este ritmo lo pasás en N días", () => {
    expect(breakEvenHeadline({ ...DISPONIBLE, days_elapsed: 20, days_to_break_even_at_current_pace: 3 })).toBe(
      "Te faltan $ 1.472.273 para el punto de equilibrio; a este ritmo lo pasás en 3 días",
    )
  })

  it("sin días suficientes lo dice con los dos números", () => {
    expect(breakEvenHeadline({ ...DISPONIBLE, days_elapsed: 29, days_to_break_even_at_current_pace: 5 })).toBe(
      "Te faltan $ 1.472.273 para el punto de equilibrio; a este ritmo harían falta 5 días y al período le quedan 2 días",
    )
  })

  it("un período ya cerrado (sin ritmo) cerró por debajo", () => {
    expect(breakEvenHeadline({ ...DISPONIBLE, days_elapsed: null, days_to_break_even_at_current_pace: null })).toBe(
      "Te faltan $ 1.472.273 para el punto de equilibrio: el período cerró por debajo, en pérdida",
    )
  })
})
