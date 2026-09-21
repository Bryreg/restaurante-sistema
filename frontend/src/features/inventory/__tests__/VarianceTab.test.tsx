import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { CountOut, VarianceRowOut } from "@/api/inventory"
import { renderWithProviders } from "@/test/utils"

import { VarianceTab } from "../VarianceTab"

const { listCountsMock, getVarianceMock } = vi.hoisted(() => ({
  listCountsMock: vi.fn(),
  getVarianceMock: vi.fn(),
}))

vi.mock("@/api/inventory", async () => {
  const actual = await vi.importActual<typeof import("@/api/inventory")>("@/api/inventory")
  return { ...actual, listCounts: listCountsMock, getVariance: getVarianceMock }
})

const APPLIED: CountOut = {
  id: 20,
  scope: "full",
  status: "applied",
  opened_at: "2026-09-14T09:00:00Z",
  business_date: "2026-09-14",
  opened_by_employee_id: 1,
  opened_by_employee_name: "Ana",
  applied_at: "2026-09-14T10:00:00Z",
  applied_by_employee_id: 1,
  applied_by_employee_name: "Ana",
  lines_total: 5,
  lines_counted: 5,
}

const OPEN: CountOut = { ...APPLIED, id: 21, status: "open", applied_at: null, applied_by_employee_id: null, applied_by_employee_name: null }

function row(overrides: Partial<VarianceRowOut>): VarianceRowOut {
  return {
    ingredient_id: 1,
    ingredient_name: "Pechuga de pollo",
    base_unit: "g",
    opening_qty: "12500",
    inflow_qty: "0",
    closing_qty: "10000",
    real_usage_qty: "2500",
    theoretical_usage_qty: "2000",
    variance_qty: "500",
    variance_value: 7500,
    cost_source: "weighted_average",
    variance_pct_bp: 2500,
    level: "red",
    ...overrides,
  }
}

describe("VarianceTab — el semáforo lo calcula el servidor, nunca un umbral del cliente (SPEC-NEGOCIO §5.4)", () => {
  it("sólo ofrece conteos APLICADOS en el selector, nunca uno abierto", async () => {
    listCountsMock.mockResolvedValue([APPLIED, OPEN])
    const user = userEvent.setup()
    renderWithProviders(<VarianceTab storeId={1} />)

    await waitFor(() => expect(listCountsMock).toHaveBeenCalled())
    await user.click(screen.getByRole("combobox", { name: "Conteo aplicado" }))

    // El popup vive en un portal: con casi cien entornos jsdom compitiendo
    // por CPU no está montado cuando un `getAllByRole` síncrono pregunta.
    // Se espera una opción concreta primero.
    await screen.findByRole("option", { name: /#20/ })
    const options = screen.getAllByRole("option").map((o) => o.textContent)
    expect(options.some((t) => t?.includes("#20"))).toBe(true)
    expect(options.some((t) => t?.includes("#21"))).toBe(false)
  })

  it("dos filas con el MISMO variance_pct_bp pero distinto `level` (servidor) pintan colores distintos — la pantalla nunca recalcula el semáforo", async () => {
    listCountsMock.mockResolvedValue([APPLIED])
    getVarianceMock.mockResolvedValue({
      count_id: 20,
      opening_count_id: 19,
      window_from: "2026-09-07T09:00:00Z",
      window_to: "2026-09-14T09:00:00Z",
      available: true,
      reason: null,
      rows: [
        row({ ingredient_id: 1, ingredient_name: "Pechuga de pollo", variance_pct_bp: 250, level: "green" }),
        row({ ingredient_id: 2, ingredient_name: "Papa criolla", variance_pct_bp: 250, level: "red" }),
      ],
      yellow_threshold_bp: 200,
      red_threshold_bp: 400,
    })

    const user = userEvent.setup()
    renderWithProviders(<VarianceTab storeId={1} />)

    await waitFor(() => expect(listCountsMock).toHaveBeenCalled())
    await user.click(screen.getByRole("combobox", { name: "Conteo aplicado" }))
    await user.click(await screen.findByRole("option", { name: /#20/ }))

    await waitFor(() => expect(screen.getByText("Pechuga de pollo")).toBeInTheDocument())

    const rows = screen.getAllByRole("row")
    const polloRow = within(rows.find((r) => r.textContent?.includes("Pechuga de pollo"))!)
    const papaRow = within(rows.find((r) => r.textContent?.includes("Papa criolla"))!)

    expect(polloRow.getByText("Verde")).toBeInTheDocument()
    expect(papaRow.getByText("Rojo")).toBeInTheDocument()
    // Los dos muestran el mismo 2,5 % — sólo el color (level) cambia, y viene del servidor.
    expect(polloRow.getByText("2,5 %")).toBeInTheDocument()
    expect(papaRow.getByText("2,5 %")).toBeInTheDocument()
  })

  it("sin conteo anterior aplicado contra el cual comparar: `available=false` explica el motivo, nunca una tabla vacía muda", async () => {
    listCountsMock.mockResolvedValue([APPLIED])
    getVarianceMock.mockResolvedValue({
      count_id: 20,
      opening_count_id: null,
      window_from: null,
      window_to: "2026-09-14T09:00:00Z",
      available: false,
      reason: "No hay un conteo anterior aplicado contra el cual comparar",
      rows: [],
      yellow_threshold_bp: 200,
      red_threshold_bp: 400,
    })

    const user = userEvent.setup()
    renderWithProviders(<VarianceTab storeId={1} />)
    await waitFor(() => expect(listCountsMock).toHaveBeenCalled())
    await user.click(screen.getByRole("combobox", { name: "Conteo aplicado" }))
    await user.click(await screen.findByRole("option", { name: /#20/ }))

    await waitFor(() => expect(screen.getByText(/No hay un conteo anterior aplicado/)).toBeInTheDocument())
  })

  it("un insumo sin costo dice «Sin costo», nunca $0", async () => {
    listCountsMock.mockResolvedValue([APPLIED])
    getVarianceMock.mockResolvedValue({
      count_id: 20,
      opening_count_id: 19,
      window_from: "2026-09-07T09:00:00Z",
      window_to: "2026-09-14T09:00:00Z",
      available: true,
      reason: null,
      rows: [row({ variance_value: null, cost_source: "none" })],
      yellow_threshold_bp: 200,
      red_threshold_bp: 400,
    })

    const user = userEvent.setup()
    renderWithProviders(<VarianceTab storeId={1} />)
    await waitFor(() => expect(listCountsMock).toHaveBeenCalled())
    await user.click(screen.getByRole("combobox", { name: "Conteo aplicado" }))
    await user.click(await screen.findByRole("option", { name: /#20/ }))

    await waitFor(() => expect(within(screen.getByRole("table")).getByText("Sin costo")).toBeInTheDocument())
    // La leyenda del pie dice, con esas palabras, «no es $ 0»: la afirmación
    // es que la CELDA no lo diga.
    expect(within(screen.getByRole("table")).queryByText("$ 0")).not.toBeInTheDocument()
  })
})
